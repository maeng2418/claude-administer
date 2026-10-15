import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CatalogPlugin, CatalogResult, PluginOpResult } from '../../shared/types.js'

/**
 * 플러그인 설치 창.
 *
 * 검색 먼저인 이유는 규모다. 실측 2,620개가 있고 그중 한 출처가 2,282개를
 * 차지한다 — 처음부터 전부 그리면 스크롤로는 찾을 수 없고, 렌더 비용만
 * 든다. 그래서 두 자 이상 입력했을 때만 결과를 그린다.
 *
 * 빈 화면에 안내만 두는 것이 불친절해 보일 수 있지만, 대안(2,620줄을
 * 늘어놓기)은 찾기를 더 어렵게 만든다. 대신 어디서 찾는지(출처 수와
 * 전체 개수)를 적어 무엇을 검색하는지 알 수 있게 한다.
 */

/** 검색을 시작하는 최소 글자 수. */
const MIN_QUERY = 2

/**
 * 한 번에 그리는 최대 결과 수.
 *
 * 'a' 같은 짧은 검색어는 수백 건에 걸린다. 전부 그리면 입력할 때마다
 * 수백 개의 DOM 노드를 다시 만들어 타이핑이 끊긴다. 상한을 두고 몇 건이
 * 더 있는지 알려주는 편이 낫다.
 */
const MAX_ROWS = 60

