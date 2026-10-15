import { CloseIcon } from './Icons.js'

/**
 * 닫을 수 있는 알림 줄.
 *
 * 이 컴포넌트는 "한 번 읽으면 끝나는" 소식에만 쓴다 — 작업 결과, 오류,
 * 읽기 실패 같은 것들이다. 탭을 설명하는 상시 정보에는 쓰지 않는다:
 * 닫으면 되살릴 방법이 없어서, 사용자가 치운 것이 아니라 잃어버린 것이
 * 된다. 그런 정보는 배너가 아니라 흐린 작은 글씨로 둔다.
 *
 * 닫기를 X 아이콘 하나로 두는 이유는 뜻이 보편적이기 때문이다. 이름은
 * aria-label 이 말하고, 아이콘 자체는 장식으로 둔다.
 */
export function Banner({
  tone = 'info',
  role = 'status',
  onClose,
  children
}: {
  /** info 는 기본 경고색, error 는 빨간색. */
  tone?: 'info' | 'error'
  /** 오류는 alert 로 두어 보조기술이 즉시 읽게 한다. */
  role?: 'status' | 'alert'
  /** 닫기 버튼을 누르면 호출된다. 없으면 닫기 버튼을 그리지 않는다. */
  onClose?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={`banner${tone === 'error' ? ' banner-error' : ''}`} role={role}>
      {/*
        본문을 한 번 더 감싸는 이유: 닫기 버튼이 오른쪽 끝에 고정되어야
        하는데, 본문이 길면 버튼을 밀어낸다. 본문에만 줄바꿈과 축소를
        허용하고 버튼은 고정 크기로 둔다.
      */}
      <div className="banner-body">{children}</div>
      {onClose && (
        <button
          type="button"
          className="btn btn-icon banner-close"
          onClick={onClose}
          title="이 알림 닫기"
          aria-label="알림 닫기"
        >
          <CloseIcon />
        </button>
      )}
    </div>
  )
}
