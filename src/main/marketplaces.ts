import { basename } from 'node:path'
import type { MarketplaceAsset, MarketplaceSource } from '../shared/types.js'

/**
 * 플러그인 마켓플레이스를 읽는다.
 *
 * 읽기 전용이다. 레지스트리는 Claude Code 가 소유하고, 제거는
 * `claude plugin marketplace remove` 영역이다.
 */

interface RawMarketplaceEntry {
  source?: { source?: unknown; repo?: unknown; url?: unknown; path?: unknown }
  installLocation?: unknown
  lastUpdated?: unknown
}

/** 출처 종류를 좁힌다. */
function marketplaceSource(value: unknown): MarketplaceSource {
  return value === 'github' || value === 'git' || value === 'directory' ? value : 'unknown'
}

/** 출처를 사람이 읽을 한 줄로. */
function originOf(entry: RawMarketplaceEntry): string | undefined {
  const source = entry.source
  if (!source) return undefined
  if (typeof source.repo === 'string') return source.repo
  if (typeof source.url === 'string') return source.url
  if (typeof source.path === 'string') return source.path
  return undefined
}

/**
 * 마켓플레이스 목록을 만든다.
 *
 * known_marketplaces.json 을 기준으로 삼는다. settings.json 의
 * extraKnownMarketplaces 보다 항목이 많고(실측 11 대 9), 설치 위치와
 * 마지막 갱신 시각이 들어있다.
 *
 * @param registry plugins/known_marketplaces.json 내용
 * @param extraKnown settings.json 의 extraKnownMarketplaces
 * @param installedIds 설치된 플러그인 ID 목록 (`<plugin>@<marketplace>`)
 */
export function collectMarketplaces(
  registry: Record<string, unknown> | null,
  extraKnown: Record<string, unknown> | null,
  installedIds: string[],
  registryPath: string
): MarketplaceAsset[] {
  if (!registry) return []

  // 출처별 설치된 플러그인 수를 미리 센다.
  const usage = new Map<string, number>()
  for (const id of installedIds) {
    const atIndex = id.lastIndexOf('@')
    if (atIndex <= 0) continue
    const marketplace = id.slice(atIndex + 1)
    usage.set(marketplace, (usage.get(marketplace) ?? 0) + 1)
  }

  const inSettings = new Set(extraKnown ? Object.keys(extraKnown) : [])
  const out: MarketplaceAsset[] = []

  for (const [name, value] of Object.entries(registry)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as RawMarketplaceEntry
    const source = marketplaceSource(entry.source?.source)
    const origin = originOf(entry)
    const installed = usage.get(name) ?? 0

    out.push({
      kind: 'marketplace',
      name,
      // 마켓플레이스는 전역 레지스트리에만 있다.
      scope: 'user',
      // "열기" 는 설치 위치가 있으면 그곳을, 없으면 레지스트리 파일을 연다.
      path:
        typeof entry.installLocation === 'string' ? entry.installLocation : registryPath,
      description: origin
        ? `${source} · ${origin}`
        : source,
      source,
      ...(origin ? { origin } : {}),
      ...(typeof entry.installLocation === 'string'
        ? { installLocation: entry.installLocation }
        : {}),
      ...(typeof entry.lastUpdated === 'string' ? { lastUpdated: entry.lastUpdated } : {}),
      installedPlugins: installed,
      inSettings: inSettings.has(name),
      toggle: {
        mechanism: null,
        enabled: true,
        reason:
          '마켓플레이스는 이 도구에서 수정하지 않습니다. claude plugin marketplace 명령으로 관리하세요.'
      },
      remove: {
        mechanism: null,
        reason:
          '마켓플레이스 제거는 claude plugin marketplace remove 로 하세요. 이 도구는 레지스트리를 쓰지 않습니다.'
      }
    })
  }

  // 설치된 플러그인이 많은 출처부터. 0개인 출처는 자연히 아래로 간다.
  out.sort(
    (a, b) => b.installedPlugins - a.installedPlugins || a.name.localeCompare(b.name)
  )
  return out
}

/** 요약 줄에 쓸 레지스트리 파일명. */
export function registryLabel(path: string): string {
  return basename(path)
}
