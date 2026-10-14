import { basename } from 'node:path'
import type {
  MarketplaceAsset,
  MarketplaceSource,
  PermissionAsset,
  PermissionKind,
  PermissionLayer,
  PermissionSummary
} from '../shared/types.js'

/**
 * 권한 규칙과 마켓플레이스를 읽는다.
 *
 * 둘 다 읽기 전용이다. 권한 규칙은 어떤 명령이 자동 승인되는지를 정하는
 * 설정이라, 앱에서 잘못 쓰면 위험한 것이 조용히 허용된다. 마켓플레이스는
 * Claude Code 가 소유하는 레지스트리이고, 제거는 CLI 영역이다.
 */

/** 규칙 원문에서 도구와 인자를 뽑는 패턴. 예: `Bash(git add *)` */
const RULE_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/

/** 괄호가 없는 규칙(MCP 도구명)을 묶는 이름. */
const BARE_TOOL = 'MCP'

const KINDS: PermissionKind[] = ['allow', 'ask', 'deny']

/** 규칙 성격을 한국어로. UI 배지에 쓴다. */
const KIND_LABELS: Record<PermissionKind, string> = {
  allow: '허용',
  ask: '확인',
  deny: '거부'
}

/** 설정 하나에서 permissions 블록을 꺼낸다. */
function permissionsBlock(
  settings: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!settings) return null
  const block = settings['permissions']
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null
  return block as Record<string, unknown>
}

/** 문자열 배열만 남긴다. */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * 규칙 하나를 자산으로 바꾼다.
 *
 * `Bash(git add *)` 는 도구 Bash + 인자 `git add *` 로 쪼갠다.
 * `mcp__foo__bar` 처럼 괄호가 없으면 MCP 로 묶는다 — 도구별로 묶어 보여줄 때
 * MCP 도구명이 전부 제각각이라 묶이지 않으면 목록이 평평해진다.
 */
function toPermissionAsset(
  pattern: string,
  rule: PermissionKind,
  layer: PermissionLayer,
  path: string
): PermissionAsset {
  const match = RULE_PATTERN.exec(pattern.trim())
  const tool = match?.[1] ?? BARE_TOOL
  const argument = match?.[2]

  return {
    kind: 'permission',
    // 규칙에는 고유 이름이 없다. 원문을 이름으로 쓰는 게 가장 읽기 쉽다.
    name: pattern,
    // 권한 규칙의 scope 는 레이어와 다른 축이다. local 은 project 로 접는다.
    scope: layer === 'user' ? 'user' : 'project',
    path,
    layer,
    rule,
    pattern,
    tool,
    ...(argument !== undefined && argument !== '' ? { argument } : {}),
    description: `${KIND_LABELS[rule]} · ${layer === 'user' ? '전역' : layer === 'project' ? '프로젝트' : '프로젝트 로컬'}`,
    // 규칙은 끄거나 지울 수 없다 — 이 도구는 권한 설정을 쓰지 않는다.
    toggle: {
      mechanism: null,
      enabled: true,
      reason:
        '권한 규칙은 이 도구에서 수정하지 않습니다. 어떤 명령이 자동 승인되는지를 정하는 설정이라, 잘못 쓰면 위험한 것이 조용히 허용됩니다. 편집기로 열어 직접 수정하세요.'
    },
    remove: {
      mechanism: null,
      reason: '권한 규칙은 이 도구에서 지우지 않습니다. 편집기로 열어 직접 수정하세요.'
    }
  }
}

/** 설정 레이어 하나를 읽는다. */
export interface PermissionLayerInput {
  layer: PermissionLayer
  /** 설정 파일 경로. UI 의 "열기" 대상이 된다. */
  path: string
  settings: Record<string, unknown> | null
}

/**
 * 여러 레이어의 권한 규칙을 모은다.
 *
 * 레이어가 셋인 이유는 Claude Code 가 전역 · 프로젝트 · 프로젝트 로컬
 * 세 파일을 모두 읽기 때문이다. 어느 파일에서 온 규칙인지가 핵심 정보라
 * 합치지 않고 배지로 구분한다.
 */
export function collectPermissions(inputs: PermissionLayerInput[]): {
  assets: PermissionAsset[]
  summary: PermissionSummary
} {
  const assets: PermissionAsset[] = []
  const summary: PermissionSummary = {
    defaultMode: [],
    additionalDirectories: [],
    counts: []
  }

  for (const { layer, path, settings } of inputs) {
    const block = permissionsBlock(settings)
    if (!block) continue

    const counts = { allow: 0, ask: 0, deny: 0 }
    for (const kind of KINDS) {
      const rules = stringList(block[kind])
      counts[kind] = rules.length
      for (const pattern of rules) {
        assets.push(toPermissionAsset(pattern, kind, layer, path))
      }
    }

    // 규칙이 하나도 없는 레이어는 요약에도 넣지 않는다.
    if (counts.allow + counts.ask + counts.deny > 0) {
      summary.counts.push({ layer, path, ...counts })
    }

    const mode = block['defaultMode']
    if (typeof mode === 'string' && mode !== '') {
      summary.defaultMode.push({ layer, value: mode })
    }

    for (const dir of stringList(block['additionalDirectories'])) {
      summary.additionalDirectories.push({ layer, path: dir })
    }
  }

  return { assets, summary }
}

// ---------------------------------------------------------------------------
// 마켓플레이스
// ---------------------------------------------------------------------------

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
