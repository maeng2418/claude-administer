import type { Scope } from '../../shared/types.js'

/** 자산이 어느 범위에 있는지 보여주는 배지. */
export function ScopeBadge({ scope }: { scope: Scope }): React.JSX.Element {
  const label = scope === 'user' ? '전역' : scope === 'project' ? '프로젝트' : '플러그인'
  return <span className={`badge badge-${scope}`}>{label}</span>
}

/**
 * 이름이 겹치는 자산이 있을 때 띄우는 배지.
 *
 * 우선순위가 project > user > plugin 이므로, 겹치는 쪽이 자기보다
 * 우선순위가 높으면 "가려짐", 낮으면 "덮어씀"으로 표시한다.
 */
export function ConflictBadge({
  scope,
  shadowedBy
}: {
  scope: Scope
  shadowedBy: Scope[]
}): React.JSX.Element | null {
  if (shadowedBy.length === 0) return null

  const rank: Record<Scope, number> = { project: 3, user: 2, plugin: 1 }
  const isShadowed = shadowedBy.some((other) => rank[other] > rank[scope])
  const names = shadowedBy
    .map((s) => (s === 'user' ? '전역' : s === 'project' ? '프로젝트' : '플러그인'))
    .join(', ')

  return (
    <span
      className="badge badge-conflict"
      title={
        isShadowed
          ? `${names} 쪽 같은 이름이 우선합니다 — 이 항목은 적용되지 않습니다`
          : `${names} 쪽에도 같은 이름이 있습니다 — 이 항목이 우선합니다`
      }
    >
      {isShadowed ? `가려짐 (${names})` : `덮어씀 (${names})`}
    </span>
  )
}

/** 꺼져 있는 자산 표시. */
export function OffBadge(): React.JSX.Element {
  return <span className="badge badge-off">꺼짐</span>
}
