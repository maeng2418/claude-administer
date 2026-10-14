import { open, readdir, readFile, stat, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import type { ProjectRef, ScanIssue } from '../shared/types.js'
import { userClaudeRoot } from './scanner.js'

/**
 * 스캔 대상 프로젝트를 찾고 기억한다.
 *
 * 두 경로로 프로젝트를 안다:
 *  1. 발견 — ~/.claude/projects/ 의 세션 기록에서 실제 경로를 읽는다.
 *  2. 직접 추가 — 사용자가 폴더를 골라 넣은 것. 앱 전용 파일에 저장한다.
 *
 * 이 모듈은 Claude Code 의 설정 파일을 절대 쓰지 않는다. 쓰는 파일은
 * app.getPath('userData') 아래의 앱 전용 파일 하나뿐이다.
 */

/**
 * 프로젝트로 보지 않는 디렉토리.
 *
 * 홈과 그 바로 아래 표준 폴더들은 Claude Code 를 그 자리에서 한 번 띄우면
 * .claude/ 가 생겨 발견 조건을 통과한다. 하지만 이들은 프로젝트가 아니라
 * 프로젝트를 담는 그릇이고, 경로 가드의 허용 루트로 쓰면 그 아래 전부가
 * 열린다 — 홈을 허용하면 ~/.ssh/id_rsa 까지 통과한다.
 */
function broadRoots(): string[] {
  const home = resolve(homedir())
  return [
    home,
    ...['Desktop', 'Documents', 'Downloads', 'Library', 'Movies', 'Music', 'Pictures', 'Public'].map(
      (name) => join(home, name)
    )
  ]
}

/** 세션 기록 디렉토리명이 이것으로 시작하면 임시 작업공간이라 목록에서 뺀다. */
const TRANSIENT_PATH_PREFIXES = [
  '/private/var/folders/',
  '/var/folders/',
  '/tmp/',
  '/private/tmp/'
]

/**
 * 세션 파일에서 cwd 를 찾을 때 읽는 최대 바이트.
 *
 * cwd 는 사용자/어시스턴트 메시지 레코드에 들어있고 파일 앞부분에 거의 항상
 * 나타난다. 세션 파일은 수십 MB 까지 가므로 전체를 읽으면 안 된다.
 */
const CWD_PROBE_BYTES = 256 * 1024

const CWD_PATTERN = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/

/** 저장 파일 모양. 버전을 박아 나중에 형식이 바뀌어도 읽을 수 있게 한다. */
interface StoreShape {
  version: 1
  /** 사용자가 직접 추가한 프로젝트 경로. */
  added: string[]
  /**
   * 목록에서 숨긴 프로젝트 경로.
   *
   * 발견된 프로젝트는 ~/.claude/projects/ 의 세션 기록에서 나오는데, 그건
   * Claude Code 의 대화 기록이라 우리가 지울 것이 아니다. 지우면 사용자의
   * 실제 대화 로그가 사라진다. 그래서 숨김 목록에 넣어 가리기만 한다 —
   * 되돌릴 수 있고, 남의 파일을 건드리지 않는다.
   */
  hidden: string[]
  /** 마지막으로 보고 있던 프로젝트 경로. */
  lastSelected: string | null
}

const EMPTY_STORE: StoreShape = {
  version: 1,
  added: [],
  hidden: [],
  lastSelected: null
}

/** 경로가 임시 작업공간인지. */
function isTransient(path: string): boolean {
  return TRANSIENT_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))
}

/** 경로가 프로젝트가 아니라 프로젝트를 담는 그릇인지. */
function isBroadRoot(path: string): boolean {
  const normalized = resolve(path)
  return broadRoots().some((root) => normalized === root)
}

/**
 * 세션 파일 앞부분에서 cwd 를 읽는다.
 *
 * 디렉토리명(-Users-foo-bar)에서 경로를 역산할 수는 없다 — 경로 구분자와
 * 이름 속 하이픈이 똑같이 `-` 로 바뀌어서 `stay-frontend` 와 `stay/frontend`
 * 를 구분할 방법이 없다. 그래서 파일 내용의 cwd 를 유일한 근거로 쓴다.
 */
async function probeCwd(sessionFile: string): Promise<string | null> {
  let handle
  try {
    handle = await open(sessionFile, 'r')
    const buffer = Buffer.allocUnsafe(CWD_PROBE_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, CWD_PROBE_BYTES, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const match = CWD_PATTERN.exec(text)
    if (!match?.[1]) return null
    // JSON 문자열이므로 이스케이프를 풀어야 한다.
    try {
      return JSON.parse(`"${match[1]}"`) as string
    } catch {
      return null
    }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** 디렉토리에서 가장 최근에 수정된 .jsonl 파일 하나와 그 시각. */
async function newestSession(
  dir: string
): Promise<{ file: string; mtime: Date } | null> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }

  let best: { file: string; mtime: Date } | null = null
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue
    const full = join(dir, entry)
    try {
      const info = await stat(full)
      if (!best || info.mtime > best.mtime) best = { file: full, mtime: info.mtime }
    } catch {
      continue
    }
  }
  return best
}

