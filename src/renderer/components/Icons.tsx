/**
 * 인라인 SVG 아이콘.
 *
 * 아이콘 폰트나 라이브러리를 쓰지 않는 이유는 이 앱이 쓰는 아이콘이 셋뿐이고,
 * 의존성 하나를 더하는 것보다 24줄을 직접 쓰는 쪽이 싸기 때문이다.
 *
 * 모두 currentColor 를 쓰므로 버튼 색을 따라간다. 크기는 1em 기준이라
 * 글자 크기만 바꿔도 함께 커진다.
 */

const BASE = {
  // 크기는 CSS(.icon)가 정한다. width="1em" 속성은 SVG 에서 폰트 크기로
  // 해석되지 않아 2px 로 찌그러진다 — 실측으로 확인했다.
  className: 'icon',
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  // 아이콘 자체는 장식이다. 의미는 버튼의 aria-label 이 전달한다.
  'aria-hidden': true,
  focusable: false
}

/** 휴지통. 제거 버튼에 쓴다. */
export function TrashIcon(): React.JSX.Element {
  return (
    <svg {...BASE}>
      <path d="M2.5 4h11" />
      <path d="M6 4V2.5h4V4" />
      <path d="M3.5 4l.6 9a1 1 0 0 0 1 .9h5.8a1 1 0 0 0 1-.9l.6-9" />
      <path d="M6.5 7v4M9.5 7v4" />
    </svg>
  )
}

/** 바깥으로 나가는 화살표. 다른 탭으로 이동하는 버튼에 쓴다. */
export function ExternalLinkIcon(): React.JSX.Element {
  return (
    <svg {...BASE}>
      <path d="M9.5 2.5H13.5V6.5" />
      <path d="M13.5 2.5L7.5 8.5" />
      <path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
    </svg>
  )
}

/**
 * 다시 읽기. 시계 방향 화살표 두 개.
 *
 * 원을 한 바퀴 그리지 않고 양 끝을 띄우는 이유는, 끊긴 자리에 화살촉이
 * 들어가 "돌아간다"는 뜻이 읽히기 때문이다. 닫힌 원은 그냥 동그라미다.
 */
export function RefreshIcon(): React.JSX.Element {
  return (
    <svg {...BASE}>
      <path d="M13.5 7a5.5 5.5 0 1 0-1.2 4.2" />
      <path d="M13.5 3v4h-4" />
    </svg>
  )
}

/** Finder 에서 보기. 폴더 모양. */
export function FolderIcon(): React.JSX.Element {
  return (
    <svg {...BASE}>
      <path d="M1.5 4a1 1 0 0 1 1-1h3l1.3 1.5h6.7a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4Z" />
    </svg>
  )
}
