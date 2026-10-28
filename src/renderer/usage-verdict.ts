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
    default:
      // 플러그인·MCP·마켓플레이스·규칙은 호출 기록이 없다.
      return null
  }
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
  mtimeMs?: number
): VerdictResult | null {
  const map = usageFor(stats, asset)
  if (!map) return null

  const hit = lookup(map, asset)
  if (hit && hit.count > 0) {
    return {
      verdict: 'active',
      count: hit.count,
      lastUsedAt: hit.lastUsedAt,
      reason: `최근 ${stats.sessionsScanned}개 세션에서 ${hit.count}회 쓰였습니다.`
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
    reason: `최근 ${days}일 기록(세션 ${stats.sessionsScanned}개)에 호출이 없습니다. 더 가끔 쓰는 자산일 수 있으니 지우기 전에 확인하세요.`
  }
}
