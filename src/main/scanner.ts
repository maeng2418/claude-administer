import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseFrontmatter, readString, readStringList } from './frontmatter.js'
import type {
  AgentAsset,
  Asset,
  CommandAsset,
  HookAsset,
  Inventory,
  McpAsset,
  PluginAsset,
  ScanIssue,
  Scope,
  SkillAsset
} from '../shared/types.js'

/**
 * 로컬에 설치된 Claude Code 자산을 읽어 Inventory 하나로 모은다.
 *
 * 설계 원칙 두 가지:
 *  1. 읽기 전용 — 이 모듈은 파일을 쓰지 않는다.
 *  2. 부분 실패 허용 — 파일 하나가 깨져도 스캔 전체를 멈추지 않고 issues 에 쌓는다.
 *     관리 도구가 자기 대상 때문에 안 열리면 쓸모가 없다.
 */

/** 스캔 중 모은 문제를 담는 수집기. */
class IssueLog {
  readonly items: ScanIssue[] = []

  add(path: string, err: unknown): void {
    this.items.push({
      path,
      message: err instanceof Error ? err.message : String(err)
    })
  }

  note(path: string, message: string): void {
    this.items.push({ path, message })
  }
}

/** 디렉토리 항목을 읽는다. 디렉토리가 없으면 빈 배열 — 정상 상황이다. */
async function listDir(
  dir: string,
  issues: IssueLog
): Promise<{ name: string; isDirectory: boolean }[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // ENOENT 는 "그 종류의 자산이 없다"는 뜻이지 오류가 아니다.
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      issues.add(dir, err)
    }
    return []
  }
}

/** JSON 파일을 읽는다. 없으면 null, 깨졌으면 issue 에 기록하고 null. */
async function readJson<T>(path: string, issues: IssueLog): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw) as T
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      issues.add(path, err)
    }
    return null
  }
}

/** .md 파일의 frontmatter 를 읽는다. 파싱 실패는 issue 로 남기고 빈 객체를 돌려준다. */
async function readMarkdownMeta(
  path: string,
  issues: IssueLog
): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(path, 'utf8')
    const fm = parseFrontmatter(content)
    if (fm.error) {
      issues.note(path, `frontmatter: ${fm.error}`)
    }
    return fm.data
  } catch (err) {
    issues.add(path, err)
    return {}
  }
}

// ---------------------------------------------------------------------------
// 스킬
// ---------------------------------------------------------------------------

/**
 * skills/ 디렉토리를 스캔한다.
 *
 * 스킬은 `skills/<name>/SKILL.md` 형태다. SKILL.md 가 없는 디렉토리는
 * 스킬이 아니므로 건너뛴다(예: skills/synced 같은 보조 디렉토리).
 */