/** 경로가 지금 존재하는 디렉토리인지. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** 프로젝트 하나의 부가 정보를 채운다. */
async function describe(
  path: string,
  origin: ProjectRef['origin'],
  lastUsedAt?: string
): Promise<ProjectRef> {
  const [hasClaudeDir, hasMcpConfig] = await Promise.all([
    isDirectory(join(path, '.claude')),
    stat(join(path, '.mcp.json'))
      .then(() => true)
      .catch(() => false)
  ])
  return {
    path,
    name: basename(path) || path,
    origin,
    hasClaudeDir,
    hasMcpConfig,
    ...(lastUsedAt ? { lastUsedAt } : {})
  }
}

/**
 * ~/.claude/projects/ 를 훑어 실제 프로젝트 경로를 복원한다.
 *
 * 걸러내는 것:
 *  - 임시 작업공간 경로 (/private/var/folders, /tmp 등)
 *  - 지금 존재하지 않는 디렉토리 (옮기거나 지운 프로젝트)
 *  - .claude/ 도 .mcp.json 도 없는 디렉토리 — Claude 자산이 없으면 볼 게 없다
 */
async function discoverProjects(
  issues: ScanIssue[]
): Promise<Map<string, ProjectRef>> {
  const projectsDir = join(userClaudeRoot(), 'projects')
  const found = new Map<string, ProjectRef>()

  let dirs: string[]
  try {
    dirs = await readdir(projectsDir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      issues.push({
        path: projectsDir,
        message: err instanceof Error ? err.message : String(err)
      })
    }
    return found
  }

  // 42개 전후라 전부 병렬로 띄워도 부담이 없다.
  const probes = dirs.map(async (name) => {
    if (name.startsWith('.')) return null
    const session = await newestSession(join(projectsDir, name))
    if (!session) return null
    const cwd = await probeCwd(session.file)
    if (!cwd) return null
    return { cwd, mtime: session.mtime }
  })

  for (const result of await Promise.all(probes)) {
    if (!result) continue
    const path = resolve(result.cwd)
    if (isTransient(path)) continue
    if (isBroadRoot(path)) continue
    if (found.has(path)) continue
    if (!(await isDirectory(path))) continue

    const ref = await describe(path, 'discovered', result.mtime.toISOString())
    // Claude 자산이 전혀 없는 디렉토리는 목록에 넣지 않는다.
    if (!ref.hasClaudeDir && !ref.hasMcpConfig) continue
    found.set(path, ref)
  }

  return found
}

// ---------------------------------------------------------------------------
// 선택 저장
// ---------------------------------------------------------------------------

/**
 * 저장 파일을 읽는다. 없거나 깨졌으면 빈 값 — 설정 파일 하나 깨졌다고
 * 앱이 안 열리면 안 된다.
 */
async function readStore(storePath: string): Promise<StoreShape> {
  try {
    const raw = await readFile(storePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY_STORE }
    const obj = parsed as Record<string, unknown>
    const added = Array.isArray(obj['added'])
      ? obj['added'].filter((v): v is string => typeof v === 'string')
      : []
    const hidden = Array.isArray(obj['hidden'])
      ? obj['hidden'].filter((v): v is string => typeof v === 'string')
      : []
    const lastSelected =
      typeof obj['lastSelected'] === 'string' ? obj['lastSelected'] : null
    return { version: 1, added, hidden, lastSelected }
  } catch {
    return { ...EMPTY_STORE }
  }
}

