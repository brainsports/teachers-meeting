/**
 * iframe 자동 높이 연동 — 현재 문서 높이를 부모 페이지(kpang.kr)로 전달.
 *
 * 부모(Elementor) 페이지는 postMessage로 받은 height로 iframe 높이를 조절한다.
 * - 메시지: { type: 'teacher-meeting-height', height }
 * - targetOrigin: https://kpang.kr
 *
 * 사용: 최상위 컴포넌트에서 usePostHeightToParent() 호출.
 */
import { useEffect } from 'react';

const PARENT_ORIGIN = 'https://kpang.kr';
const MESSAGE_TYPE = 'teacher-meeting-height';

function postHeight() {
  // 스크롤 없이 전체 콘텐츠를 포함하는 문서 높이
  const height = Math.max(
    document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0
  );
  window.parent.postMessage({ type: MESSAGE_TYPE, height }, PARENT_ORIGIN);
}

export function usePostHeightToParent() {
  useEffect(() => {
    // iframe 안이 아니면 전송하지 않음 (직접 접속 시 불필요)
    if (window.parent === window) return;

    postHeight();

    // 콘텐츠 변경(이미지 로딩·입력·AI 생성 결과 반영 등)에 따라 높이 변화 감지
    const observer = new ResizeObserver(postHeight);
    observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);

    const onResize = () => postHeight();
    window.addEventListener('resize', onResize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, []);
}
