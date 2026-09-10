# 교사회의록 AI 작성도우미

지역아동센터(방과후아동돌봄시설) 교사회의록을 AI로 자동 작성하는 웹 서비스입니다.
짧은 회의 메모나 회의자료(PDF·TXT·DOCX)만으로 희망이음 시스템에 옮겨 입력하기 좋은
교사회의록 5개 항목을 자동 생성합니다.

## 회의록 구조

- 기본정보: 회의명 · 일시 · 장소 · 참석자
- 본문 5개 항목: 보고 및 전달사항 / 안건 / 회의내용 / 기타(차주계획) / 슈퍼비전

## 주요 기능

- Step 1. 회의자료 업로드 (PDF / TXT / DOCX)
- Step 2. 회의정보 입력 (회의명 · 일시 · 장소 · 참석자 · 핵심 메모)
- Step 3. AI 교사회의록 생성 → 항목별 직접 수정 → Word(DOCX) 다운로드

## 기술 스택

- React 19 + TypeScript + Vite + Tailwind CSS 4
- Vercel Serverless Function (`/api/generate-teacher-minutes`)
- Gemini API (서버 호출 전용 — API Key는 서버 환경변수에서만 사용)

## 환경변수

```
GEMINI_API_KEY=...   # Vercel 프로젝트 환경변수 (서버 전용)
```

## 개발

```
npm install
npm run dev      # Vite 개발 서버
npm run lint     # tsc --noEmit
npm run build    # vite build
```

## 작성 원칙

- 입력된 내용과 업로드 자료에 있는 사실만 사용 (없는 사실·발언 임의 생성 금지)
- 초등학교 6학년도 이해할 수 있는 쉬운 문장
- 안건과 회의내용을 분명히 구분, 중복 금지
