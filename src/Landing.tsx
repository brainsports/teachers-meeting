/**
 * 랜딩페이지 — hero.png 원본을 화면에 꽉 채워 표시하고,
 * 이미지 안의 노란색 '작성하기' 버튼 위에 투명 클릭 영역만 오버레이.
 *
 * hero.png (1440×679)에서 측정한 버튼 pill 위치:
 * - x 39.0–62.3% (중앙), y 79.4–98.2%
 */
export default function Landing() {
  return (
    <div className="landing-hero">
      {/* hero.png 원본 비주얼 그대로 */}
      <img src="/hero.png" alt="AI가 도와주는 교사회의록 AI 작성도우미" className="landing-hero-img" draggable={false} />

      {/* 이미지 속 '작성하기' 버튼과 정확히 겹친 투명 클릭 영역 (별도 버튼 표시 없음) */}
      <a href="/app" className="landing-cta-zone" aria-label="교사회의록 작성하기" onClick={(e) => { e.preventDefault(); window.location.href = '/app'; }} />
    </div>
  );
}
