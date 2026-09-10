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

// ---------- 생성 결과 검증 (discussion 품질 체크) ----------
// 1) 입력된 참석자 이름이 모두 등장하는지
// 2) 발언자 이름 뒤에 실제 발언 내용이 있는지 ("이름:" 다음에 비어있지 않은 줄)
// 3) 금지 표현(~함, ~됨 등 보고서식 종결)이 있는지
function validateDiscussion(discussion: string, attendeeNames: string[]): string[] {
  const problems: string[] = [];

  // (1) 참석자 누락 검사
  for (const name of attendeeNames) {
    if (!discussion.includes(name)) {
      problems.push(`참석자 누락: ${name}`);
    }
  }

  // (2) 발언 형식 검사 — "이름:" 바로 다음에 오는 내용이 있어야 함
  const lines = discussion.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const speakerMatch = line.match(/^(.{1,20})[::]?\s*$/);
    if (speakerMatch && attendeeNames.includes(speakerMatch[1])) {
      // 이름 줄 발견 — 다음 비어있지 않은 줄에 발언이 있는지 확인
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length || lines[j].trim().length < 10) {
        problems.push(`발언 내용 없음: ${speakerMatch[1]}`);
      }
    }
  }

  // (3) 금지 종결 표현 검사 (~함 / ~됨 / ~하였음 / ~필요함 / ~판단됨)
  const bannedEndings = discussion.match(/[가-힣]{2,}(함|됨)\s*$/gm);
  if (bannedEndings && bannedEndings.length > 0) {
    problems.push(`금지 종결어미 사용: ${bannedEndings.slice(0, 3).join(", ")}`);
  }

  return problems;
}