async function scanSkills(
  root: string,
  scope: Scope,
  issues: IssueLog,
  sourcePlugin?: string
): Promise<SkillAsset[]> {
  const dir = join(root, 'skills')
  const entries = await listDir(dir, issues)
  const out: SkillAsset[] = []

  for (const entry of entries) {
    if (!entry.isDirectory) continue
    const skillMd = join(dir, entry.name, 'SKILL.md')
    try {
      await stat(skillMd)
    } catch {
      continue
    }
    const meta = await readMarkdownMeta(skillMd, issues)
    out.push({
      kind: 'skill',
      // frontmatter name 이 디렉토리명과 다를 수 있으나, 호출 식별자는 디렉토리명이다.
      name: readString(meta, 'name') ?? entry.name,
      scope,
      path: join(dir, entry.name),
      description: readString(meta, 'description'),
      trigger: readString(meta, 'trigger'),
      ...(sourcePlugin ? { sourcePlugin } : {})
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 에이전트
// ---------------------------------------------------------------------------

/** agents/ 의 .md 파일을 스캔한다. 하위 디렉토리도 한 단계 따라간다. */
async function scanAgents(
  root: string,
  scope: Scope,
  issues: IssueLog
): Promise<AgentAsset[]> {
  const dir = join(root, 'agents')
  const out: AgentAsset[] = []

  const walk = async (current: string, depth: number): Promise<void> => {
    const entries = await listDir(current, issues)
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory) {
        if (depth < 2) await walk(full, depth + 1)
        continue
      }
      if (!entry.name.endsWith('.md')) continue
      const meta = await readMarkdownMeta(full, issues)
      out.push({
        kind: 'agent',
        name: readString(meta, 'name') ?? basename(entry.name, '.md'),
        scope,
        path: full,
        description: readString(meta, 'description'),
        tools: readStringList(meta, 'tools'),
        model: readString(meta, 'model')
      })
    }
  }

  await walk(dir, 0)
  return out
}

// ---------------------------------------------------------------------------
// 커맨드
// ---------------------------------------------------------------------------

/**
 * commands/ 의 .md 파일을 스캔한다.
 *
 * 커맨드 .md 에는 frontmatter name 이 없다(실측 확인) — 호출 이름은 파일 경로에서
 * 만들어야 한다. 하위 디렉토리는 네임스페이스가 되어 `/dir:file` 로 호출된다.
 */
async function scanCommands(
  root: string,
  scope: Scope,
  issues: IssueLog,
  sourcePlugin?: string
): Promise<CommandAsset[]> {
  const dir = join(root, 'commands')
  const out: CommandAsset[] = []

  const walk = async (current: string, segments: string[]): Promise<void> => {
    const entries = await listDir(current, issues)
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory) {
        if (segments.length < 2) await walk(full, [...segments, entry.name])
        continue
      }
      if (!entry.name.endsWith('.md')) continue
      const stem = basename(entry.name, '.md')
      const name = [...segments, stem].join(':')
      const meta = await readMarkdownMeta(full, issues)
      out.push({
        kind: 'command',
        name,
        scope,
        path: full,
        description: readString(meta, 'description'),
        invocation: `/${name}`,
        ...(sourcePlugin ? { sourcePlugin } : {})
      })
    }
  }

  await walk(dir, [])
  return out
}

// ---------------------------------------------------------------------------
// 훅
// ---------------------------------------------------------------------------

/** settings.json 의 hooks 블록 모양. 신뢰할 수 없는 입력이므로 unknown 기반으로 좁힌다. */
interface RawHookEntry {
  matcher?: unknown
  hooks?: unknown
}

/**
 * settings.json 에서 훅을 뽑는다.
 *
 * 구조: hooks[이벤트명] -> [{ matcher, hooks: [{ type, command, timeout, async }] }]
 * 중첩 배열이라 평탄화해서 한 줄에 한 훅이 되도록 만든다.
 */
function extractHooks(
  settings: Record<string, unknown> | null,
  scope: Scope,
  settingsPath: string
): HookAsset[] {
  if (!settings) return []
  const hooksBlock = settings['hooks']
  if (!hooksBlock || typeof hooksBlock !== 'object' || Array.isArray(hooksBlock)) {
    return []
  }

  const out: HookAsset[] = []
  let index = 0

  for (const [event, groups] of Object.entries(hooksBlock as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups as RawHookEntry[]) {
      if (!group || typeof group !== 'object') continue
      const matcher = typeof group.matcher === 'string' ? group.matcher : ''
      const inner = Array.isArray(group.hooks) ? group.hooks : []
      for (const hook of inner as Record<string, unknown>[]) {
        if (!hook || typeof hook !== 'object') continue
        const command = typeof hook['command'] === 'string' ? hook['command'] : ''
        out.push({
          kind: 'hook',
          // 훅은 고유 이름이 없다. 이벤트 + 매처로 사람이 읽을 이름을 만든다.
          name: matcher === '' ? event : `${event} (${matcher})`,
          scope,
          path: settingsPath,
          event,
          matcher,
          command,
          type: typeof hook['type'] === 'string' ? (hook['type'] as string) : 'command',
          timeout: typeof hook['timeout'] === 'number' ? hook['timeout'] : undefined,
          async: typeof hook['async'] === 'boolean' ? hook['async'] : undefined,
          description: summarizeCommand(command),
          index: index++
        })
      }
    }
  }
  return out
}

