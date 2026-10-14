import { useCallback, useEffect, useMemo, useState } from 'react'
import { AssetRow } from './components/AssetRow.js'
import type { Asset, AssetKind, Inventory } from '../shared/types.js'

/** 사이드바 탭 정의. 순서가 화면 순서다. */
const TABS: { kind: AssetKind; label: string; field: keyof Inventory }[] = [
  { kind: 'skill', label: '스킬', field: 'skills' },
  { kind: 'command', label: '커맨드', field: 'commands' },
  { kind: 'agent', label: '에이전트', field: 'agents' },
  { kind: 'hook', label: '훅', field: 'hooks' },
  { kind: 'plugin', label: '플러그인', field: 'plugins' },
  { kind: 'mcp', label: 'MCP 서버', field: 'mcp' }
]

/** 검색어가 자산의 어느 필드든 걸리는지 본다. */
function matches(asset: Asset, query: string): boolean {
  if (query === '') return true
  const q = query.toLowerCase()
  const haystack = [
    asset.name,
    asset.description ?? '',
    asset.path,
    asset.kind === 'command' ? asset.invocation : '',
    asset.kind === 'skill' ? (asset.trigger ?? '') : '',
    asset.kind === 'hook' ? `${asset.event} ${asset.command}` : '',
    asset.kind === 'plugin' ? `${asset.id} ${asset.marketplace}` : '',
    asset.kind === 'mcp' ? `${asset.transport} ${asset.command ?? ''}` : ''
  ]
  return haystack.join(' ').toLowerCase().includes(q)
}

export function App(): React.JSX.Element {
  const [inventory, setInventory] = useState<Inventory | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<AssetKind>('skill')
  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      setInventory(await window.api.scan())
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleOpen = useCallback(async (path: string) => {
    const result = await window.api.openPath(path)
    if (!result.ok) setNotice(`열기 실패: ${result.error ?? '알 수 없는 오류'}`)
  }, [])

  const handleReveal = useCallback(async (path: string) => {
    const result = await window.api.revealPath(path)
    if (!result.ok) setNotice(`위치 열기 실패: ${result.error ?? '알 수 없는 오류'}`)
  }, [])

  /**
   * 플러그인 토글. 성공하면 전체를 다시 스캔한다 —
   * 플러그인이 제공하는 스킬/커맨드 목록까지 바뀌므로 부분 갱신은 어긋난다.
   */
  const handleToggle = useCallback(
    async (asset: Asset, next: boolean) => {
      if (asset.kind !== 'plugin') return
      setBusyId(asset.id)
      setNotice(null)
      const result = await window.api.togglePlugin(asset.id, next)
      if (result.ok) {
        setNotice(
          `${asset.name} ${next ? '켰습니다' : '껐습니다'}. 백업: ${
            result.backupPath ?? '없음'
          } · 변경은 Claude Code 재시작 후 적용됩니다.`
        )
        await load()
      } else {
        setNotice(`토글 실패: ${result.error ?? '알 수 없는 오류'}`)
      }
      setBusyId(null)
    },
    [load]
  )

  const activeTab = TABS.find((t) => t.kind === tab) ?? TABS[0]!
  const rows = useMemo(() => {
    if (!inventory) return []
    const list = inventory[activeTab.field] as Asset[]
    return list.filter((a) => matches(a, query))
  }, [inventory, activeTab.field, query])

  const totalFor = useCallback(
    (field: keyof Inventory): number => {
      if (!inventory) return 0
      const value = inventory[field]
      return Array.isArray(value) ? value.length : 0
    },
    [inventory]
  )

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="sidebar-title">Claude Administer</div>
          <div className="sidebar-sub">
            {inventory ? `자산 ${TABS.reduce((n, t) => n + totalFor(t.field), 0)}개` : '읽는 중…'}
          </div>
        </div>

        <nav className="nav">
          {TABS.map((t) => (
            <button
              key={t.kind}
              type="button"
              className="nav-item"
              aria-current={t.kind === tab}
              onClick={() => setTab(t.kind)}
            >
              <span>{t.label}</span>
              <span className="nav-count">{totalFor(t.field)}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="nav-count" title={inventory?.userRoot}>
            전역: ~/.claude
          </div>
          <div className="nav-count" title={inventory?.projectRoot ?? '없음'}>
            프로젝트: {inventory?.projectRoot ? '있음' : '없음'}
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="toolbar">
          <input
            className="search"
            type="search"
            placeholder={`${activeTab.label} 검색 — 이름, 설명, 경로`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={`${activeTab.label} 검색`}
          />
          <button type="button" className="btn" onClick={() => void load()} disabled={loading}>
            {loading ? '읽는 중…' : '다시 읽기'}
          </button>
        </div>

        <div className="content">
          {notice && (
            <div className="banner" role="status">
              {notice}
            </div>
          )}

          {loadError && (
            <div className="banner banner-error" role="alert">
              스캔 실패: {loadError}
            </div>
          )}

          {inventory && inventory.issues.length > 0 && (
            <details className="banner">
              <summary>읽지 못한 파일 {inventory.issues.length}건 (나머지는 정상 표시됩니다)</summary>
              <ul>
                {inventory.issues.slice(0, 20).map((issue) => (
                  <li key={issue.path}>
                    {issue.path} — {issue.message}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {loading && !inventory && <div className="state">자산을 읽고 있습니다…</div>}

          {!loading && rows.length === 0 && (
            <div className="state">
              {query === ''
                ? `${activeTab.label} 자산이 없습니다.`
                : `"${query}" 와 일치하는 ${activeTab.label} 이 없습니다.`}
            </div>
          )}

          {rows.map((asset) => (
            <AssetRow
              key={`${asset.kind}:${asset.scope}:${asset.path}:${asset.name}`}
              asset={asset}
              onOpen={handleOpen}
              onReveal={handleReveal}
              onToggle={handleToggle}
              busy={asset.kind === 'plugin' && busyId === asset.id}
            />
          ))}
        </div>
      </main>
    </div>
  )
}
