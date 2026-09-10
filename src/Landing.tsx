import { ArrowRight } from 'lucide-react';

/**
 * 랜딩페이지 — 레퍼런스 히어로 이미지(버튼 영역 제거본)를 그대로 표시하고,
 * 동일 위치에 실제 HTML 버튼만 오버레이.
 *
 * 기준 좌표 (레퍼런스 1672×941):
 * - 버튼: x 657–1008 (중앙 39.3–60.3%), y 708–760 (75.2–80.8%)
 *   → pill, 산호색 #F0655A, 흰색 텍스트
 */
export default function Landing() {
  return (
    <div className="landing-hero">
      {/* 레퍼런스 히어로 이미지 (버튼 영역은 제거된 원본 비주얼 그대로) */}
      <img src="/hero.png" alt="AI가 도와주는 교사회의록 AI 작성도우미" className="landing-hero-img" draggable={false} />

      {/* 실제 HTML 버튼 오버레이 — 레퍼런스 버튼과 동일 위치/크기 */}
      <a href="/app" className="landing-cta">
        교사회의록 작성하기 <ArrowRight className="landing-cta-arrow" strokeWidth={2.5} />
      </a>
    </div>
  );
}