/** 긴 훅 명령을 목록에서 읽을 만한 한 줄로 줄인다. */
function summarizeCommand(command: string): string | undefined {
  if (command === '') return undefined
  const collapsed = command.replace(/\s+/g, ' ').trim()
  return collapsed.length > 120 ? `${collapsed.slice(0, 117)}…` : collapsed
}

// ---------------------------------------------------------------------------
// MCP 서버
// ---------------------------------------------------------------------------

interface RawMcpServer {
  command?: unknown
  args?: unknown
  type?: unknown
  url?: unknown
}

/** .mcp.json / mcp.json 에서 서버 목록을 뽑는다. */
function extractMcp(
  config: Record<string, unknown> | null,
  scope: Scope,
  path: string
): McpAsset[] {
  if (!config) return []
  // 양쪽 형태를 모두 받는다: { mcpServers: {...} } 와 최상위가 바로 서버 맵인 경우.
  const raw = config['mcpServers']
  const servers =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : config
  const out: McpAsset[] = []

  for (const [name, value] of Object.entries(servers)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const server = value as RawMcpServer
    const command = typeof server.command === 'string' ? server.command : undefined
    const args = Array.isArray(server.args)
      ? server.args.filter((a): a is string => typeof a === 'string')
      : undefined
    const url = typeof server.url === 'string' ? server.url : undefined
    const declaredType = typeof server.type === 'string' ? server.type : undefined

    out.push({
      kind: 'mcp',
      name,
      scope,
      path,
      transport: declaredType ?? (command ? 'stdio' : url ? 'http' : 'unknown'),
      command,
      args,
      description: command
        ? summarizeCommand([command, ...(args ?? [])].join(' '))
        : url
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 플러그인
// ---------------------------------------------------------------------------

interface RawInstalledPlugins {
  plugins?: Record<string, { scope?: string; installPath?: string; version?: string; installedAt?: string }[]>
}

/**
 * 설치된 플러그인과, 각 플러그인이 제공하는 자산을 스캔한다.
 *
 * 활성 여부는 installed_plugins.json 이 아니라 settings.json 의 enabledPlugins 가
 * 정한다 — 설치돼 있어도 꺼져 있을 수 있다(실측: ouroboros = false).
 */
async function scanPlugins(
  userRoot: string,
  settings: Record<string, unknown> | null,
  issues: IssueLog
): Promise<{ plugins: PluginAsset[]; skills: SkillAsset[]; commands: CommandAsset[] }> {
  const registryPath = join(userRoot, 'plugins', 'installed_plugins.json')
  const registry = await readJson<RawInstalledPlugins>(registryPath, issues)

  const enabledMap =
    settings && typeof settings['enabledPlugins'] === 'object' && settings['enabledPlugins'] !== null
      ? (settings['enabledPlugins'] as Record<string, unknown>)
      : {}

  const plugins: PluginAsset[] = []
  const skills: SkillAsset[] = []
  const commands: CommandAsset[] = []

  if (!registry?.plugins) {
    return { plugins, skills, commands }
  }

  for (const [id, installs] of Object.entries(registry.plugins)) {
    const install = Array.isArray(installs) ? installs[0] : undefined
    if (!install?.installPath) continue

    // id 형식: "<plugin>@<marketplace>"
    const atIndex = id.lastIndexOf('@')
    const marketplace = atIndex > 0 ? id.slice(atIndex + 1) : 'unknown'

    const provided = await Promise.all([
      scanSkills(install.installPath, 'plugin', issues, id),
      scanCommands(install.installPath, 'plugin', issues, id),
      scanAgents(install.installPath, 'plugin', issues)
    ])
    const [pSkills, pCommands, pAgents] = provided
    skills.push(...pSkills)
    commands.push(...pCommands)

    const enabled = enabledMap[id] !== false

    plugins.push({
      kind: 'plugin',
      name: atIndex > 0 ? id.slice(0, atIndex) : id,
      id,
      scope: install.scope === 'project' ? 'project' : 'user',
      path: install.installPath,
      marketplace,
      version: install.version,
      installedAt: install.installedAt,
      enabled,
      disabled: !enabled,
      provides: {
        skills: pSkills.length,
        commands: pCommands.length,
        agents: pAgents.length
      }
    })
  }

  return { plugins, skills, commands }
}

// ---------------------------------------------------------------------------
// 충돌 표시
// ---------------------------------------------------------------------------

/**
 * 같은 kind·같은 name 이 여러 scope 에 있으면 서로를 shadowedBy 로 표시한다.
 *
 * 우선순위는 project > user > plugin 이다. UI 는 이 표시만 보고 배지를 띄운다.
 */
function markConflicts<T extends Asset>(assets: T[]): T[] {
  const byName = new Map<string, T[]>()
  for (const asset of assets) {
    const key = asset.name
    const bucket = byName.get(key)
    if (bucket) bucket.push(asset)
    else byName.set(key, [asset])
  }

  for (const bucket of byName.values()) {
    if (bucket.length < 2) continue
    for (const asset of bucket) {
      asset.shadowedBy = bucket
        .filter((other) => other !== asset)
        .map((other) => other.scope)
    }
  }
  return assets
}

// ---------------------------------------------------------------------------
// 진입점
// ---------------------------------------------------------------------------

/** 사용자 홈의 .claude 경로. */
export function userClaudeRoot(): string {
  return join(homedir(), '.claude')
}

/**
 * 전체 스캔을 수행한다.
 *
 * @param projectDir 프로젝트 루트(.claude 의 부모). 없으면 사용자 자산만 스캔한다.
 */
export async function scanInventory(projectDir?: string): Promise<Inventory> {
  const issues = new IssueLog()
  const userRoot = userClaudeRoot()
  const projectRoot = projectDir ? join(resolve(projectDir), '.claude') : null

  const userSettings = await readJson<Record<string, unknown>>(
    join(userRoot, 'settings.json'),
    issues
  )

  const [userSkills, userAgents, userCommands, pluginResult] = await Promise.all([
    scanSkills(userRoot, 'user', issues),
    scanAgents(userRoot, 'user', issues),
    scanCommands(userRoot, 'user', issues),
    scanPlugins(userRoot, userSettings, issues)
  ])

  const userMcp = extractMcp(
    await readJson<Record<string, unknown>>(join(userRoot, 'mcp.json'), issues),
    'user',
    join(userRoot, 'mcp.json')
  )
  const userHooks = extractHooks(userSettings, 'user', join(userRoot, 'settings.json'))

  let projectSkills: SkillAsset[] = []
  let projectAgents: AgentAsset[] = []
  let projectCommands: CommandAsset[] = []
  let projectHooks: HookAsset[] = []
  let projectMcp: McpAsset[] = []

  if (projectRoot && projectDir) {
    const projectSettingsPath = join(projectRoot, 'settings.json')
    const projectSettings = await readJson<Record<string, unknown>>(
      projectSettingsPath,
      issues
    )
    const mcpPath = join(resolve(projectDir), '.mcp.json')

    ;[projectSkills, projectAgents, projectCommands] = await Promise.all([
      scanSkills(projectRoot, 'project', issues),
      scanAgents(projectRoot, 'project', issues),
      scanCommands(projectRoot, 'project', issues)
    ])
    projectHooks = extractHooks(projectSettings, 'project', projectSettingsPath)
    projectMcp = extractMcp(
      await readJson<Record<string, unknown>>(mcpPath, issues),
      'project',
      mcpPath
    )
  }

  return {
    scannedAt: new Date().toISOString(),
    userRoot,
    projectRoot,
    skills: markConflicts([...projectSkills, ...userSkills, ...pluginResult.skills]),
    agents: markConflicts([...projectAgents, ...userAgents]),
    commands: markConflicts([
      ...projectCommands,
      ...userCommands,
      ...pluginResult.commands
    ]),
    // 훅과 MCP 는 이름이 고유하지 않거나 충돌 개념이 없어 표시하지 않는다.
    hooks: [...projectHooks, ...userHooks],
    plugins: pluginResult.plugins,
    mcp: markConflicts([...projectMcp, ...userMcp]),
    issues: issues.items
  }
}
