import { basename } from 'node:path'
import type {
  AutoUpdateInfo,
  MarketplaceAsset,
  MarketplaceSource
} from '../shared/types.js'

/**
 * 플러그인 마켓플레이스를 읽는다.
 *
 * 목록 자체는 읽기 전용이다. 레지스트리는 Claude Code 가 소유하고,
 * 추가·갱신·제거는 `claude plugin marketplace` 명령이 한다.
 *
 * 다만 자동 갱신 플래그는 예외다. 그 값은 settings.json 의
 * extraKnownMarketplaces 에 있고 CLI 에 이를 설정하는 플래그가 없어서,
 * 설정 파일을 직접 쓰는 것이 유일한 방법이다(Claude Code 의 /plugin
 * 토글도 같은 곳을 쓴다).
 */

interface RawMarketplaceEntry {
  source?: { source?: unknown; repo?: unknown; url?: unknown; path?: unknown }
  installLocation?: unknown
  lastUpdated?: unknown
  autoUpdate?: unknown
}

/**
 * 적지 않아도 자동 갱신이 켜져 있는 마켓플레이스.
 *
 * 공식 마켓플레이스는 기본이 켜짐이고 그 외는 꺼짐이다. 그래서 플래그가
 * 없을 때 "꺼짐" 으로 보여주면 공식 마켓플레이스에서 거짓이 된다.
 *
 * 목록으로 박아두는 이유: 어느 이름이 공식인지는 Claude Code 가 정하고
 * 레지스트리 항목에는 그 구분이 없다. 목록에 없는 새 공식 이름이 생기면
 * 기본 꺼짐으로 보이는데, 그쪽이 안전한 오차다 — 켜진 것을 꺼졌다고
 * 말하는 편이 꺼진 것을 켜졌다고 말하는 것보다 덜 위험하다.
 */
const DEFAULT_ON_MARKETPLACES = new Set([
  'claude-plugins-official',
  'anthropic-plugin-directory'
])

/** 불리언이면 그대로, 아니면 undefined — 다른 타입이 들어온 경우를 무시한다. */
function boolOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * 자동 갱신 상태를 계산한다.
 *
 * 읽는 곳과 쓰는 곳이 다르다. 읽기는 레지스트리를 믿는다 — 프로젝트나
 * 관리자 설정에서 선언된 값까지 반영된 결과가 거기 모인다(실측:
 * project-marketplace 는 레지스트리에만 autoUpdate 가 있다). 쓰기는
 * 사용자 settings.json 만 건드린다.
 *
 * 그래서 둘이 어긋나면 토글을 막는다. 레지스트리에 값이 있는데 내
 * settings.json 에는 없다면 그 값은 남이 선언한 것이고, 우리가 사용자
 * 설정에 쓰면 남의 설정을 전역으로 끌어오는 셈이 된다.
 *
 * @param entry 레지스트리 항목
 * @param settingsEntry 사용자 settings.json 의 같은 이름 항목
 * @param name 마켓플레이스 이름
 */
function autoUpdateInfo(
  entry: RawMarketplaceEntry,
  settingsEntry: Record<string, unknown> | undefined,
  name: string
): AutoUpdateInfo {
  const fromRegistry = boolOrUndefined(entry.autoUpdate)
  const fromSettings = settingsEntry
    ? boolOrUndefined(settingsEntry['autoUpdate'])
    : undefined

  const defaultOn = DEFAULT_ON_MARKETPLACES.has(name)
  // 레지스트리가 실제 적용 상태다. 값이 없으면 이름으로 정해지는 기본값.
  const effective = fromRegistry ?? defaultOn

  // 내 settings.json 에 적힌 값만 '선언' 으로 본다.
  const declared = fromSettings === undefined ? 'default' : fromSettings ? 'on' : 'off'

  /*
    항목 자체가 없다 — 내장 기본 마켓플레이스가 이 경우다. 새로 만들려면
    source 가 필요한데, 이 이름은 사용자가 추가한 것이 아니라서 사용자
    설정에 선언을 만드는 것이 적절하지 않다.
  */
  if (!settingsEntry) {
    // 남이 선언한 값이 레지스트리에 보이면 그 사실을 사유로 구분한다.
    const blockedBy = fromRegistry !== undefined ? 'foreignScope' : 'notDeclared'
    return { declared, effective, editable: false, blockedBy }
  }

  /*
    내 settings.json 에 항목은 있는데 autoUpdate 는 없고, 레지스트리에는
    값이 있다. 그 값은 다른 설정 파일에서 왔다 — 내가 덮어쓰면 그쪽
    의도와 충돌한다.
  */
  if (fromSettings === undefined && fromRegistry !== undefined) {
    return { declared, effective, editable: false, blockedBy: 'foreignScope' }
  }

  return { declared, effective, editable: true }
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
 * @param availableCounts 마켓플레이스별 설치 가능 플러그인 수. 없으면 생략한다.
 */
export function collectMarketplaces(
  registry: Record<string, unknown> | null,
  extraKnown: Record<string, unknown> | null,
  installedIds: string[],
  registryPath: string,
  availableCounts?: Map<string, number>
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

    // 사용자 settings.json 의 같은 이름 항목. 객체가 아니면 없는 것으로 본다.
    const settingsValue = extraKnown?.[name]
    const settingsEntry =
      settingsValue && typeof settingsValue === 'object' && !Array.isArray(settingsValue)
        ? (settingsValue as Record<string, unknown>)
        : undefined

    const autoUpdate = autoUpdateInfo(entry, settingsEntry, name)
    const available = availableCounts?.get(name)

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
      ...(available !== undefined ? { availablePlugins: available } : {}),
      autoUpdate,
      /*
        toggle 은 비워 둔다. 마켓플레이스를 "끄는" 개념은 Claude Code 에
        없고(끄려면 제거한다), 이 행에 있는 스위치는 자동 갱신 전용이다.
        같은 자리에 두 뜻의 스위치를 놓으면 어느 쪽을 끄는지 알 수 없다.
      */
      toggle: {
        mechanism: null,
        enabled: true,
        reason:
          '마켓플레이스 자체를 끄는 기능은 없습니다. 아래 스위치는 자동 갱신을 켜고 끕니다.'
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
