import { useCallback, useEffect, useMemo, useState } from 'react'
import { AddMarketplace } from './components/AddMarketplace.js'
import { AddPlugin } from './components/AddPlugin.js'
import { Banner } from './components/Banner.js'
import { GroupedList } from './components/GroupedList.js'
import { PlusIcon, RefreshIcon } from './components/Icons.js'
import { ProjectManager } from './components/ProjectManager.js'
import { ProjectPicker } from './components/ProjectPicker.js'
import { UsagePanel } from './components/UsagePanel.js'
import { verdictFor } from './usage-verdict.js'
import type {
  Asset,
  AssetKind,
  Inventory,
  MarketplaceAsset,
  ProjectRef,
  UsageReadResult,
  UsageStats
} from '../shared/types.js'

/** 사이드바 탭 정의. 순서가 화면 순서다. */
const TABS: { kind: AssetKind; label: string; field: keyof Inventory }[] = [
  { kind: 'skill', label: '스킬', field: 'skills' },
  { kind: 'command', label: '커맨드', field: 'commands' },
  { kind: 'agent', label: '에이전트', field: 'agents' },
  { kind: 'hook', label: '훅', field: 'hooks' },
  { kind: 'plugin', label: '플러그인', field: 'plugins' },
  { kind: 'mcp', label: 'MCP 서버', field: 'mcp' },
  { kind: 'marketplace', label: '마켓플레이스', field: 'marketplaces' },
  { kind: 'rule', label: '규칙', field: 'rules' }
]

/**
 * 사용 판정이 가능한 탭.
 *
 * 호출 기록이 남는 자산만이다. 플러그인·MCP·마켓플레이스는 설치
 * 단위라 호출이 없고, 규칙은 컨텍스트 주입이라 기록이 남지 않는다.
 */
