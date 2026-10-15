import type { UsageLimit, UsageReadResult } from '../../shared/types.js'

/**
 * 구독 사용량 표시.
 *
 * 값은 Anthropic 에서 매번 새로 받아온 실시간 수치다. Claude Code 가 쓰는
 * 것과 같은 로그인 정보로 같은 엔드포인트를 호출한다.
 */

/**
 * 한도 종류를 사람이 읽는 이름으로.
 *
 * 모델별 한도(weekly_scoped)는 모델 이름이 붙는다 — "이번 주 Fable" 처럼
 * 어느 한도인지 이름으로 알 수 있어야 한다.
 *
 * @param wide 넓은 자리인지. 사이드바는 208px 라 "세션" 으로 줄이지만,
 *   메뉴바 팝오버는 기간까지 적을 자리가 있다 — 거기서는 "현재 세션" 이
 *   무엇의 한도인지 더 분명하다.
 */
function labelFor(limit: UsageLimit, wide: boolean): string {
  if (limit.scopeLabel) return wide ? `주간 ${limit.scopeLabel}` : limit.scopeLabel
  switch (limit.kind) {
    case 'session':
      return wide ? '현재 세션' : '세션'
    case 'weekly_all':
      return wide ? '이번 주' : '주간'
    default:
      return limit.kind
  }
}

/**
 * 재설정 시각을 "(목) 오전 3:00" 으로. Claude 의 사용량 화면과 같은 형식이다.
 *
 * 날짜를 생략하는 이유는 재설정이 길어야 일주일 뒤라 요일만으로 충분하기
 * 때문이다. 정확한 시각은 title 로 붙인다.
 */
function resetLabel(resetsAt: string | null): string | null {
  if (resetsAt === null) return null
  const at = new Date(resetsAt)
  if (Number.isNaN(at.getTime())) return null
  return at.toLocaleString('ko-KR', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/**
 * 남은 여유에 따른 색. 세 단계로만 나눈다 —
 * 더 쪼개면 경계가 의미를 잃고, 색만으로 판단하게 만들면 안 된다(숫자를 함께 둔다).
 */
function toneFor(used: number): string {
  if (used >= 90) return 'is-danger'
  if (used >= 70) return 'is-warn'
  return ''
}

function UsageBar({ limit, wide }: { limit: UsageLimit; wide: boolean }): React.JSX.Element {
  const label = labelFor(limit, wide)
  const used = Math.min(100, Math.max(0, limit.percent))
  const rounded = Math.round(used)
  const reset = resetLabel(limit.resetsAt)

  return (
    <div
      className="usage-row"
      title={reset ? `${label} ${rounded}% 사용 · 재설정 ${reset}` : `${label} ${rounded}% 사용`}
    >
      <div className="usage-line">
        <span className="foot-label">{label}</span>
        <span className="foot-value foot-value-strong">{rounded}%</span>
      </div>
      {/*
        progressbar 로 역할을 주어 값이 보조기술에도 전달되게 한다.
        색만으로 상태를 말하지 않도록 숫자를 위에 항상 띄워둔다.
      */}
      <div
        className="usage-track"
        role="progressbar"
        aria-label={`${label} 사용량`}
        aria-valuenow={rounded}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className={`usage-fill ${toneFor(used)}`} style={{ width: `${used}%` }} />
      </div>
      {reset && <div className="usage-reset">재설정 {reset}</div>}
    </div>
  )
}

export function UsagePanel({
  usage,
  loading,
  onRefresh,
  wide = false
}: {
  usage: UsageReadResult | null
  loading: boolean
  onRefresh: () => void
  /** 넓은 자리에 놓이는지. 메뉴바 팝오버가 true 로 쓴다(라벨이 길어진다). */
  wide?: boolean
}): React.JSX.Element | null {
  // 아직 안 읽었으면 자리만 비워둔다. 로딩 글자를 띄우면 깜빡임만 는다.
  if (!usage) return null

  // 실패. 이유별로 할 말이 다르므로 usage.ts 가 정한 문구를 그대로 보여준다.
  // 빈 막대를 띄우지 않는 이유는 "0% 사용"으로 읽히기 때문이다.
  if (!usage.ok) {
    return (
      <div className="usage">
        <div className="foot-row">
          <span className="foot-label">사용량</span>
          <span className="foot-value">{loading ? '읽는 중…' : '읽지 못함'}</span>
        </div>
        <div className="usage-hint">{usage.error}</div>
        <button
          type="button"
          className="usage-install"
          onClick={onRefresh}
          disabled={loading}
          title="사용량을 다시 조회합니다"
        >
          {loading ? '읽는 중…' : '다시 시도'}
        </button>
      </div>
    )
  }

  const { fetchedAt, limits } = usage.snapshot

  /*
    조회 시각과 새로고침 버튼은 두지 않는다.
    1분마다 자동으로 갱신되므로 "언제 값인지"는 늘 "방금"이고,
    늘 같은 말을 하는 줄은 읽히지 않으면서 자리만 차지한다.
    전체 갱신이 필요하면 상단 도구막대의 새로고침을 쓴다.
  */
  return (
    <div className="usage" title={`마지막 조회: ${new Date(fetchedAt).toLocaleString('ko-KR')}`}>
      {limits.map((limit) => (
        // kind 는 겹칠 수 있다(weekly_* 가 여럿). 이름까지 묶어 키를 만든다.
        <UsageBar key={`${limit.kind}:${limit.scopeLabel ?? ''}`} limit={limit} wide={wide} />
      ))}
    </div>
  )
}
