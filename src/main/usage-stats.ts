import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { userClaudeRoot } from './scanner.js'
import type { AssetUsage, UsageStats } from '../shared/types.js'

/**
 * 자산이 실제로 쓰이는지 센다.
 *
 * 세션 기록(`~/.claude/projects/<project>/<session>.jsonl`)에 도구 호출이
 * 남으므로, 그것을 훑어 스킬·커맨드·에이전트·훅의 호출 횟수를 모은다.
 *
 * 규칙은 세지 않는다. 규칙은 도구 호출이 아니라 컨텍스트 주입이라
 * 실행 기록이 남지 않는다 — 횟수 0 을 "안 쓰임" 으로 읽으면 전부
 * 레거시가 된다. 규칙 탭은 크기와 로드 조건으로 따로 판단한다.
 */

/**
 * 한 줄을 JSON 으로 파싱하기 전에 거르는 신호.
 *
 * 실측 기록은 2,092개 파일 4.7GB 다. 모든 줄을 JSON.parse 하면 수 분이
 * 걸리는데, 우리가 찾는 줄은 전체의 몇 퍼센트뿐이다. 문자열 검사로
 * 먼저 걸러 파싱 횟수를 줄인다.
 */
const LINE_HINTS = [
  '"Skill"',
  '"Agent"',
  'invoked_skills',
  'command-name',
  'hookName',
  'mcp__'
]

/** 한 세션 파일에서 모은 호출. */
interface FileCounts {
  skills: Map<string, number>
  commands: Map<string, number>
  agents: Map<string, number>
  hooks: Map<string, number>
  mcp: Map<string, number>
  /** 이 파일에서 본 마지막 사용 시각(파일 수정 시각으로 근사). */
  at: number
}

/**
 * 호출 이름을 집계 키 둘로 편다.
 *
 * 기록에는 `project-plugin:stay-api-doc` 처럼 네임스페이스가 붙는데,
 * 스캐너가 읽는 스킬 이름은 `stay-api-doc` 뿐이다(출처는 sourcePlugin
 * 에 따로 있다). 전체 이름만 세면 설치 목록과 하나도 안 맞고, 짧은
 * 이름만 세면 다른 플러그인의 동명 자산과 섞인다. 둘 다 센다.
 */
function nameKeys(value: unknown): string[] {
  if (typeof value !== 'string' || value === '') return []
  const full = value.trim()
  if (full === '') return []
  const bare = full.split(':').pop() ?? full
  return bare === full ? [full] : [full, bare]
}

function bump(map: Map<string, number>, keys: string[]): void {
  for (const key of keys) map.set(key, (map.get(key) ?? 0) + 1)
}

/**
 * 세션 파일 하나를 훑는다.
 *
 * 스트림으로 읽는 이유는 크기다 — 실측 최대 파일이 수십 MB 라
 * readFile 로 통째로 올리면 메모리가 출렁인다.
 */