const USAGE_TABS = new Set<AssetKind>([
  'skill',
  'command',
  'agent',
  'hook',
  'plugin',
  'mcp'
])

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
      : '',
    asset.kind === 'rule' ? `${asset.relativePath} ${asset.paths ?? ''}` : ''
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
  /**
   * 읽기 실패 경고를 닫았는지.
   *
   * notice 와 달리 이 내용은 inventory 안에 있어서 지울 수가 없다. 닫힘
   * 여부를 따로 들고 있다가, 다시 스캔하면 푼다 — 새 스캔은 새 소식이고,
   * 한 번 닫았다고 다음 실패까지 묻어버리면 문제를 놓친다.
   */
  const [issuesClosed, setIssuesClosed] = useState(false)

  const [projects, setProjects] = useState<ProjectRef[]>([])
  const [hiddenProjects, setHiddenProjects] = useState<ProjectRef[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [projectIssues, setProjectIssues] = useState<number>(0)
  /** 프로젝트 탐색 중 생긴 문제. 개수만으로는 무엇이 문제인지 알 수 없다. */
  const [projectIssueDetail, setProjectIssueDetail] = useState<string>('')
  /** 프로젝트 관리 창이 열려 있는지. */
  const [managing, setManaging] = useState(false)
  /** 마켓플레이스 추가 창이 열려 있는지. */
  const [addingMarketplace, setAddingMarketplace] = useState(false)
  /** 플러그인 설치 창이 열려 있는지. */
  const [addingPlugin, setAddingPlugin] = useState(false)

  /** 구독 사용량. 아직 안 읽었으면 null — 패널이 자리만 비워둔다. */
  const [usage, setUsage] = useState<UsageReadResult | null>(null)
  const [usageLoading, setUsageLoading] = useState(false)

  /** 자산 사용량 집계. 세션 기록을 훑으므로 화면이 뜬 뒤 따로 읽는다. */
  const [usageStats, setUsageStats] = useState<UsageStats | null>(null)

  /** 자산을 다시 읽는다. 프로젝트 경로가 null 이면 전역만 읽는다. */
  const scan = useCallback(async (projectPath: string | null) => {
    setLoading(true)
    setLoadError(null)
    setIssuesClosed(false)
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
  const loadProjects = useCallback(async (refresh = false) => {
    try {
      const result = await window.api.listProjects(refresh)
      setProjects(result.projects)
      setHiddenProjects(result.hidden)
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

  /**
   * 사용량을 다시 읽는다.
   *
   * 스캔과 분리한 이유는 서로 상관이 없기 때문이다 — 사용량은 프로젝트와
   * 무관하고, 읽기 실패가 자산 목록을 가려서는 안 된다. 실패는 패널 안에서
   * 말한다(상단 배너를 쓰지 않는다).
   */
  const loadUsage = useCallback(async (silent = false, force = false) => {
    // 자동 갱신은 조용히 돈다. 1분마다 "읽는 중…" 이 깜빡이면 가만히 있는
    // 화면이 분주해 보이고, 사용자가 누르지 않은 동작이라 보고할 것도 없다.
    if (!silent) setUsageLoading(true)
    try {
      setUsage(await window.api.readUsage(force))
    } catch (err) {
      setUsage({
        ok: false,
        reason: 'network',
        error: err instanceof Error ? err.message : String(err)
      })
    } finally {
      if (!silent) setUsageLoading(false)
    }
  }, [])

  /*
    사용량 집계는 스캔과 분리해서 읽는다. 세션 기록 600개를 훑어 실측
    5초가 걸리는데, 그동안 자산 목록까지 비어 있으면 앱이 멈춘 것처럼
    보인다. 목록을 먼저 띄우고 배지는 나중에 채운다.
  */
  useEffect(() => {
    void (async () => {
      try {
        setUsageStats(await window.api.readUsageStats())
      } catch {
        // 집계 실패는 배지가 안 뜨는 것으로 끝난다. 목록은 그대로 쓸 수 있다.
      }
    })()
  }, [])

  useEffect(() => {
    void (async () => {
      const last = await loadProjects()
      setSelected(last)
      await scan(last)
    })()
  }, [loadProjects, scan])

  /**
   * 사용량 자동 갱신.
   *
   * 창이 보일 때만 돈다. 가려져 있는 동안의 요청은 아무도 읽지 않는 숫자를
   * 가져오는 일이라 그냥 낭비다 — 다시 보이는 순간 한 번 당겨오면 화면은
   * 어차피 최신이 된다.
   *
   * 조회는 읽기 전용이라 구독 사용량을 쓰지 않는다. 그래서 주기를 짧게
   * 둘 수 있지만, 숫자가 분 단위로 움직이므로 1분이면 충분하다.
   */
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null

    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }

    const start = (): void => {
      if (timer !== null) return
      timer = setInterval(() => void loadUsage(true), 60_000)
    }

    const onVisibility = (): void => {
      if (document.hidden) {
        stop()
        return
      }
      // 가려져 있던 동안 값이 묵었다. 재개 전에 한 번 당겨온다.
      void loadUsage(true)
      start()
    }

    // 첫 조회는 사용자가 기다리는 상황이라 로딩 표시를 보여준다.
    void loadUsage()
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [loadUsage])

  /**
   * 화면 전체를 최신으로. 자산뿐 아니라 프로젝트 목록도 다시 훑는다 —
   * 앱을 띄운 뒤 다른 프로젝트에서 Claude Code 를 쓰면 그 프로젝트가
   * 세션 기록에 새로 생기기 때문이다.
   */
  const refreshAll = useCallback(async () => {
    await loadProjects(true)
    await scan(selected)
    await loadUsage()
  }, [loadProjects, loadUsage, scan, selected])

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
    setNotice(`${result.added.name} 을(를) 목록에 추가했습니다.`)
  }, [loadProjects, scan])

  const handleRemoveProject = useCallback(
    async (path: string) => {
      const target = projects.find((p) => p.path === path)
      const result = await window.api.removeProject(path)
      if (!result.ok) {
        setNotice(`프로젝트 제거 실패: ${result.error ?? '알 수 없는 오류'}`)
        return
      }
      await loadProjects()
      setNotice(
        target?.origin === 'added'
          ? `${target.name} 등록을 지웠습니다. 폴더는 그대로입니다.`
          : `${target?.name ?? path} 을(를) 가렸습니다. 관리 창에서 되돌릴 수 있습니다.`
      )
      if (selected === path) {
        setSelected(null)
        await scan(null)
      }
    },
    [loadProjects, projects, scan, selected]
  )

  const handleRestoreProject = useCallback(
    async (path: string) => {
      const result = await window.api.restoreProject(path)
      if (!result.ok) {
        setNotice(`되돌리기 실패: ${result.error ?? '알 수 없는 오류'}`)
        return
      }
      await loadProjects()
    },
    [loadProjects]
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

  /**
   * 마켓플레이스 자동 갱신 켜기/끄기.
   *
   * 토글 메커니즘을 따로 쓰므로 handleToggle 과 합치지 않는다 — 그쪽은
   * asset.toggle.mechanism 을 보는데, 마켓플레이스 행의 toggle 은 비어
   * 있고(끄는 개념이 없다) 자동 갱신은 별도 키를 쓴다.
   */
  const handleAutoUpdate = useCallback(
    async (asset: MarketplaceAsset, next: boolean) => {
      setBusyKey(rowKeyFor(asset))
      setNotice(null)
      const result = await window.api.toggleAsset({
        mechanism: 'marketplaceAutoUpdate',
        key: asset.name,
        enabled: next
      })
      if (result.ok) {
        setNotice(
          `${asset.name} 자동 갱신을 ${next ? '켰습니다' : '껐습니다'}. 백업: ${
            result.backupPath ?? '없음'
          } · 다음 세션부터 적용됩니다.`
        )
        await scan(selected)
      } else {
        setNotice(`자동 갱신 변경 실패: ${result.error ?? '알 수 없는 오류'}`)
      }
      setBusyKey(null)
    },
    [scan, selected]
  )

  /**
   * 지금 갱신. 마켓플레이스면 출처에서 다시 받아오고, 플러그인이면
   * 최신 버전으로 올린다.
   *
   * 결과 문구를 두 경우로 나눈다 — 플러그인 갱신은 "이미 최신" 이
   * 실패가 아니라 정상 결과이고, 그것을 "갱신했습니다" 로 말하면
   * 바뀌지 않았는데 바뀐 줄로 읽는다.
   */
  const handleUpdateNow = useCallback(
    async (asset: Asset) => {
      if (asset.kind !== 'marketplace' && asset.kind !== 'plugin') return

      setBusyKey(rowKeyFor(asset))
      setNotice(null)

      const result =
        asset.kind === 'marketplace'
          ? await window.api.updateMarketplace(asset.name)
          : await window.api.updatePlugin(asset.id)

      if (!result.ok) {
        setNotice(`갱신 실패: ${result.error ?? '알 수 없는 오류'}`)
        setBusyKey(null)
        return
      }

      if (result.updateOutcome === 'up_to_date') {
        setNotice(`${asset.name} 은(는) 이미 최신입니다${
          result.newVersion ? ` (${result.newVersion})` : ''
        }.`)
      } else if (result.updateOutcome === 'updated') {
        setNotice(
          `${asset.name} 을(를) ${result.oldVersion ?? '이전'} → ${
            result.newVersion ?? '최신'
          } 으로 올렸습니다. Claude Code 재시작 후 적용됩니다.`
        )
      } else {
        setNotice(`${asset.name} 을(를) 갱신했습니다.`)
      }

      await scan(selected)
      setBusyKey(null)
    },
    [scan, selected]
  )

  /** 마켓플레이스를 추가한다. 성공하면 목록을 다시 읽는다. */
  const handleAddMarketplace = useCallback(
    async (source: string) => {
      const result = await window.api.addMarketplace(source)
      if (result.ok) await scan(selected)
      return result
    },
    [scan, selected]
  )

  /**
   * 카탈로그를 읽는다.
   *
   * useCallback 으로 감싸는 이유: AddPlugin 이 이 함수를 effect 의존성으로
   * 쓴다. 인라인 화살표 함수를 넘기면 App 이 다시 그려질 때마다 새 함수가
   * 되어 effect 가 다시 돌고, 그 안의 setState 가 또 렌더를 부른다 —
   * 끝나지 않는 되먹임이 된다.
   */
  const handleLoadCatalog = useCallback(() => window.api.listCatalog(), [])

  /** 플러그인을 설치한다. 성공하면 목록을 다시 읽는다. */
  const handleInstallPlugin = useCallback(
    async (plugin: string) => {
      const result = await window.api.installPlugin(plugin)
      if (result.ok) await scan(selected)
      return result
    },
    [scan, selected]
  )

  /** 모든 마켓플레이스를 한 번에 갱신한다. */
  const handleUpdateAllMarketplaces = useCallback(async () => {
    setLoading(true)
    setNotice(null)
    const result = await window.api.updateMarketplace()
    setLoading(false)
    setNotice(
      result.ok
        ? '모든 마켓플레이스를 갱신했습니다.'
        : `전체 갱신 실패: ${result.error ?? '알 수 없는 오류'}`
    )
    if (result.ok) await scan(selected)
  }, [scan, selected])

  /**
   * 행 하나의 사용 판정.
   *
   * 수정 시각을 함께 넘긴다. 없으면 0회가 전부 레거시로 떨어져
   * 실측에서 157개가 "미사용" 으로 찍혔다 — 방금 설치한 것까지 포함해서다.
   */
  /**
   * 플러그인 판정에 쓸 전체 자산.
   *
   * 플러그인은 직접 호출되지 않아 제공 자산의 호출로 역산한다 —
   * 그러려면 어느 자산이 그 플러그인에서 왔는지 전부 볼 수 있어야 한다.
   */
  const allAssets = useMemo(
    () =>
      inventory
        ? [
            ...inventory.skills,
            ...inventory.commands,
            ...inventory.agents,
            ...inventory.mcp
          ]
        : [],
    [inventory]
  )

  const assetVerdict = useCallback(
    (asset: Asset) =>
      usageStats
        ? verdictFor(asset, usageStats, asset.modifiedAt, allAssets)
        : null,
    [usageStats, allAssets]
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

  /**
   * 규칙 집계 — 매 세션 나가는 비용.
   *
   * 조건부 규칙은 합계에 넣지 않는다. 그쪽은 해당 파일을 다룰 때만
   * 따라오므로, 함께 더하면 "항상 드는 비용" 이 실제보다 커 보인다.
   */
  const ruleStats = useMemo(() => {
    const rules = inventory?.rules ?? []
    const always = rules.filter((r) => r.alwaysLoaded)
    const bytes = always.reduce((n, r) => n + r.bytes, 0)
    const tokens = always.reduce((n, r) => n + r.estimatedTokens, 0)
    return {
      always: always.length,
      size: bytes < 1024 ? `${bytes}B` : `${Math.round(bytes / 1024)}KB`,
      tokens: tokens < 1000 ? `${tokens}` : `${Math.round(tokens / 1000)}K`
    }
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
      {managing && (
        <ProjectManager
          projects={projects}
          hidden={hiddenProjects}
          selected={selected}
          busy={loading}
          onSelect={(path) => {
            void handleSelect(path)
            setManaging(false)
          }}
          onAdd={() => void handleAddProject()}
          onRemove={(path) => void handleRemoveProject(path)}
          onRestore={(path) => void handleRestoreProject(path)}
          onClose={() => setManaging(false)}
        />
      )}

      {addingMarketplace && (
        <AddMarketplace
          onAdd={handleAddMarketplace}
          onClose={() => setAddingMarketplace(false)}
        />
      )}

      {addingPlugin && (
        <AddPlugin
          onLoad={handleLoadCatalog}
          onInstall={handleInstallPlugin}
          onClose={() => setAddingPlugin(false)}
        />
      )}

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
          onManage={() => setManaging(true)}
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
                role="switch"
                aria-checked={offOnly}
                className={`foot-row foot-action${offOnly ? ' is-active' : ''}`}
                onClick={() => (offOnly ? setOffOnly(false) : showOffOnly())}
                title={
                  offOnly
                    ? '전체 자산을 다시 봅니다'
                    : '꺼진 자산만 걸러서 봅니다 (탭을 옮기면 그 탭의 꺼진 자산이 보입니다)'
                }
              >
                <span className="foot-label">
                  꺼진 자산 보기
                  <span className="foot-badge">{stats.off}</span>
                </span>
                <span className={`switch-track${offOnly ? ' is-on' : ''}`}>
                  <span className="switch-thumb" />
                </span>
              </button>
            ) : (
              <div className="foot-row">
                <span className="foot-label">꺼진 자산</span>
                <span className="foot-value">없음</span>
              </div>
            ))}

          {/*
            사용량: 상태(위)와 맥락(아래) 사이. 조치할 수 있는 항목은 아니지만
            자산 경로처럼 늘 그대로인 사실도 아니다 — 시간에 따라 변하고
            넘치기 전에 알아차려야 하므로 묻히지 않는 자리에 둔다.
          */}
          <UsagePanel
            usage={usage}
            loading={usageLoading}
            onRefresh={() => void loadUsage(false, true)}
          />

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
          {/*
            추가 버튼은 보고 있는 탭에만 둔다. 두 버튼을 늘 띄우면 스킬
            목록을 보는 중에도 "플러그인 설치" 가 보여서, 지금 화면과
            상관없는 동작이 상관있는 것처럼 읽힌다.
          */}
          {tab === 'marketplace' && (
            <>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setAddingMarketplace(true)}
                title="GitHub 저장소나 로컬 폴더를 마켓플레이스로 등록합니다"
              >
                <PlusIcon />
                마켓플레이스 추가
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void handleUpdateAllMarketplaces()}
                disabled={loading}
                title="등록된 모든 마켓플레이스를 출처에서 다시 받아옵니다"
              >
                전체 갱신
              </button>
            </>
          )}
          {tab === 'plugin' && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setAddingPlugin(true)}
              title="마켓플레이스에서 플러그인을 찾아 설치합니다"
            >
              <PlusIcon />
              플러그인 설치
            </button>
          )}

          {/*
            검색창에서 떼어 오른쪽 끝에 둔다. 이 버튼이 하는 일은 검색 범위를
            넘어선다 — 프로젝트 목록, 자산 스캔, 사용량을 모두 다시 읽는다.
            검색창에 붙여두면 "검색 결과를 새로 고친다"로 읽힌다.

            아이콘만 두는 이유는 뜻이 보편적이고 title/aria-label 이 이름을
            말해주기 때문이다 — 아이콘 자체는 장식이다.
          */}
          <button
            type="button"
            className="btn btn-icon btn-icon-lg toolbar-end"
            onClick={() => void refreshAll()}
            disabled={loading}
            title="프로젝트 목록, 자산, 사용량을 모두 다시 읽습니다"
            aria-label="다시 읽기"
          >
            {loading ? <span className="btn-spin" /> : <RefreshIcon />}
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

          {notice && <Banner onClose={() => setNotice(null)}>{notice}</Banner>}

          {loadError && (
            <Banner tone="error" role="alert" onClose={() => setLoadError(null)}>
              스캔 실패: {loadError}
            </Banner>
          )}

          {inventory && inventory.issues.length > 0 && !issuesClosed && (
            <Banner onClose={() => setIssuesClosed(true)}>
              <details>
                <summary>
                  읽지 못한 파일 {inventory.issues.length}건 (나머지는 정상 표시됩니다)
                </summary>
                <ul>
                  {inventory.issues.slice(0, 20).map((issue) => (
                    <li key={issue.path}>
                      {issue.path} — {issue.message}
                    </li>
                  ))}
                </ul>
              </details>
            </Banner>
          )}

          {/*
            집계 범위 고지.

            "미사용" 배지가 뜨는 탭에만 둔다. 이 배지는 "최근 N일 기록에
            호출이 없다" 는 뜻이지 "쓸모없다" 가 아닌데, 그 N 을 모르면
            사용자가 전자를 후자로 읽는다. 기록은 보존 기간이 지나면
            지워지므로, 그 숫자가 곧 판정의 한계다.
          */}
          {usageStats && USAGE_TABS.has(tab) && (
            <div className="content-note">
              사용 판정은 최근 <b>{usageStats.retentionDays}일</b> 기록(세션{' '}
              {usageStats.sessionsScanned}개
              {usageStats.sessionsTotal > usageStats.sessionsScanned
                ? ` / ${usageStats.sessionsTotal}개 중`
                : ''}
              ) 기준입니다
              {usageStats.retentionSource === 'default'
                ? ' (Claude Code 기본값)'
                : usageStats.retentionSource === 'project'
                  ? ' (프로젝트 설정)'
                  : usageStats.retentionSource === 'managed'
                    ? ' (관리자 정책)'
                    : ' (사용자 설정)'}
              . 더 오래된 기록은 Claude Code 가 지우므로,{' '}
              <b>미사용</b>은 &quot;그 기간에 안 쓰였다&quot;는 뜻입니다 — 분기에 한 번
              쓰는 자산도 여기 들어옵니다.
            </div>
          )}

          {/*
            탭 설명. 작업 결과가 아니라 늘 참인 사실이라 배너로 두지 않는다 —
            배너는 닫을 수 있어야 하는데, 이건 닫으면 되살릴 방법이 없다.
            목록 위에 흐린 작은 글씨로 두어 필요할 때 읽히되 알림과 섞이지 않게 한다.
          */}
          {/*
            규칙 탭의 요약. 이 탭의 존재 이유가 "무엇이 매 세션 컨텍스트를
            먹는가" 이므로, 개별 행보다 이 합계가 먼저 읽혀야 한다.
          */}
          {tab === 'rule' && inventory && inventory.rules.length > 0 && (
            <div className="content-note">
              규칙 {inventory.rules.length}개 · 그중 <b>{ruleStats.always}개는 매 세션
              로드</b>되어 약 {ruleStats.tokens} 토큰을 먼저 씁니다 (
              {ruleStats.size}). 나머지 {inventory.rules.length - ruleStats.always}개는
              frontmatter 의 <code>paths:</code> 에 걸리는 파일을 다룰 때만 따라옵니다.
              토큰은 바이트를 4로 나눈 어림값입니다.
            </div>
          )}

          {tab === 'marketplace' && inventory && (
            <div className="content-note">
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
            verdictFor={assetVerdict}
            onAutoUpdate={(asset, next) => void handleAutoUpdate(asset, next)}
            onUpdateNow={(asset) => void handleUpdateNow(asset)}
            busyKey={busyKey}
            rowKeyFor={rowKeyFor}
          />
        </div>
      </main>
    </div>
  )
}