export function AddPlugin({
  onLoad,
  onInstall,
  onClose
}: {
  /** 카탈로그를 읽는다. 창을 열 때 한 번 부른다. */
  onLoad: () => Promise<CatalogResult>
  onInstall: (plugin: string) => Promise<PluginOpResult>
  onClose: () => void
}): React.JSX.Element {
  const [catalog, setCatalog] = useState<CatalogResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  /** 설치 중인 플러그인 ID. 한 번에 하나만 돌린다. */
  const [installing, setInstalling] = useState<string | null>(null)
  /** 설치 결과를 ID 별로 쌓는다 — 여러 개를 연달아 설치하면 각 줄에 남는다. */
  const [results, setResults] = useState<Map<string, PluginOpResult>>(new Map())
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void (async () => {
      setCatalog(await onLoad())
      setLoading(false)
      inputRef.current?.focus()
    })()
  }, [onLoad])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 설치 중에는 닫지 않는다 — CLI 가 계속 돌고 결과를 받을 자리가 없어진다.
      if (e.key === 'Escape' && installing === null) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [installing, onClose])

  /**
   * 아직 설치하지 않은 플러그인.
   *
   * 설치된 것은 목록에서 아예 뺀다. 이 창은 "설치할 것을 고르는" 자리라
   * 이미 가진 것은 고를 수 없는 항목이고, 그런 행이 섞이면 세어 본 개수와
   * 실제로 누를 수 있는 개수가 달라진다. 이미 설치한 플러그인은 플러그인
   * 탭에서 본다.
   *
   * 이 창을 연 뒤에 설치한 것도 함께 뺀다 — 방금 설치한 행이 '설치됨' 인
   * 채로 남아 있는 것보다 목록에서 사라지는 쪽이 결과가 분명하다.
   */
  const installable = useMemo(() => {
    if (!catalog) return []
    return catalog.plugins.filter(
      (p) => !p.installed && results.get(`${p.name}@${p.marketplace}`)?.ok !== true
    )
  }, [catalog, results])

  /**
   * 검색어가 없을 때 보여줄 기본 목록.
   *
   * 출처를 번갈아 가며 한 개씩 뽑는다. 이름순으로 자르면 상한 60개가
   * 거의 전부 한 출처로 채워진다 — 실측 미설치 2,606개 중 2,281개가
   * claude-community 한 곳이라, 나머지 다섯 곳은 아예 보이지 않는다.
   * 번갈아 뽑으면 어떤 출처들이 있는지가 첫 화면에서 드러난다.
   */
  const browse = useMemo(() => {
    // 출처별로 나눈다. 각 묶음 안은 카탈로그가 이미 이름순이다.
    const bySource = new Map<string, CatalogPlugin[]>()
    for (const plugin of installable) {
      const bucket = bySource.get(plugin.marketplace)
      if (bucket) bucket.push(plugin)
      else bySource.set(plugin.marketplace, [plugin])
    }

    // 출처 이름순으로 돌아가며 한 개씩. 바닥난 출처는 자연히 빠진다.
    const sources = [...bySource.keys()].sort((a, b) => a.localeCompare(b))
    const rows: CatalogPlugin[] = []
    for (let i = 0; rows.length < MAX_ROWS; i++) {
      let added = false
      for (const source of sources) {
        const bucket = bySource.get(source)!
        const plugin = bucket[i]
        if (!plugin) continue
        rows.push(plugin)
        added = true
        if (rows.length >= MAX_ROWS) break
      }
      // 모든 출처가 바닥났다. 더 돌아도 나올 것이 없다.
      if (!added) break
    }
    return { total: installable.length, rows }
  }, [installable])

  /** 검색 결과. 이름이 앞에서 걸리는 것을 위로 올린다. */
  const found = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length < MIN_QUERY) return null

    const hits: { plugin: CatalogPlugin; rank: number }[] = []
    for (const plugin of installable) {
      const name = plugin.name.toLowerCase()
      // 이름 우선. 설명까지 보면 결과가 넓어지지만 순위를 낮춘다 —
      // 이름이 일치하는 것을 설명 때문에 밀어내면 찾던 것이 아래로 간다.
      if (name.startsWith(q)) hits.push({ plugin, rank: 0 })
      else if (name.includes(q)) hits.push({ plugin, rank: 1 })
      else if ((plugin.description ?? '').toLowerCase().includes(q)) {
        hits.push({ plugin, rank: 2 })
      }
    }
    hits.sort((a, b) => a.rank - b.rank || a.plugin.name.localeCompare(b.plugin.name))
    return { total: hits.length, rows: hits.slice(0, MAX_ROWS).map((h) => h.plugin) }
  }, [installable, query])

  /**
   * 화면에 그릴 목록. 검색 중이면 검색 결과, 아니면 둘러보기 목록.
   *
   * 한 변수로 합치는 이유: 아래 렌더가 두 경우를 똑같이 그리기 때문이다.
   * 나눠 두면 같은 줄을 두 번 쓰게 된다.
   */
  const searching = found !== null
  const matches = found ?? browse

  const install = useCallback(
    async (plugin: CatalogPlugin) => {
      const id = `${plugin.name}@${plugin.marketplace}`
      setInstalling(id)
      const result = await onInstall(id)
      setResults((prev) => new Map(prev).set(id, result))
      setInstalling(null)
    },
    [onInstall]
  )

  const sourceCount = useMemo(() => {
    if (!catalog) return 0
    return new Set(catalog.plugins.map((p) => p.marketplace)).size
  }, [catalog])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && installing === null) onClose()
      }}
    >
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label="플러그인 설치">
        <div className="modal-head">
          <div className="modal-title">플러그인 설치</div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onClose}
            disabled={installing !== null}
          >
            닫기
          </button>
        </div>

        <input
          ref={inputRef}
          className="search modal-input"
          type="search"
          placeholder="플러그인 이름이나 설명으로 검색 — 두 글자 이상"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={loading}
          aria-label="플러그인 검색"
          spellCheck={false}
        />

        {loading && <div className="state">카탈로그를 읽고 있습니다…</div>}

        {!loading && matches.rows.length === 0 && (
          <div className="state">
            {searching
              ? `"${query}" 와 일치하는, 아직 설치하지 않은 플러그인이 없습니다.`
              : '설치할 수 있는 플러그인이 없습니다. 마켓플레이스의 플러그인을 모두 설치했습니다.'}
          </div>
        )}

        {!loading && matches.rows.length > 0 && (
          <>
            <div className="modal-count">
              {searching
                ? `${matches.total}건${
                    matches.total > MAX_ROWS ? ` 중 ${MAX_ROWS}건 표시 — 검색어를 좁혀 보세요` : ''
                  }`
                : `설치 가능 ${matches.total}개 · 마켓플레이스 ${sourceCount}곳${
                    matches.total > MAX_ROWS
                      ? ` — 출처별로 ${MAX_ROWS}개만 보여줍니다. 찾는 것이 있으면 검색하세요`
                      : ''
                  }`}
            </div>
            <div className="modal-list">
              {matches.rows.map((plugin) => {
                const id = `${plugin.name}@${plugin.marketplace}`
                // 설치에 성공한 행은 목록에서 빠지므로, 여기 남는 결과는
                // 실패뿐이다. 그 사유를 행 안에 붙여 어느 것이 실패했는지 남긴다.
                const result = results.get(id)
                return (
                  <div className="row" key={id}>
                    <div className="row-main">
                      <div className="row-head">
                        <span className="row-name">{plugin.name}</span>
                        <span className="chip">{plugin.marketplace}</span>
                        {plugin.category && <span className="chip">{plugin.category}</span>}
                      </div>
                      {plugin.description && (
                        <div className="row-desc" title={plugin.description}>
                          {plugin.description}
                        </div>
                      )}
                      {result && !result.ok && (
                        <div className="row-desc row-error">
                          설치 실패: {result.error ?? '알 수 없는 오류'}
                        </div>
                      )}
                    </div>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn btn-sm btn-on"
                        disabled={installing !== null}
                        onClick={() => void install(plugin)}
                        title={`${id} 를 claude plugin install 로 설치합니다. (Claude Code 재시작 후 적용)`}
                      >
                        {installing === id ? '설치 중…' : '설치'}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {catalog && catalog.issues.length > 0 && (
          <details className="banner">
            <summary>읽지 못한 카탈로그 {catalog.issues.length}건</summary>
            <ul>
              {catalog.issues.slice(0, 10).map((issue) => (
                <li key={issue.path}>
                  {issue.path} — {issue.message}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  )
}