async function scanSession(path: string, at: number): Promise<FileCounts> {
  const counts: FileCounts = {
    skills: new Map(),
    commands: new Map(),
    agents: new Map(),
    hooks: new Map(),
    mcp: new Map(),
    at
  }

  const stream = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })

  try {
    for await (const line of lines) {
      if (!LINE_HINTS.some((h) => line.includes(h))) continue

      let record: Record<string, unknown>
      try {
        record = JSON.parse(line) as Record<string, unknown>
      } catch {
        // 기록이 잘린 줄이 섞일 수 있다. 한 줄을 버리고 계속 읽는다.
        continue
      }

      // 훅: attachment.hookName 에 "SessionStart" / "PreToolUse:Bash" 로 남는다.
      const attachment = record['attachment']
      if (attachment && typeof attachment === 'object' && !Array.isArray(attachment)) {
        const att = attachment as Record<string, unknown>
        const hookName = att['hookName']
        if (typeof hookName === 'string' && hookName !== '') {
          /*
            "PreToolUse:Bash" 를 그대로 둔다. 앞부분만 남기면 Bash·Edit·
            Agent 에 걸린 훅이 전부 PreToolUse 하나로 뭉쳐, 어느 훅이
            실제로 도는지 알 수 없다 — 실측에서 125종이 7종으로 줄었다.
          */
          bump(counts.hooks, [hookName])
        }

        /*
          슬래시 커맨드로 들어온 스킬. Skill 도구와 다른 경로이고, 둘을
          합치지 않으면 실측 4종(design·jira·stay-link·update-config)이
          "한 번도 안 쓰임" 으로 잘못 찍힌다.
        */
        if (att['type'] === 'invoked_skills' && Array.isArray(att['skills'])) {
          for (const entry of att['skills']) {
            if (entry && typeof entry === 'object') {
              bump(counts.skills, nameKeys((entry as Record<string, unknown>)['name']))
            }
          }
        }
      }

      const message = record['message']
      if (!message || typeof message !== 'object') continue
      const content = (message as Record<string, unknown>)['content']

      // 커맨드는 user 턴의 본문에 <command-name>/foo</command-name> 로 남는다.
      if (typeof content === 'string' && content.includes('<command-name>')) {
        const matches = content.matchAll(/<command-name>([^<]+)<\/command-name>/g)
        for (const m of matches) {
          /*
            앞의 슬래시만 뗀다. 네임스페이스는 남긴다 — `/stay:jira` 를
            `jira` 로 뭉개면 다른 플러그인의 같은 이름과 섞여, 어느 쪽이
            쓰인 것인지 알 수 없다. 설치 목록도 `stay:jira` 형태다.
          */
          bump(counts.commands, nameKeys((m[1] ?? '').trim().replace(/^\//, '')))
        }
        continue
      }

      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const b = block as Record<string, unknown>
        if (b['type'] !== 'tool_use') continue
        const input = (b['input'] ?? {}) as Record<string, unknown>

        /*
          MCP 서버는 도구 이름으로 드러난다: `mcp__<서버>__<도구>`.
          서버 자체는 호출 대상이 아니라서, 그 서버가 제공한 도구가
          쓰였는지로 판단한다.
        */
        const toolName = b['name']
        if (typeof toolName === 'string' && toolName.startsWith('mcp__')) {
          const server = toolName.split('__')[1]
          if (server) bump(counts.mcp, [server])
        }

        if (b['name'] === 'Skill') bump(counts.skills, nameKeys(input['skill']))
        if (b['name'] === 'Agent') {
          /*
            subagent_type 이 없는 스폰은 세지 않는다. general-purpose 로
            몰아넣으면 그 이름의 실제 호출과 섞여, 설치된 에이전트의
            사용 여부를 판단할 수 없다 — 실측에서 156회가 그렇게 잡혔다.
          */
          bump(counts.agents, nameKeys(input['subagent_type']))
        }
      }
    }
  } finally {
    lines.close()
    stream.destroy()
  }

  return counts
}

/** 세션 파일 목록을 최신순으로 모은다. */
async function sessionFiles(root: string): Promise<{ path: string; at: number }[]> {
  const base = join(root, 'projects')
  const out: { path: string; at: number }[] = []

  let dirs: string[]
  try {
    dirs = (await readdir(base, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return out
  }

  await Promise.all(
    dirs.map(async (dir) => {
      const full = join(base, dir)
      let names: string[]
      try {
        names = await readdir(full)
      } catch {
        return
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        const path = join(full, name)
        try {
          const info = await stat(path)
          out.push({ path, at: info.mtimeMs })
        } catch {
          // 읽는 중 사라진 파일. 건너뛴다.
        }
      }
    })
  )

  out.sort((a, b) => b.at - a.at)
  return out
}

/** 집계 결과를 AssetUsage 배열로 편다. */
function toUsage(
  totals: Map<string, { count: number; lastAt: number }>
): Record<string, AssetUsage> {
  const out: Record<string, AssetUsage> = {}
  for (const [name, v] of totals) {
    out[name] = { count: v.count, lastUsedAt: new Date(v.lastAt).toISOString() }
  }
  return out
}

/** 세션 파일을 읽을 최대 개수. 전수는 느리고, 최신 쪽이 판단에 더 쓸모 있다. */
const MAX_FILES = 600

/** Claude Code 가 세션 기록을 지우기까지의 기본 일수. */
const DEFAULT_RETENTION_DAYS = 30

/**
 * 세션 기록 보존 기간을 읽는다.
 *
 * 스코프 우선순위는 Claude Code 와 같다: 관리자 정책이 가장 세고,
 * 그다음 프로젝트, 사용자 순이다. 어디에도 없으면 기본 30일이다.
 *
 * 이 값을 집계에 담는 이유는 "0회" 의 뜻이 창 길이에 달려 있기
 * 때문이다. 30일 창에서 0회인 것과 1년 창에서 0회인 것은 전혀 다른
 * 근거다 — 숫자를 보여주지 않으면 사용자가 그 차이를 알 수 없다.
 */
async function readRetention(
  root: string,
  projectRoot: string | null
): Promise<{ days: number; source: UsageStats['retentionSource'] }> {
  const read = async (path: string): Promise<number | null> => {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      const value = parsed['cleanupPeriodDays']
      // 0 이하는 Claude Code 가 거부하는 값이다. 그런 설정은 없는 것으로 본다.
      return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.round(value)
        : null
    } catch {
      return null
    }
  }

  const managed = await read(
    '/Library/Application Support/ClaudeCode/managed-settings.json'
  )
  if (managed !== null) return { days: managed, source: 'managed' }

  if (projectRoot) {
    for (const name of ['settings.json', 'settings.local.json']) {
      const found = await read(join(projectRoot, name))
      if (found !== null) return { days: found, source: 'project' }
    }
  }

  for (const name of ['settings.json', 'settings.local.json']) {
    const found = await read(join(root, name))
    if (found !== null) return { days: found, source: 'user' }
  }

  return { days: DEFAULT_RETENTION_DAYS, source: 'default' }
}

/**
 * 사용량을 집계한다.
 *
 * 결과에 기록 구간(oldest~newest)을 함께 담는다. "0회" 가 "안 쓰임" 인지
 * "기록이 그만큼 없음" 인지는 구간을 봐야 갈리기 때문이다 — 실측 기록은
 * 22일치뿐이라, 분기에 한 번 쓰는 자산은 구간을 모르면 레거시로 오판된다.
 */
export async function collectUsageStats(projectRoot?: string | null): Promise<UsageStats> {
  const root = userClaudeRoot()
  const [all, retention] = await Promise.all([
    sessionFiles(root),
    readRetention(root, projectRoot ?? null)
  ])

  /*
    보존 창 밖의 파일은 세지 않는다. Claude Code 가 곧 지울 기록이고,
    그것을 섞으면 "최근 N일" 이라는 말과 실제 집계가 어긋난다.

    창 안에 파일이 하나도 없으면(막 정리된 직후) 그래도 최신 것부터
    본다 — 빈 결과보다는 표본이라도 있는 편이 낫다.
  */
  const cutoff = Date.now() - retention.days * 86_400_000
  const inWindow = all.filter((f) => f.at >= cutoff)
  const files = inWindow.length > 0 ? inWindow : all
  const scanned = files.slice(0, MAX_FILES)

  const skills = new Map<string, { count: number; lastAt: number }>()
  const commands = new Map<string, { count: number; lastAt: number }>()
  const agents = new Map<string, { count: number; lastAt: number }>()
  const hooks = new Map<string, { count: number; lastAt: number }>()
  const mcp = new Map<string, { count: number; lastAt: number }>()

  const merge = (
    into: Map<string, { count: number; lastAt: number }>,
    from: Map<string, number>,
    at: number
  ): void => {
    for (const [name, n] of from) {
      const prev = into.get(name)
      if (prev) {
        prev.count += n
        if (at > prev.lastAt) prev.lastAt = at
      } else {
        into.set(name, { count: n, lastAt: at })
      }
    }
  }

  /*
    한 번에 여러 파일을 읽되 상한을 둔다. 전부 동시에 열면 파일
    디스크립터가 바닥나고, 하나씩 읽으면 디스크 대기가 그대로 더해진다.
  */
  const CONCURRENCY = 8
  for (let i = 0; i < scanned.length; i += CONCURRENCY) {
    const batch = scanned.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map((f) =>
        scanSession(f.path, f.at).catch(() => null)
      )
    )
    for (const r of results) {
      if (!r) continue
      merge(skills, r.skills, r.at)
      merge(commands, r.commands, r.at)
      merge(agents, r.agents, r.at)
      merge(hooks, r.hooks, r.at)
      merge(mcp, r.mcp, r.at)
    }
  }

  const times = files.map((f) => f.at)
  return {
    scannedAt: new Date().toISOString(),
    sessionsScanned: scanned.length,
    sessionsTotal: files.length,
    retentionDays: retention.days,
    retentionSource: retention.source,
    oldestSessionAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
    newestSessionAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
    skills: toUsage(skills),
    commands: toUsage(commands),
    agents: toUsage(agents),
    hooks: toUsage(hooks),
    mcp: toUsage(mcp)
  }
}
