import type { Asset, AssetUsage, UsageStats, UsageVerdict } from '../shared/types.js'

/**
 * 자산이 쓰이는지 판정한다.
 *
 * 목적이 "안 쓰는 것을 지우기" 이므로, 틀렸을 때의 비용이 비대칭이다.
 * 쓰는 것을 레거시로 잘못 찍으면 사용자가 멀쩡한 자산을 지운다.
 * 안 쓰는 것을 놓치면 그냥 다음에 또 보면 된다. 그래서 의심스러우면
 * 레거시가 아니라 '판단 보류' 로 보낸다.
 */

/** 판정 하나. */
export interface VerdictResult {
  verdict: UsageVerdict
  /** 스캔 구간 안에서의 호출 횟수. */
  count: number
  lastUsedAt?: string
  /** 왜 이렇게 판정했는지. 화면 툴팁에 그대로 쓴다. */
  reason: string
}

/**
 * 기록 구간보다 이만큼 오래된 파일만 레거시 후보로 본다.
 *
 * 기록이 22일치인데 20일 전에 설치한 자산은 "안 쓴" 것이 아니라
 * "쓸 기회가 적었던" 것이다. 여유를 두어 그런 자산을 보류로 보낸다.
 */
const SETTLE_DAYS = 7

/** 자산 종류별로 사용량 맵을 고른다. 규칙은 측정 대상이 아니다. */
function usageFor(stats: UsageStats, asset: Asset): Record<string, AssetUsage> | null {
  switch (asset.kind) {
    case 'skill':
      return stats.skills
    case 'command':
      return stats.commands
    case 'agent':
      return stats.agents
    case 'hook':
      return stats.hooks
    case 'mcp':
      return stats.mcp
    default:
      /*
        플러그인·마켓플레이스·규칙은 이 맵으로 못 푼다. 플러그인은
        아래에서 제공 자산을 합산해 따로 판정하고, 마켓플레이스는
        플러그인의 출처일 뿐이며, 규칙은 호출 자체가 없다.
      */
      return null
  }
}

/**
 * 플러그인이 실제로 쓰이는지, 그것이 제공한 자산의 호출로 역산한다.
 *
 * 플러그인은 직접 호출되는 대상이 아니다. 스킬·커맨드·에이전트·MCP 를
 * 제공할 뿐이라, 그중 하나라도 쓰였으면 그 플러그인은 쓰인 것이다.
 *
 * MCP 를 빼먹으면 안 된다. 실측에서 project-plugin 은 스킬·커맨드 호출이
 * 0회인데 MCP 도구는 57회 쓰였다 — 스킬만 세면 멀쩡한 플러그인이
 * 미사용으로 찍힌다.
 */
function pluginCount(
  pluginId: string,
  stats: UsageStats,
  provided: Asset[]
): { count: number; lastUsedAt?: string } {
  let count = 0
  let last = ''

  const take = (hit: AssetUsage | undefined): void => {
    if (!hit) return
    count += hit.count
    if (hit.lastUsedAt > last) last = hit.lastUsedAt
  }

  for (const asset of provided) {
    if (!('sourcePlugin' in asset) || asset.sourcePlugin !== pluginId) continue
    const map = usageFor(stats, asset)
    if (map) take(lookup(map, asset))
  }

  /*
    플러그인이 띄운 MCP 서버. 도구 이름의 서버 부분이 `plugin_<이름>_<서버>`
    형태라, 플러그인 이름이 들어간 서버를 그 플러그인 것으로 본다.
  */
  const bare = pluginId.split('@')[0] ?? pluginId
  for (const [server, usage] of Object.entries(stats.mcp)) {
    if (server === bare || server.includes(bare.replace(/-/g, '_'))) take(usage)
  }

  return last ? { count, lastUsedAt: last } : { count }
}

/**
 * 사용량 맵에서 이 자산의 기록을 찾는다.
 *
 * 이름이 여러 모양으로 남는다. 커맨드는 `/stay:jira` 로 호출되지만
 * 파일은 `jira.md` 이고, 스킬은 `plugin:name` 으로도 `name` 으로도
 * 찍힌다. 집계 쪽에서 마지막 조각만 남겨두었으므로 여기서도 같은
 * 기준으로 맞춘다.
 */
