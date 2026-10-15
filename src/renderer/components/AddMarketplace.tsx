import { useEffect, useRef, useState } from 'react'
import type { PluginOpResult } from '../../shared/types.js'

/**
 * 마켓플레이스 추가 창.
 *
 * 입력이 한 줄이라 모달로 두는 것이 과해 보이지만, 세 가지를 보여줘야
 * 한다: 받아들이는 형식, 진행 중 상태, 그리고 실패 사유. 출처 문자열이
 * 틀리면 CLI 가 clone 단계까지 가서 실패하므로, 사유를 그 자리에서
 * 읽게 하는 편이 낫다 — 상단 배너로 올리면 입력값과 떨어진다.
 */
export function AddMarketplace({
  onAdd,
  onClose
}: {
  /** 추가를 수행한다. 결과를 그대로 돌려받아 창 안에서 보여준다. */
  onAdd: (source: string) => Promise<PluginOpResult>
  onClose: () => void
}): React.JSX.Element {
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<PluginOpResult | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 열리면 입력칸으로 포커스를 옮긴다 — 이 창의 용도가 하나라서 바로 타이핑하면 된다.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 작업 중에는 Esc 를 막는다. CLI 는 계속 돌고 있어서 창을 닫아도
      // 멈추지 않는데, 닫히면 결과를 받을 자리가 없어진다.
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const submit = async (): Promise<void> => {
    const value = source.trim()
    if (value === '' || busy) return
    setBusy(true)
    setResult(null)
    setResult(await onAdd(value))
    setBusy(false)
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label="마켓플레이스 추가">
        <div className="modal-head">
          <div className="modal-title">마켓플레이스 추가</div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onClose}
            disabled={busy}
          >
            닫기
          </button>
        </div>

        <p className="modal-note">
          GitHub 저장소(<code>owner/repo</code>), git URL, 또는 로컬 폴더 경로를 넣으세요.
          <br />
          추가는 <code>claude plugin marketplace add</code> 가 수행합니다.
        </p>

        <form
          className="modal-form"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <input
            ref={inputRef}
            className="search modal-input"
            type="text"
            placeholder="anthropics/claude-plugins-community"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            disabled={busy}
            aria-label="마켓플레이스 출처"
            spellCheck={false}
            autoCapitalize="off"
          />
          <button
            type="submit"
            className="btn btn-on"
            disabled={busy || source.trim() === ''}
          >
            {busy ? '추가 중…' : '추가'}
          </button>
        </form>

        {busy && (
          <div className="modal-note" role="status">
            저장소를 받아오는 중입니다. 처음 추가하는 저장소는 시간이 걸릴 수 있습니다.
          </div>
        )}

        {result && (
          <div
            className={`banner${result.ok ? '' : ' banner-error'}`}
            role={result.ok ? 'status' : 'alert'}
          >
            {result.ok
              ? (result.message ?? '추가했습니다.')
              : `추가 실패: ${result.error ?? '알 수 없는 오류'}`}
          </div>
        )}
      </div>
    </div>
  )
}