// 검증 실패 시 1회 보정 재생성 프롬프트
function buildRevisionPrompt(originalPrompt: string, discussion: string, problems: string[], attendeeNames: string[]): string {
  return `
      아래 교사회의록 초안에서 발견된 문제를 고쳐 다시 작성해 주세요.

      [발견된 문제]
      ${problems.map(p => `- ${p}`).join("\n      ")}

      [수정 지침]
      1. 참석자 "${attendeeNames.join('", "')}" 전원이 각 안건의 참석자별 의견에 빠짐없이 등장해야 합니다.
      2. 반드시 "발언자 이름:" 줄 다음에 발언 내용을 작성합니다. 발언자 이름이 없는 문단은 만들지 않습니다.
      3. 모든 문장은 존칭 종결어미(~습니다, ~좋겠습니다, ~필요합니다 등)로 끝냅니다. "~함", "~됨" 금지.
      4. 참석자 1명당 약 300자 내외, 서로 다른 관점으로 작성합니다.
      5. 원본 회의 정보의 사실만 사용하고, 없는 사실은 만들지 않습니다.

      [초안의 discussion]
      ${discussion.slice(0, 4000)}

      ${originalPrompt}
    `;
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

    // 참석자 이름 SSOT — attendees 입력값을 그대로 파싱 (AI가 다른 이름을 만들지 못하게 프롬프트에 고정)
    const attendeeNames: string[] = ((meetingData?.attendees as string) || "")
      .split(/[,/\n·]/)
      .map((s: string) => s.trim().replace(/\s*\(.*?\)\s*/g, "").trim())
      .filter((s: string) => s.length > 0 && s.length <= 20);

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

      [발언자 이름 목록 — 반드시 이 이름만 사용]
      ${attendeeNames.length > 0 ? attendeeNames.map((n: string, i: number) => `${i + 1}. ${n}`).join("\n      ") : "미입력"}
      위 이름 외의 다른 이름(성함)을 절대 만들어내지 마세요. 이름을 변형하지도 마세요.

      [작성할 5개 항목]
      1. report (보고 및 전달사항): 공지사항, 행정업무, 일정, 아동 관련 전달사항, 교육, 안전 관련 내용을 정리.
      2. agenda (안건): 실제 논의할 주제를 번호별(1. 2. 3.)로 간단하게 정리.
      3. discussion (회의내용): 아래 [회의내용 작성지침]에 따라 안건별로 작성.
      4. nextWeek (기타/차주계획): 다음 주 프로그램, 행사, 교육, 준비사항과 일정을 정리.
      5. supervision (슈퍼비전): 아래 [슈퍼비전 작성지침]에 따라 반드시 자동으로 작성.

      [슈퍼비전(supervision) 작성지침 — 반드시 작성]
      - 슈퍼비전은 반드시 자동으로 작성합니다. 입력된 자료에 슈퍼비전 내용이 없어도 빈 값으로 남기지 않습니다.
      - 약 300자 내외로 작성합니다.
      - 회의 안건, 회의내용, 결정사항을 바탕으로, 센터장 또는 관리자가 회의 마지막에 교사들에게 업무 방향을 알려주는 말처럼 자연스럽게 작성합니다.
      - 단순한 요약이 아니라 실제 센터장의 지도·조언 말투로 작성합니다. (예: "안전을 가장 먼저 생각해 달라고 안내했습니다", "인원을 꼭 확인해 주세요")
      - 안전, 아동지도, 프로그램 운영, 역할분담, 보호자 안내, 일정 준비 등 이번 회의에서 실제 다뤄진 주제와 직접 관련된 조언을 작성합니다.
      - 절대 규칙: 원문에 없는 새로운 날짜, 예산, 기관명, 아동 개인정보, 실제로 결정되지 않은 사실은 만들지 않습니다.
      - 사용자가 직접 입력한 슈퍼비전 내용이 있으면 그 내용을 가장 우선하여 다듬어 작성합니다.
      - 작성 예시:
        센터장은 가을야유회를 준비할 때 프로그램 내용보다 아동의 안전을 가장 먼저 생각해 달라고 안내했습니다. 이동 전과 도착 후에는 참석 인원을 꼭 확인하고, 인솔교사별 담당 아동을 미리 정해 두는 것이 필요합니다. 보호자에게 일정과 준비물을 충분히 안내하고, 비가 올 경우를 대비한 대체 계획도 미리 준비해 주세요. 교사들이 각자 맡은 역할을 확인하고 서로 도우면서 준비하면 좋겠습니다.

      [회의내용(discussion) 작성지침 — 반드시 이 순서와 형식으로 작성]
      각 안건마다 다음 순서로 작성합니다:
      (1) 안건 제시
      (2) 참석자별 의견
      (3) 주요 논의내용
      (4) 결정사항
      (5) 준비할 사항
      (6) 최종 결론

      참석자별 의견 작성법 — 가장 중요한 규칙:
      - 반드시 "발언자 이름 + 발언 내용" 형식으로 작성합니다. 이름을 먼저 적고, 그 다음 줄에 발언 내용을 적습니다.
      - [발언자 이름 목록]에 있는 참석자 전원이 빠짐없이 각 안건마다 등장해야 합니다. (4명이면 4명 모두)
      - 발언자 이름이 없는 의견 문단은 절대 만들지 않습니다.
      - 1명당 약 300자 내외로 작성합니다.
      - 각 의견에는 이유, 걱정되는 점, 준비할 점, 찬성 이유 등이 자연스럽게 포함합니다.
      - 참석자마다 표현과 관점을 조금씩 다르게 하여, 같은 문장을 이름만 바꿔 반복하지 않습니다.
      - 형식 예시:
        김센터장:
        가을야유회는 아이들에게 좋은 경험이 될 수 있어서 진행하는 것이 좋겠습니다. 다만 이동할 때 인원 확인과 안전관리를 철저히 해야 합니다.
      - 원문에 참석자의 실제 발언이나 입장이 있다면 그 내용을 가장 우선하고, 없는 부분만 안건 주제에 맞는 일반적인 교사의견으로 자연스럽게 작성합니다.
      - 원문에 없는 새로운 사실(날짜, 장소, 예산, 특정 아동 정보)은 만들지 않습니다.

      최종 결론 작성법:
      - 참석자들이 대체로 찬성한 분위기면 최종 결론도 찬성으로 정리합니다.
      - 찬성 이유와 함께 준비할 사항을 적습니다.
      - 반대 의견이 있으면 해결 가능한 문제는 보완사항으로 정리합니다.
      - 원문에 실제 합의 내용이 있으면 그 내용을 가장 우선합니다.

      [문체 지침 — 모든 항목 공통]
      - 모든 문장은 반드시 존칭 종결어미(~습니다, ~했습니다, ~하기로 했습니다, ~필요합니다, ~좋겠습니다, ~생각합니다, ~바랍니다, ~확인해 주세요, ~주의해 주세요, ~진행하면 좋겠습니다)로 끝냅니다.
      - "~함", "~됨", "~하였음", "~필요함", "~판단됨", "~요망" 같은 보고서식 표현은 절대 사용하지 않습니다.
      - 초등학교 6학년이 읽어도 이해할 수 있는 쉬운 말로, 짧고 자연스러운 문장으로 작성합니다.
      - 실제 교사들이 회의에서 말할 법한 표현을 사용합니다.
      - 다음 AI 느낌 나는 표현은 금지합니다: "종합적으로 살펴보면", "다각적인 관점에서", "긍정적인 시너지", "체계적이고 효율적인 운영", "향후 지속적인 발전", "전반적으로 긍정적인 효과"
      - 대신 "아이들이 좋아할 것 같아서 진행하는 것이 좋겠습니다.", "안전문제만 잘 준비하면 큰 어려움은 없을 것 같습니다." 같은 자연스러운 말로 작성합니다.

      [작성 원칙 — 반드시 지킬 것]
      1. 사용자가 입력한 내용과 업로드 자료에 있는 사실만 사용하여 정리 · 분류 · 문장화합니다. 없는 사실은 절대 임의로 만들지 마세요.
      2. 같은 내용을 여러 항목에 반복하지 마세요. 안건과 회의내용을 분명히 구분해 주세요.
      3. 참석자 의견과 슈퍼비전을 제외하고는, 입력하지 않은 날짜, 담당자, 결정사항, 개인정보를 절대 임의 생성하지 마세요.
      4. 결정사항은 쉽게 확인할 수 있게 작성해 주세요.
      5. 짧은 메모(예: "가을 야유회 장소 결정, 김민수 학교 적응 관련 논의, 다음 주 소방교육 준비")가 입력되면 알맞은 항목으로 자동 분류하여 작성해 주세요.
      6. supervision(슈퍼비전)은 반드시 자동 작성합니다. (위 [슈퍼비전 작성지침] 참고)
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
    let parsed = extractJsonBlock(rawText);

    if (!parsed) {
      console.error("[ERROR] Failed to parse Gemini JSON response.");
      return res.status(502).json({ error: "PARSE_FAILED", message: "회의록 생성 결과를 해석하지 못했습니다. 다시 생성해 주세요." });
    }

    // 생성 결과 검증 — 참석자 누락/발언형식/금지 표현 확인 후 1회 보정
    if (attendeeNames.length > 0) {
      const problems = validateDiscussion(asText(parsed.discussion), attendeeNames);
      if (problems.length > 0) {
        console.log("[WARN] Discussion validation failed, retrying once:", problems.join(" / "));
        try {
          const revisionResponse = await ai.models.generateContent({
            model: modelName,
            contents: { parts: [{ text: buildRevisionPrompt(promptText, asText(parsed.discussion), problems, attendeeNames) }] },
          });
          const revisedParsed = extractJsonBlock(revisionResponse.text || "");
          if (revisedParsed && asText(revisedParsed.discussion)) {
            parsed = revisedParsed;
          }
        } catch (revError: any) {
          // 보정 실패 시 1차 결과로 진행 (전체 실패로 돌리지 않음)
          console.error("[WARN] Revision attempt failed:", revError?.message || revError);
        }
      }
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