function lookup(map: Record<string, AssetUsage>, asset: Asset): AssetUsage | undefined {
  const direct = map[asset.name]
  if (direct) return direct

  // 훅은 이름이 이벤트명이라 `PreToolUse:Bash` 처럼 접미가 붙는다.
  if (asset.kind === 'hook') {
    let total = 0
    let last = ''
    for (const [key, value] of Object.entries(map)) {
      if (key !== asset.event && !key.startsWith(`${asset.event}:`)) continue
      total += value.count
      if (value.lastUsedAt > last) last = value.lastUsedAt
    }
    if (total > 0) return { count: total, lastUsedAt: last }
  }

  // 커맨드는 `/dir:name` 네임스페이스로 호출된다. invocation 쪽도 본다.
  if (asset.kind === 'command') {
    const bare = asset.invocation.replace(/^\//, '').split(':').pop()
    if (bare && map[bare]) return map[bare]
  }

  return undefined
}

/**
 * 판정한다.
 *
 * @param asset 설치된 자산
 * @param stats 사용량 집계
 * @param mtimeMs 자산 파일의 수정 시각. 모르면 생략한다.
 */
export function verdictFor(
  asset: Asset,
  stats: UsageStats,
  mtimeMs?: number,
  /** 플러그인 판정에 쓸 전체 자산 목록. 플러그인 행에만 필요하다. */
  allAssets?: Asset[]
): VerdictResult | null {
  // 플러그인은 제공 자산의 호출로 역산한다.
  if (asset.kind === 'plugin') {
    if (!allAssets) return null
    const rolled = pluginCount(asset.id, stats, allAssets)
    if (rolled.count > 0) {
      return {
        verdict: 'active',
        count: rolled.count,
        ...(rolled.lastUsedAt ? { lastUsedAt: rolled.lastUsedAt } : {}),
        reason: `이 플러그인이 제공한 자산이 최근 ${stats.retentionDays}일에 ${rolled.count}회 쓰였습니다.`
      }
    }
    return {
      verdict: 'unknown',
      count: 0,
      reason: `최근 ${stats.retentionDays}일 기록에 이 플러그인의 자산 호출이 없습니다. 다만 출력 스타일이나 훅으로 동작하는 플러그인은 호출 기록이 남지 않으므로, 이것만으로 미사용이라 단정할 수 없습니다.`
    }
  }

  const map = usageFor(stats, asset)
  if (!map) return null

  const hit = lookup(map, asset)
  if (hit && hit.count > 0) {
    return {
      verdict: 'active',
      count: hit.count,
      lastUsedAt: hit.lastUsedAt,
      reason: `최근 ${stats.retentionDays}일(세션 ${stats.sessionsScanned}개)에서 ${hit.count}회 쓰였습니다.`
    }
  }

  const oldest = stats.oldestSessionAt ? Date.parse(stats.oldestSessionAt) : NaN

  /*
    기록 구간을 모르면 레거시라고 말할 근거가 없다. 0회가 "안 쓰임" 인지
    "기록이 없음" 인지 가를 수 없기 때문이다.
  */
  if (!Number.isFinite(oldest)) {
    return {
      verdict: 'unknown',
      count: 0,
      reason: '세션 기록이 없어 사용 여부를 판단할 수 없습니다.'
    }
  }

  const days = Math.round((Date.now() - oldest) / 86_400_000)

  /*
    기록 구간보다 나중에 생긴 파일은 "안 쓴" 것이 아니라 "쓸 기회가
    적었던" 것이다. 설치 직후의 자산을 레거시로 찍지 않는다.
  */
  if (mtimeMs !== undefined && mtimeMs > oldest - SETTLE_DAYS * 86_400_000) {
    return {
      verdict: 'unknown',
      count: 0,
      reason: `기록 구간(${days}일) 안에 호출이 없지만, 파일이 그만큼 오래되지 않아 판단을 보류합니다.`
    }
  }

  return {
    verdict: 'legacy',
    count: 0,
    reason: `최근 ${stats.retentionDays}일 기록(세션 ${stats.sessionsScanned}개, 실제 구간 ${days}일)에 호출이 없습니다. 기록은 ${stats.retentionDays}일만 보존되므로 더 가끔 쓰는 자산일 수 있습니다. 지우기 전에 확인하세요.`
  }
}
