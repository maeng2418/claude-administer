import { useCallback, useEffect, useMemo, useState } from 'react'
import { GroupedList } from './components/GroupedList.js'
import { ProjectPicker } from './components/ProjectPicker.js'
import type { Asset, AssetKind, Inventory, ProjectRef } from '../shared/types.js'

/** 사이드바 탭 정의. 순서가 화면 순서다. */
const TABS: { kind: AssetKind; label: string; field: keyof Inventory }[] = [
  { kind: 'skill', label: '스킬', field: 'skills' },
  { kind: 'command', label: '커맨드', field: 'commands' },
  { kind: 'agent', label: '에이전트', field: 'agents' },
  { kind: 'hook', label: '훅', field: 'hooks' },
  { kind: 'plugin', label: '플러그인', field: 'plugins' },
  { kind: 'mcp', label: 'MCP 서버', field: 'mcp' },
  { kind: 'marketplace', label: '마켓플레이스', field: 'marketplaces' }
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
    asset.kind === 'mcp' ? `${asset.transport} ${asset.command ?? ''}` : '',
    asset.kind === 'marketplace'
      ? `${asset.source} ${asset.origin ?? ''} ${asset.installLocation ?? ''}`
      : ''
  ]
  return haystack.join(' ').toLowerCase().includes(q)
}

/** 자산 하나를 토글할 때 쓸 키. 플러그인만 이름이 아니라 ID 를 쓴다. */
function toggleKeyFor(asset: Asset): string {
  return asset.kind === 'plugin' ? asset.id : asset.name
}

/**
 * 같은 자산을 가리키는 안정적이고 유일한 식별자.
 *
 * 훅은 이름도 경로도 유일하지 않다 — 전부 settings.json 을 가리키고,
 * 이름은 이벤트명(Stop, SessionStart …)이라 여러 개가 겹친다. 키가 겹치면
 * React 가 목록을 비교할 때 이전 탭의 행을 걷어내지 못하고 DOM 에 남긴다.
 * 스캐너가 매긴 index 를 붙여 유일성을 보장한다.
 */
function rowKeyFor(asset: Asset): string {
  const base = `${asset.kind}:${asset.scope}:${asset.path}:${asset.name}`
  return asset.kind === 'hook' ? `${base}:${asset.index}` : base
}

