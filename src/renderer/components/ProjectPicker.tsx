import type { ProjectRef } from '../../shared/types.js'

/**
 * 프로젝트 선택기.
 *
 * 한 번에 한 프로젝트만 본다. 여러 프로젝트를 한 목록에 합치지 않는 이유는
 * 충돌 배지("가려짐")가 거짓이 되기 때문이다 — 가림은 같은 프로젝트 안에서
 * 전역 대 프로젝트일 때만 일어나고, 다른 프로젝트끼리는 서로 영향이 없다.
 */
export function ProjectPicker({
  projects,
  selected,
  disabled,
  onSelect,
  onAdd,
  onRemove
}: {
  projects: ProjectRef[]
  selected: string | null
  disabled?: boolean
  onSelect: (path: string | null) => void
  onAdd: () => void
  onRemove: (path: string) => void
}): React.JSX.Element {
  const current = projects.find((p) => p.path === selected) ?? null
  const added = projects.filter((p) => p.origin === 'added')
  const discovered = projects.filter((p) => p.origin === 'discovered')

  return (
    <div className="picker">
      <label className="picker-label" htmlFor="project-select">
        프로젝트
      </label>

      <select
        id="project-select"
        className="picker-select"
        value={selected ?? ''}
        disabled={disabled}
        onChange={(e) => onSelect(e.target.value === '' ? null : e.target.value)}
      >
        <option value="">전역만 보기 (~/.claude)</option>
        {added.length > 0 && (
          <optgroup label="직접 추가">
            {added.map((p) => (
              <option key={p.path} value={p.path}>
                {p.name}
              </option>
            ))}
          </optgroup>
        )}
        {discovered.length > 0 && (
          <optgroup label="사용 기록에서 발견">
            {discovered.map((p) => (
              <option key={p.path} value={p.path}>
                {p.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>

      {current && (
        <div className="picker-meta" title={current.path}>
          {current.path}
        </div>
      )}

      {current && !current.hasClaudeDir && !current.hasMcpConfig && (
        <div className="picker-warn">이 폴더에는 .claude/ 도 .mcp.json 도 없습니다.</div>
      )}

      <div className="picker-actions">
        <button type="button" className="btn btn-sm" onClick={onAdd} disabled={disabled}>
          폴더 추가
        </button>
        {current?.origin === 'added' && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onRemove(current.path)}
            disabled={disabled}
            title="목록에서만 빼며, 폴더와 파일은 건드리지 않습니다"
          >
            목록에서 빼기
          </button>
        )}
      </div>
    </div>
  )
}
