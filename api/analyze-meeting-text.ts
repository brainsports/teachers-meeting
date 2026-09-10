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
      아래 회의자료 텍스트를 분석하여, 교사회의록 입력란에 자동으로 채울 값을 추출해 주세요.
      이 텍스트는 지역아동센터 교사회의 자료입니다. 형식이 조금 달라도 의미를 파악해 분석합니다.

      [회의자료 텍스트]
      ${text}

      [추출할 항목]
      - title: 회의명 (예: 9월 교사회의)
      - date: 일시 (원문에 있는 표현 그대로)
      - location: 장소
      - attendees: 참석자 (쉼표로 구분된 문자열)
      - report: 보고 및 전달사항 (공지, 행정, 일정, 아동 관련 전달사항, 교육, 안전)
      - agenda: 안건 (번호 형식: "1. ...\\n2. ...")
      - discussion: 회의내용 (안건별 논의내용, 결정사항, 담당자, 실행 일정이 있다면 포함)
      - nextWeek: 기타/차주계획 (다음 주 프로그램, 행사, 교육, 준비사항)
      - supervision: 슈퍼비전 (센터장/관리자의 지도, 조언, 업무 방향)

      [절대 규칙]
      1. 텍스트에 없는 정보는 절대 임의로 만들지 마세요. 해당 항목은 빈 문자열 ""를 반환하세요.
      2. 원문에 있는 내용을 요약·정리하는 것만 허용됩니다. 추측 금지.
      3. 날짜, 담당자, 참석자, 결정사항을 새로 만들어내지 마세요.
      4. 모든 값은 한국어 문자열입니다.

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
