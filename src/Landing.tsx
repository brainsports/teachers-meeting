import { ArrowRight } from 'lucide-react';

/**
 * 랜딩페이지 — hero.png 원본을 화면에 꽉 채워 표시하고,
 * 설명문 아래 중앙(기존 버튼 자리)에 실제 HTML 버튼을 표시.
 *
 * hero.png (1440×683): 설명문 하단 81.4%, 그 아래 중앙이 비어 있어
 * 버튼을 top 84%에 배치.
 */
export default function Landing() {
  return (
    <div className="landing-hero">
      {/* hero.png 원본 비주얼 그대로 */}
      <img src="/hero.png" alt="AI가 도와주는 교사회의록 AI 작성도우미" className="landing-hero-img" draggable={false} />

      {/* 실제 HTML 버튼 — 클릭 시 /app 이동 */}
      <a href="/app" className="landing-cta" onClick={(e) => { e.preventDefault(); window.location.href = '/app'; }}>
        교사회의록 작성하기 <ArrowRight className="landing-cta-arrow" strokeWidth={2.5} />
      </a>
    </div>
  );
}
