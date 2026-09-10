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
      3. discussion (회의내용): 아래 [회의내용 작성지침]에 따라 안건별로 작성.
      4. nextWeek (기타/차주계획): 다음 주 프로그램, 행사, 교육, 준비사항과 일정을 정리.
      5. supervision (슈퍼비전): 센터장 또는 관리자의 지도, 조언, 업무 방향을 정리. 관련 내용이 입력되지 않았다면 빈 문자열 ""로 남길 것.

      [회의내용(discussion) 작성지침 — 반드시 이 순서와 형식으로 작성]
      각 안건마다 다음 순서로 작성합니다:
      (1) 안건 제시
      (2) 참석자별 의견
      (3) 주요 논의내용
      (4) 결정사항
      (5) 준비할 사항
      (6) 최종 결론

      참석자별 의견 작성법:
      - 실제 입력된 참석자 이름을 사용하고, 참석자 수만큼 빠짐없이 작성합니다.
      - 1명당 약 300자 내외로 작성합니다.
      - 각 의견에는 이유, 걱정되는 점, 준비할 점, 찬성 이유 등이 자연스럽게 포함합니다.
      - 참석자마다 표현과 관점을 조금씩 다르게 하여 서로 똑같지 않게 합니다.
      - 형식은 "이름:\\n의견 내용" (예: 김센터장:\\n가을야유회를 진행하는 것은 아동들에게 좋은 추억이 될 수 있어 찬성합니다. ...)
      - 단, 원문에 참석자의 실제 발언이나 입장이 있다면 그 내용을 가장 우선하고, 없는 부분만 안건 주제에 맞는 일반적인 교사의견으로 자연스럽게 작성합니다. 원문에 없는 새로운 사실(날짜, 장소, 예산, 특정 아동 정보)은 만들지 않습니다.

      최종 결론 작성법:
      - 참석자들이 대체로 찬성한 분위기면 최종 결론도 찬성으로 정리합니다.
      - 찬성 이유와 함께 준비할 사항을 적습니다.
      - 반대 의견이 있으면 해결 가능한 문제는 보완사항으로 정리합니다.
      - 원문에 실제 합의 내용이 있으면 그 내용을 가장 우선합니다.

      [문체 지침 — 모든 항목 공통]
      - 모든 문장은 존칭형(~습니다, ~했습니다, ~하기로 했습니다, ~필요합니다, ~좋겠습니다, ~생각합니다)으로 작성합니다.
      - "~함", "~됨", "~하였음", "~필요함", "~판단됨" 같은 보고서식 표현은 사용하지 않습니다.
      - 초등학교 6학년이 읽어도 이해할 수 있는 쉬운 말로, 짧고 자연스러운 문장으로 작성합니다.
      - 실제 교사들이 회의에서 말할 법한 표현을 사용합니다.
      - 다음 AI 느낌 나는 표현은 금지합니다: "종합적으로 살펴보면", "다각적인 관점에서", "긍정적인 시너지를 기대할 수 있습니다", "체계적이고 효율적인 운영이 필요합니다", "향후 지속적인 발전이 기대됩니다", "전반적으로 긍정적인 효과가 예상됩니다"
      - 대신 "아이들이 좋아할 것 같아서 진행하는 것이 좋겠습니다.", "안전문제만 잘 준비하면 큰 어려움은 없을 것 같습니다." 같은 자연스러운 말로 작성합니다.

      [작성 원칙 — 반드시 지킬 것]
      1. 사용자가 입력한 내용과 업로드 자료에 있는 사실만 사용하여 정리 · 분류 · 문장화합니다. 없는 사실은 절대 임의로 만들지 마세요.
      2. 같은 내용을 여러 항목에 반복하지 마세요. 안건과 회의내용을 분명히 구분해 주세요.
      3. 참석자 의견을 제외하고는, 입력하지 않은 날짜, 담당자, 결정사항, 개인정보를 절대 임의 생성하지 마세요.
      4. 결정사항은 쉽게 확인할 수 있게 작성해 주세요.
      5. 짧은 메모(예: "가을 야유회 장소 결정, 김민수 학교 적응 관련 논의, 다음 주 소방교육 준비")가 입력되면 알맞은 항목으로 자동 분류하여 작성해 주세요.
      6. 해당 항목에 넣을 내용이 전혀 없다면 빈 문자열 ""를 반환하세요. 특히 supervision(슈퍼비전) 관련 내용이 없으면 반드시 ""를 반환하세요.
      7. 출력 문서는 공식 회의록으로 사용할 수 있을 정도로 단정하게 작성해 주세요.

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
