import type { ProjectRef } from '../../shared/types.js'

/**
 * 프로젝트 선택기.
 *
 * 한 번에 한 프로젝트만 본다. 여러 프로젝트를 한 목록에 합치지 않는 이유는
 * 충돌 배지("가려짐")가 거짓이 되기 때문이다 — 가림은 같은 프로젝트 안에서
 * 전역 대 프로젝트일 때만 일어나고, 다른 프로젝트끼리는 서로 영향이 없다.
 *
 * 등록·삭제는 관리 창으로 분리했다. 전환은 자주, 등록은 드물다.
 */
export function ProjectPicker({
  projects,
  selected,
  disabled,
  onSelect,
  onManage
}: {
  projects: ProjectRef[]
  selected: string | null
  disabled?: boolean
  onSelect: (path: string | null) => void
  onManage: () => void
}): React.JSX.Element {
  const current = projects.find((p) => p.path === selected) ?? null

  return (
    <div className="picker">
      <div className="picker-head">
        <label className="picker-label" htmlFor="project-select">
          프로젝트
        </label>
        <button
          type="button"
          className="picker-manage"
          onClick={onManage}
          disabled={disabled}
          title="프로젝트를 추가하거나 목록에서 뺍니다"
        >
          관리
        </button>
      </div>

      {/*
        출처(직접 추가 / 사용 기록)로 묶지 않는다. 고를 때 필요한 건 이름이고,
        출처는 관리 창에서 배지로 본다. 묶으면 목록만 쪼개진다.
      */}
      <select
        id="project-select"
        className="picker-select"
        value={selected ?? ''}
        disabled={disabled}
        onChange={(e) => onSelect(e.target.value === '' ? null : e.target.value)}
      >
        <option value="">전역만 보기 (~/.claude)</option>
        {projects.map((p) => (
          <option key={p.path} value={p.path}>
            {p.name}
          </option>
        ))}
      </select>

      {current && (
        <div className="picker-meta" title={current.path}>
          {current.path}
        </div>
      )}

      {current && !current.hasClaudeDir && !current.hasMcpConfig && (
        <div className="picker-warn">이 폴더에는 .claude/ 도 .mcp.json 도 없습니다.</div>
      )}
    </div>
  )
}
