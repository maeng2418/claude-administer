import { useEffect, useRef } from 'react'
import { TrashIcon } from './Icons.js'
import type { ProjectRef } from '../../shared/types.js'

/**
 * 프로젝트 관리 창.
 *
 * 선택기에서 분리한 이유: 전환은 자주 하고 등록·삭제는 드물다. 둘을 한
 * 컨트롤에 넣으면 자주 쓰는 동작이 드물게 쓰는 동작의 복잡도를 떠안는다.
 *
 * 목록은 출처별로 묶지 않고 한 줄로 늘어놓는다. 어느 쪽에서 왔는지는
 * 행마다 배지로 붙이므로, 묶음은 같은 정보를 두 번 말하면서 목록만
 * 쪼갠다.
 */
export function ProjectManager({
  projects,
  selected,
  busy,
  onSelect,
  onAdd,
  onRemove,
  onClose
}: {
  projects: ProjectRef[]
  selected: string | null
  busy?: boolean
  onSelect: (path: string | null) => void
  onAdd: () => void
  onRemove: (path: string) => void
  onClose: () => void
}): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  // 열리면 닫기 버튼으로 포커스를 옮긴다 — 키보드로 연 사람이 창 안에 있어야 한다.
  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  // Esc 로 닫는다. 창 바깥 클릭도 같은 역할을 한다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-manager-title"
        ref={dialogRef}
      >
        <div className="modal-head">
          <h2 className="modal-title" id="project-manager-title">
            프로젝트 관리
          </h2>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onClose}
            ref={closeRef}
            aria-label="닫기"
          >
            닫기
          </button>
        </div>

        <p className="modal-note">
          Claude Code 사용 기록에서 찾은 프로젝트와 직접 추가한 폴더입니다. 직접 추가한
          것만 목록에서 뺄 수 있고, 폴더와 파일은 건드리지 않습니다.
        </p>

        <div className="modal-list" role="list">
          <button
            type="button"
            className={`proj-row${selected === null ? ' is-selected' : ''}`}
            onClick={() => onSelect(null)}
            role="listitem"
          >
            <span className="proj-main">
              <span className="proj-name">전역만 보기</span>
              <span className="proj-path">~/.claude</span>
            </span>
          </button>

          {projects.map((p) => (
            <div
              key={p.path}
              className={`proj-row proj-row-group${p.path === selected ? ' is-selected' : ''}`}
              role="listitem"
            >
              <button
                type="button"
                className="proj-main proj-pick"
                onClick={() => onSelect(p.path)}
                title={p.path}
              >
                <span className="proj-name">
                  {p.name}
                  <span className={`badge badge-${p.origin === 'added' ? 'user' : 'plugin'}`}>
                    {p.origin === 'added' ? '직접 추가' : '사용 기록'}
                  </span>
                  {!p.hasClaudeDir && !p.hasMcpConfig && (
                    <span className="badge badge-off">자산 없음</span>
                  )}
                </span>
                <span className="proj-path">{p.path}</span>
              </button>

              {/* 발견된 프로젝트는 레지스트리에 없으므로 뺄 대상이 아니다. */}
              {p.origin === 'added' && (
                <button
                  type="button"
                  className="btn btn-icon btn-danger"
                  disabled={busy}
                  onClick={() => onRemove(p.path)}
                  title="목록에서만 뺍니다. 폴더와 파일은 그대로 둡니다."
                  aria-label={`${p.name} 을(를) 목록에서 빼기`}
                >
                  <TrashIcon />
                </button>
              )}
            </div>
          ))}

          {projects.length === 0 && (
            <div className="modal-empty">
              아직 아는 프로젝트가 없습니다. 폴더를 추가해 보세요.
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn" onClick={onAdd} disabled={busy}>
            폴더 추가
          </button>
          <span className="modal-count">{projects.length}개</span>
        </div>
      </div>
    </div>
  )
}