/** 저장 파일을 쓴다. 임시 파일에 쓰고 rename 해서 반쯤 쓴 파일이 남지 않게 한다. */
async function writeStore(storePath: string, store: StoreShape): Promise<void> {
  const tmp = `${storePath}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  await rename(tmp, storePath)
}

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------

/**
 * 프로젝트 레지스트리.
 *
 * 발견 결과를 캐시해둔다 — 세션 파일 탐색이 디스크를 꽤 때리는데,
 * 프로젝트 목록이 탭 전환마다 바뀔 이유는 없다. refresh() 로 다시 읽는다.
 */
export class ProjectRegistry {
  private cache: ProjectRef[] | null = null
  private cacheIssues: ScanIssue[] = []

  constructor(private readonly storePath: string) {}

  /** 캐시를 버린다. 다음 list() 가 다시 발견을 수행한다. */
  invalidate(): void {
    this.cache = null
  }

  /** 알고 있는 프로젝트 전체. 직접 추가한 것이 발견된 것보다 앞에 온다. */
  async list(): Promise<{
    projects: ProjectRef[]
    lastSelected: string | null
    issues: ScanIssue[]
  }> {
    const store = await readStore(this.storePath)

    if (!this.cache) {
      const issues: ScanIssue[] = []
      const discovered = await discoverProjects(issues)
      this.cache = [...discovered.values()]
      this.cacheIssues = issues
    }

    const hiddenPaths = new Set(store.hidden.map((p) => resolve(p)))
    const discoveredPaths = new Set(this.cache.map((p) => p.path))

    // 직접 추가한 것 중 지금도 존재하는 것만. 발견 목록과 겹치면 'added' 로 승격해
    // 사용자가 지울 수 있게 한다.
    const addedRefs: ProjectRef[] = []
    for (const path of store.added) {
      if (!(await isDirectory(path))) continue
      addedRefs.push(await describe(path, 'added'))
    }
    const addedPaths = new Set(addedRefs.map((p) => p.path))

    const discoveredOnly = this.cache
      .filter((p) => !addedPaths.has(p.path) && !hiddenPaths.has(p.path))
      // 최근 사용 순.
      .sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''))

    addedRefs.sort((a, b) => a.name.localeCompare(b.name))

    const lastSelected =
      store.lastSelected &&
      (addedPaths.has(store.lastSelected) || discoveredPaths.has(store.lastSelected))
        ? store.lastSelected
        : null

    return {
      projects: [...addedRefs, ...discoveredOnly],
      lastSelected,
      issues: this.cacheIssues
    }
  }

  /** 직접 추가. 이미 알고 있으면 중복으로 넣지 않는다. */
  async add(path: string): Promise<ProjectRef> {
    const normalized = resolve(path)
    if (!(await isDirectory(normalized))) {
      throw new Error('폴더가 아니거나 존재하지 않습니다.')
    }
    // 홈이나 Desktop 을 고르면 그 아래 전부가 파일 열기 대상이 된다.
    if (isBroadRoot(normalized)) {
      throw new Error(
        '홈이나 Desktop 같은 상위 폴더는 프로젝트로 추가할 수 없습니다. 개별 프로젝트 폴더를 고르세요.'
      )
    }
    const store = await readStore(this.storePath)
    if (!store.added.includes(normalized)) {
      store.added.push(normalized)
      await writeStore(this.storePath, store)
    }
    return describe(normalized, 'added')
  }

  /**
   * 프로젝트를 목록에서 뺀다.
   *
   * 직접 추가한 것은 저장 목록에서 지우면 그만이다. 발견된 것은 세션 기록에서
   * 계속 나오므로 숨김 목록에 넣는다 — ~/.claude/projects/ 를 지우면 사용자의
   * 대화 기록이 사라지므로 그쪽은 건드리지 않는다.
   */
  async remove(path: string): Promise<void> {
    const normalized = resolve(path)
    const store = await readStore(this.storePath)

    const wasAdded = store.added.includes(normalized)
    if (wasAdded) {
      store.added = store.added.filter((p) => p !== normalized)
    } else if (!store.hidden.includes(normalized)) {
      store.hidden.push(normalized)
    }

    if (store.lastSelected === normalized) store.lastSelected = null
    await writeStore(this.storePath, store)
  }

  /** 숨긴 프로젝트를 다시 보이게 한다. */
  async unhide(path: string): Promise<void> {
    const normalized = resolve(path)
    const store = await readStore(this.storePath)
    if (!store.hidden.includes(normalized)) return
    store.hidden = store.hidden.filter((p) => p !== normalized)
    await writeStore(this.storePath, store)
  }

  /** 숨긴 프로젝트 목록. 관리 창에서 되돌릴 수 있도록 보여준다. */
  async hiddenProjects(): Promise<ProjectRef[]> {
    const store = await readStore(this.storePath)
    const out: ProjectRef[] = []
    for (const path of store.hidden) {
      if (!(await isDirectory(path))) continue
      out.push(await describe(path, 'discovered'))
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }

  /** 지금 보고 있는 프로젝트를 기억해둔다. */
  async rememberSelection(path: string | null): Promise<void> {
    const store = await readStore(this.storePath)
    const normalized = path === null ? null : resolve(path)
    if (store.lastSelected === normalized) return
    store.lastSelected = normalized
    await writeStore(this.storePath, store)
  }

  /**
   * 경로 접근 허용 여부를 판정할 때 쓸 루트 목록.
   *
   * 알고 있는 프로젝트 경로만 허용한다 — 임의 경로를 허용하면 IPC 가
   * 파일 열기 우회로가 된다.
   */
  async allowedRoots(): Promise<string[]> {
    const { projects } = await this.list()
    return projects.map((p) => p.path)
  }

  /** 경로가 알고 있는 프로젝트 안에 있는지. */
  async isKnownProjectPath(target: string): Promise<boolean> {
    const normalized = resolve(target)
    const roots = await this.allowedRoots()
    return roots.some(
      (root) => normalized === root || normalized.startsWith(`${root}${sep}`)
    )
  }

  /** 스캔 요청으로 들어온 프로젝트 경로가 쓸 수 있는 것인지 확인하고 돌려준다. */
  async resolveForScan(path: string | null | undefined): Promise<ProjectRef | null> {
    if (!path) return null
    const normalized = resolve(path)
    const { projects } = await this.list()
    return projects.find((p) => p.path === normalized) ?? null
  }
}

/** userData 아래의 저장 파일 경로를 만든다. */
export function storePathFor(userDataDir: string): string {
  return join(userDataDir, 'projects.json')
}

/** 테스트에서 쓰도록 내부 함수를 노출한다. */
export const internals = { probeCwd, isTransient, isBroadRoot, broadRoots, discoverProjects }
