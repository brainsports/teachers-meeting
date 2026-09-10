/**
 * Vercel Serverless Function: POST /api/analyze-meeting-text
 *
 * 붙여넣은 회의자료 텍스트를 AI가 분석하여 회의정보 입력란에
 * 자동배치할 수 있는 구조화 JSON을 반환한다.
 * Gemini 호출 구조는 generate-teacher-minutes.ts와 동일하게 재사용.
 *
 * 텍스트에 없는 정보는 절대 임의 생성하지 않는다 (빈 문자열 반환).
 * AI 생성 제한(1일 3회) 대상에서 제외 — 실제 회의록 "생성"이 아니므로.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GoogleGenAI } from "@google/genai";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

export const config = {
  maxDuration: 60,
};

export interface MeetingFields {
  title: string;
  date: string;
  location: string;
  attendees: string;
  report: string;
  agenda: string;
  discussion: string;
  nextWeek: string;
  supervision: string;
}

const FIELD_KEYS: (keyof MeetingFields)[] = [
  "title",
  "date",
  "location",
  "attendees",
  "report",
  "agenda",
  "discussion",
  "nextWeek",
  "supervision",
];

function extractJsonBlock(raw: string): Partial<MeetingFields> | null {
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

function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join("\n");
  return "";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
  }

  try {
    const { text } = req.body || {};
    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "NO_INPUT", message: "분석할 회의자료 텍스트를 입력해 주세요." });
    }
    if (text.length > 50000) {
      return res.status(400).json({ error: "TEXT_TOO_LONG", message: "텍스트가 너무 깁니다. (최대 50,000자)" });
    }

    if (!GEMINI_API_KEY) {
      console.error("[ERROR] GEMINI_API_KEY is not set.");
      return res.status(500).json({ error: "SERVER_CONFIGURATION_ERROR" });
    }

    const ai = new GoogleGenAI({
      apiKey: GEMINI_API_KEY,
      httpOptions: {
        headers: { "User-Agent": "aistudio-build" },
        timeout: 55_000,
      },
    });

    const promptText = `
      아래 회의자료 텍스트에서 정보를 추출하는 작업입니다. 이것은 창작 작업이 아니라 복사·정리 작업입니다.

      [회의자료 텍스트]
      ${text}

      [추출할 항목]
      - title: 회의명
      - date: 일시 (원문 표현 그대로)
      - location: 장소
      - attendees: 참석자 (원문에 적힌 이름만, 쉼표로 구분)
      - report: 보고 및 전달사항
      - agenda: 안건 (원문의 번호 목록 그대로, 형식: "1. ...\\n2. ...")
      - discussion: 회의내용
      - nextWeek: 기타/차주계획
      - supervision: 슈퍼비전

      [절대 규칙 — 가장 중요]
      1. 이것은 텍스트 추출(复制) 작업입니다. 결과의 모든 단어는 원문에 반드시 존재해야 합니다.
      2. 원문에 없는 이름, 날짜, 장소, 안건, 내용을 만들어내면 안 됩니다. 절대 창작하지 마세요.
      3. 단어를 비슷한 다른 단어로 바꾸지 마세요. (예: "가을야유회"를 "가을나들이"로 바꾸기 금지)
      4. 원문의 고유명사(행사명, 사람 이름, 장소명)는 글자 하나도 바꾸지 말고 그대로 복사하세요.
      5. 항목에 해당하는 내용이 원문에 없으면 빈 문자열 ""를 반환하세요. 추측해서 채우지 마세요.
      6. 여러 항목에 걸친 내용은 해당하는 하나의 항목에만 배치하고, 나머지는 비워두세요.

      [출력 형식]
      반드시 아래 JSON 형식만 반환하세요. JSON 외 설명문 금지.
      {
        "title": "...",
        "date": "...",
        "location": "...",
        "attendees": "...",
        "report": "...",
        "agenda": "...",
        "discussion": "...",
        "nextWeek": "...",
        "supervision": "..."
      }
    `;

    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: { parts: [{ text: promptText }] },
    });

    const parsed = extractJsonBlock(response.text || "");
    if (!parsed) {
      return res.status(502).json({ error: "PARSE_FAILED", message: "텍스트 분석 결과를 해석하지 못했습니다. 다시 시도해 주세요." });
    }

    const fields: MeetingFields = {} as MeetingFields;
    for (const key of FIELD_KEYS) {
      fields[key] = asText(parsed[key]);
    }

    return res.json({ fields });
  } catch (error: any) {
    console.error("[ERROR] Analyze Meeting Text Server Error:", error?.message || error);
    return res.status(500).json({ error: "ANALYSIS_FAILED", message: "텍스트 분석 처리 중 서버 오류가 발생했습니다." });
  }
}
