/**
 * Vercel Serverless Function: POST /api/generate-teacher-minutes
 *
 * 지역아동센터 교사회의록 생성 (희망이음 시스템 입력용).
 * Structure reused from brainsports/meeting — api/generate-minutes.ts
 * (Gemini server-side call, API key never exposed to the client).
 *
 * Returns strict JSON with the 5 required sections:
 *   report / agenda / discussion / nextWeek / supervision
 * The model must NOT invent facts, attendees, dates, or decisions.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GoogleGenAI } from "@google/genai";
import { getUserUsage, incrementUserUsage, resolveUserId } from "./_usage.js";

// Server-side only — never exposed to the client
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

export const config = {
  api: {
    // Allow JSON payloads up to 50MB for base64 file uploads
    bodyParser: { sizeLimit: "50mb" },
  },
  maxDuration: 60,
};

interface SectionResult {
  report: string;
  agenda: string;
  discussion: string;
  nextWeek: string;
  supervision: string;
}

function extractJsonBlock(raw: string): Partial<SectionResult> | null {
  // Prefer a fenced ```json block, then the outermost {...} object.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

// The model sometimes wraps strings in arrays; normalize everything to text.
function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${asText(v)}`)
      .join("\n");
  }
  return "";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
  }

  try {
    const { file, meetingData } = req.body || {};

    // 1일 3회 제한 — 서버에서 검증 (KST 기준, IP 기반 사용자 식별)
    const userId = resolveUserId(req);
    const usage = getUserUsage(userId);
    if (usage.remaining <= 0) {
      return res.status(403).json({
        error: "USAGE_LIMIT_EXCEEDED",
        message: "오늘 사용 가능한 AI 회의록 3회를 모두 사용했습니다. 내일 다시 이용할 수 있습니다.",
        usageInfo: usage,
      });
    }

    // Validate attached file (PDF / TXT / plain text converted from DOCX)
    if (file) {
      const allowedMimeTypes = ["application/pdf", "text/plain"];
      if (file.mimeType && !allowedMimeTypes.includes(file.mimeType.toLowerCase())) {
        return res.status(400).json({ error: "INVALID_FILE_TYPE" });
      }
      if (file.base64Data && file.base64Data.length > 35 * 1024 * 1024) {
        return res.status(400).json({ error: "FILE_TOO_LARGE" });
      }
    }

    if (!GEMINI_API_KEY) {
      console.error("[ERROR] Server configuration error: GEMINI_API_KEY is not set.");
      return res.status(500).json({ error: "SERVER_CONFIGURATION_ERROR" });
    }

    const hasMemo = Boolean(meetingData && (meetingData.memo || "").trim());
    if (!file && !hasMemo) {
      return res.status(400).json({ error: "NO_INPUT", message: "회의 메모를 입력하거나 자료를 업로드해 주세요." });
    }

    // Call Gemini API server-side (timeout prevents indefinite hangs; maxDuration is 60s)
    const ai = new GoogleGenAI({
      apiKey: GEMINI_API_KEY,
      httpOptions: {
        headers: { "User-Agent": "aistudio-build" },
        timeout: 55_000,
      },
    });

    const modelName = "gemini-3.6-flash";
    const promptText = `
      당신은 지역아동센터(방과후아동돌봄시설)의 '교사회의록' 작성 전문가입니다.
      아래 회의 정보${file ? "와 업로드된 회의 자료" : ""}를 분석하여, 희망이음 시스템에 옮겨 입력하기 좋은 교사회의록을 작성해 주세요.
      이 회의는 센터장과 교사들이 참석하는 정기 교사회의로, 아동 돌봄 · 프로그램 · 안전 · 행정 등을 논의하는 자리입니다.

      [회의 정보]
      - 회의명: ${meetingData?.title || "미입력"}
      - 일시: ${meetingData?.date || "미입력"}
      - 장소: ${meetingData?.location || "미입력"}
      - 참석자: ${meetingData?.attendees || "미입력"}
      - 회의 메모 / 안건: ${meetingData?.memo || "미입력"}

      [작성할 5개 항목]
      1. report (보고 및 전달사항): 공지사항, 행정업무, 일정, 아동 관련 전달사항, 교육, 안전 관련 내용을 정리.
      2. agenda (안건): 실제 논의할 주제를 번호별(1. 2. 3.)로 간단하게 정리.
      3. discussion (회의내용): 안건별로 실제 논의내용을 작성. 가능한 경우 논의내용, 결정사항, 담당자, 실행 일정을 포함하되, 입력자료에 없는 담당자나 일정은 절대 만들지 말 것.
      4. nextWeek (기타/차주계획): 다음 주 프로그램, 행사, 교육, 준비사항과 일정을 정리.
      5. supervision (슈퍼비전): 센터장 또는 관리자의 지도, 조언, 업무 방향을 정리. 관련 내용이 입력되지 않았다면 빈 문자열 ""로 남길 것.

      [작성 원칙 — 반드시 지킬 것]
      1. 사용자가 입력한 내용과 업로드 자료에 있는 사실만 사용하여 정리 · 분류 · 문장화합니다. 없는 사실이나 하지 않은 발언을 절대 임의로 만들지 마세요.
      2. 초등학교 6학년도 이해할 수 있는 쉬운 문장을 사용하고, 어려운 행정용어와 한자식 표현은 최소화해 주세요.
      3. AI가 작성한 것 같은 과장된 표현을 금지합니다. 실제 지역아동센터 교사회의록처럼 자연스럽고 담백하게 작성해 주세요.
      4. 같은 내용을 여러 항목에 반복하지 마세요. 안건과 회의내용을 분명히 구분해 주세요.
      5. 입력하지 않은 참석자의 발언, 날짜, 담당자, 결정사항, 개인정보를 절대 임의 생성하지 마세요.
      6. 결정사항은 쉽게 확인할 수 있게 작성해 주세요.
      7. 짧은 메모(예: "가을 야유회 장소 결정, 김민수 학교 적응 관련 논의, 다음 주 소방교육 준비")가 입력되면 알맞은 항목으로 자동 분류하여 작성해 주세요.
      8. 해당 항목에 넣을 내용이 전혀 없다면 빈 문자열 ""를 반환하세요. 특히 supervision(슈퍼비전) 관련 내용이 없으면 반드시 ""를 반환하세요.
      9. 출력 문서는 공식 회의록으로 사용할 수 있을 정도로 단정하게 작성해 주세요.

      [출력 형식]
      반드시 아래 JSON 형식만 반환하세요. JSON 외 다른 설명문은 절대 포함하지 마세요. 모든 값은 한국어 문자열입니다.
      {
        "report": "...",
        "agenda": "...",
        "discussion": "...",
        "nextWeek": "...",
        "supervision": "..."
      }
    `;

    const contentsParts: any[] = [{ text: promptText }];

    if (file && file.base64Data) {
      contentsParts.push({
        inlineData: {
          mimeType: file.mimeType || "application/pdf",
          data: file.base64Data,
        },
      });
    }

    const response = await ai.models.generateContent({
      model: modelName,
      contents: { parts: contentsParts },
    });

    const rawText = response.text || "";
    const parsed = extractJsonBlock(rawText);

    if (!parsed) {
      console.error("[ERROR] Failed to parse Gemini JSON response.");
      return res.status(502).json({ error: "PARSE_FAILED", message: "회의록 생성 결과를 해석하지 못했습니다. 다시 생성해 주세요." });
    }

    const sections: SectionResult = {
      report: asText(parsed.report),
      agenda: asText(parsed.agenda),
      discussion: asText(parsed.discussion),
      nextWeek: asText(parsed.nextWeek),
      supervision: asText(parsed.supervision),
    };

    // 성공한 생성에만 사용 횟수 차감 (실패·파싱 오류는 제외)
    const newUsage = incrementUserUsage(userId);

    return res.json({ sections, usageInfo: newUsage });
  } catch (error: any) {
    console.error("[ERROR] Generate Teacher Minutes Server Error:", error?.message || error);
    // Return sanitized error without exposing API key or stack trace
    return res.status(500).json({ error: "GENERATION_FAILED", message: "회의록 생성 처리 중 서버 오류가 발생했습니다." });
  }
}