export function App(): React.JSX.Element {
  const [inventory, setInventory] = useState<Inventory | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<AssetKind>('skill')
  const [query, setQuery] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  /** 꺼진 자산만 보기. 검색과 함께 걸린다(둘 다 만족하는 것만 남는다). */
  const [offOnly, setOffOnly] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const [projects, setProjects] = useState<ProjectRef[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [projectIssues, setProjectIssues] = useState<number>(0)
  /** 프로젝트 탐색 중 생긴 문제. 개수만으로는 무엇이 문제인지 알 수 없다. */
  const [projectIssueDetail, setProjectIssueDetail] = useState<string>('')

  /** 자산을 다시 읽는다. 프로젝트 경로가 null 이면 전역만 읽는다. */
  const scan = useCallback(async (projectPath: string | null) => {
    setLoading(true)
    setLoadError(null)
    try {
      setInventory(await window.api.scan(projectPath))
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  /**
   * 프로젝트 목록을 읽고, 마지막으로 보던 프로젝트로 스캔한다.
   *
   * 첫 실행이라 기억된 선택이 없으면 전역만 읽는다 — 임의로 프로젝트를
   * 골라주면 어느 프로젝트를 보고 있는지 오해하게 된다.
   */
  const loadProjects = useCallback(async () => {
    try {
      const result = await window.api.listProjects()
      setProjects(result.projects)
      setProjectIssues(result.issues.length)
      setProjectIssueDetail(
        result.issues.map((i) => `${i.path} — ${i.message}`).join(' / ')
      )
      return result.lastSelected
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
      return null
    }
  }, [])

  useEffect(() => {
    void (async () => {
      const last = await loadProjects()
      setSelected(last)
      await scan(last)
    })()
  }, [loadProjects, scan])

  const handleSelect = useCallback(
    async (path: string | null) => {
      setSelected(path)
      setNotice(null)
      await scan(path)
    },
    [scan]
  )

  const handleAddProject = useCallback(async () => {
    const result = await window.api.addProject()
    if (result.error) {
      setNotice(`프로젝트 추가 실패: ${result.error}`)
      return
    }
    if (!result.added) return
    await loadProjects()
    setSelected(result.added.path)
    await scan(result.added.path)
    setNotice(`${result.added.name} 을(를) 목록에 추가했습니다.`)
  }, [loadProjects, scan])

  const handleRemoveProject = useCallback(
    async (path: string) => {
      const result = await window.api.removeProject(path)
      if (!result.ok) {
        setNotice(`프로젝트 제거 실패: ${result.error ?? '알 수 없는 오류'}`)
        return
      }
      await loadProjects()
      if (selected === path) {
        setSelected(null)
        await scan(null)
      }
    },
    [loadProjects, scan, selected]
  )

  /**
   * 플러그인 탭으로 이동해 해당 플러그인만 보여준다.
   *
   * 검색창에 ID 를 넣는 방식을 쓴다 — 별도 선택 상태를 두면 검색과 어긋나고,
   * 사용자가 왜 그 행만 보이는지 알 수 없게 된다. 검색어로 두면 보이는 그대로다.
   */
  const handleGoToPlugin = useCallback((pluginId: string) => {
    setTab('plugin')
    setQuery(pluginId)
    setNotice(`플러그인 "${pluginId}" 로 이동했습니다. 끄면 이 플러그인이 제공하는 자산도 함께 꺼집니다.`)
  }, [])

  /** 마켓플레이스에서 그 출처의 플러그인으로. 플러그인 ID 가 `<이름>@<출처>` 라 출처로 검색된다. */
  const handleGoToMarketplacePlugins = useCallback((marketplace: string) => {
    setTab('plugin')
    setQuery(`@${marketplace}`)
    setNotice(`"${marketplace}" 출처의 플러그인만 보여줍니다.`)
  }, [])

  const handleReveal = useCallback(async (path: string) => {
    const result = await window.api.revealPath(path)
    if (!result.ok) setNotice(`위치 열기 실패: ${result.error ?? '알 수 없는 오류'}`)
  }, [])

  /**
   * 자산 켜기/끄기. 성공하면 전체를 다시 스캔한다 —
   * 플러그인을 끄면 그것이 제공하는 스킬·커맨드 목록까지 바뀌므로
   * 부분 갱신은 화면과 실제가 어긋난다.
   */
  const handleToggle = useCallback(
    async (asset: Asset, next: boolean) => {
      const mechanism = asset.toggle?.mechanism
      if (!mechanism) return

      setBusyKey(rowKeyFor(asset))
      setNotice(null)
      const result = await window.api.toggleAsset({
        mechanism,
        key: toggleKeyFor(asset),
        enabled: next
      })
      if (result.ok) {
        setNotice(
          `${asset.name} ${next ? '켰습니다' : '껐습니다'}. 백업: ${
            result.backupPath ?? '없음'
          } · 변경은 Claude Code 재시작 후 적용됩니다.`
        )
        await scan(selected)
      } else {
        setNotice(`토글 실패: ${result.error ?? '알 수 없는 오류'}`)
      }
      setBusyKey(null)
    },
    [scan, selected]
  )

  /**
   * 자산 제거. 확인 대화는 main 에서 띄우므로 여기서는 결과만 처리한다.
   * 취소는 오류가 아니라 아무 일도 없던 것으로 둔다.
   */
  const handleRemove = useCallback(
    async (asset: Asset) => {
      const remove = asset.remove
      if (!remove?.mechanism || !remove.target) return

      setBusyKey(rowKeyFor(asset))
      setNotice(null)
      const result = await window.api.removeAsset({
        mechanism: remove.mechanism,
        target: remove.target,
        label: asset.name
      })
      if (result.ok) {
        setNotice(
          result.trashed
            ? `${asset.name} 을(를) 휴지통으로 보냈습니다. Finder 에서 "되돌리기" 로 복구할 수 있습니다.`
            : `${asset.name} 을(를) 제거했습니다. 변경은 Claude Code 재시작 후 적용됩니다.`
        )
        await scan(selected)
      } else if (!result.canceled) {
        setNotice(`제거 실패: ${result.error ?? '알 수 없는 오류'}`)
      }
      setBusyKey(null)
    },
    [scan, selected]
  )

  const activeTab = TABS.find((t) => t.kind === tab) ?? TABS[0]!

  /** 꺼진 자산 보기로 전환. 어느 탭에 몇 개인지 모르므로 스킬 탭부터 보여준다. */
  const showOffOnly = useCallback(() => {
    setOffOnly(true)
    setQuery('')
    setNotice(null)
  }, [])
  const rows = useMemo(() => {
    if (!inventory) return []
    const list = inventory[activeTab.field] as Asset[]
    return list.filter((a) => matches(a, query) && (!offOnly || a.disabled === true))
  }, [inventory, activeTab.field, query, offOnly])

  /**
   * 사이드바 집계.
   *
   * 탭별 개수와 달리 전체 자산을 가로질러 센다 — "지금 뭐가 꺼져 있나"는
   * 탭을 옮겨 다니며 찾을 질문이 아니다.
   */
  const stats = useMemo(() => {
    if (!inventory) return null
    const all = TABS.flatMap((t) => inventory[t.field] as Asset[])
    const byScope = { user: 0, project: 0, plugin: 0 }
    let off = 0
    for (const asset of all) {
      byScope[asset.scope]++
      if (asset.disabled === true) off++
    }
    return { total: all.length, off, byScope }
  }, [inventory])

  /** 마지막 스캔 시각을 시:분:초로. 날짜는 같은 날이 대부분이라 생략한다. */
  const scannedAtLabel = useMemo(() => {
    if (!inventory) return null
    const at = new Date(inventory.scannedAt)
    return Number.isNaN(at.getTime())
      ? null
      : at.toLocaleTimeString('ko-KR', { hour12: false })
  }, [inventory])

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

        <ProjectPicker
          projects={projects}
          selected={selected}
          disabled={loading}
          onSelect={handleSelect}
          onAdd={handleAddProject}
          onRemove={handleRemoveProject}
        />

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
          {/*
            상태: 지금 조치할 수 있는 유일한 항목. 아래 사실들과 떼어 둔다.
          */}
          {stats &&
            (stats.off > 0 ? (
              <button
                type="button"
                className={`foot-row foot-action${offOnly ? ' is-active' : ''}`}
                onClick={() => (offOnly ? setOffOnly(false) : showOffOnly())}
                title={
                  offOnly
                    ? '전체 자산을 다시 봅니다'
                    : '꺼진 자산만 걸러서 봅니다 (탭을 옮기면 그 탭의 꺼진 자산이 보입니다)'
                }
              >
                <span className="foot-label">꺼진 자산</span>
                <span className="foot-value foot-value-strong">
                  {offOnly ? '보는 중' : stats.off}
                </span>
              </button>
            ) : (
              <div className="foot-row">
                <span className="foot-label">꺼진 자산</span>
                <span className="foot-value">없음</span>
              </div>
            ))}

          {/* 맥락: 읽기만 하는 사실들. 서로 붙이고 한 단계 흐리게 둔다. */}
          <div className="foot-facts">
            {stats && (
              <div
                className="foot-row"
                title={`전역 ${stats.byScope.user} · 프로젝트 ${stats.byScope.project} · 플러그인 ${stats.byScope.plugin}`}
              >
                <span className="foot-label">범위</span>
                <span className="foot-value foot-scopes">
                  <b>{stats.byScope.user}</b>
                  <i>·</i>
                  <b>{stats.byScope.project}</b>
                  <i>·</i>
                  <b>{stats.byScope.plugin}</b>
                </span>
              </div>
            )}

            <div className="foot-row" title={inventory?.userRoot}>
              <span className="foot-label">전역</span>
              <span className="foot-value">~/.claude</span>
            </div>

            {scannedAtLabel && (
              <div className="foot-row" title={inventory?.scannedAt}>
                <span className="foot-label">스캔</span>
                <span className="foot-value">{scannedAtLabel}</span>
              </div>
            )}

            {projectIssues > 0 && (
              <button
                type="button"
                className="foot-row foot-action foot-warn"
                onClick={() => setNotice(projectIssueDetail)}
                title="프로젝트를 찾는 중 생긴 문제를 봅니다"
              >
                <span className="foot-label">탐색 경고</span>
                <span className="foot-value">{projectIssues}</span>
              </button>
            )}
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
          <button
            type="button"
            className="btn"
            onClick={() => void scan(selected)}
            disabled={loading}
          >
            {loading ? '읽는 중…' : '다시 읽기'}
          </button>
        </div>

        <div className="content">
          {offOnly && (
            <div className="banner banner-filter" role="status">
              <span>꺼진 자산만 보고 있습니다.</span>
              <button type="button" className="btn btn-sm" onClick={() => setOffOnly(false)}>
                전체 보기
              </button>
            </div>
          )}

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

          {tab === 'marketplace' && inventory && (
            <div className="banner">
              레지스트리 {inventory.marketplaces.length}곳 · 설치된 플러그인{' '}
              {inventory.plugins.length}개. 플러그인 0개인 출처는 등록만 되어 있고 쓰이지
              않습니다.
            </div>
          )}

          {loading && !inventory && <div className="state">자산을 읽고 있습니다…</div>}

          {!loading && rows.length === 0 && (
            <div className="state">
              {offOnly
                ? `이 탭에는 꺼진 ${activeTab.label} 이 없습니다. 다른 탭을 눌러보세요.`
                : query === ''
                  ? `${activeTab.label} 자산이 없습니다.`
                  : `"${query}" 와 일치하는 ${activeTab.label} 이 없습니다.`}
            </div>
          )}

          <GroupedList
            assets={rows}
            plugins={inventory?.plugins ?? []}
            searching={query !== ''}
            onReveal={handleReveal}
            onToggle={handleToggle}
            onGoToPlugin={handleGoToPlugin}
            onGoToMarketplacePlugins={handleGoToMarketplacePlugins}
            onRemove={handleRemove}
            busyKey={busyKey}
            rowKeyFor={rowKeyFor}
          />
        </div>
      </main>
    </div>
  )
}
