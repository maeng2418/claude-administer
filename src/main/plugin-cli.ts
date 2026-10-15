import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PluginOp, PluginOpResult } from '../shared/types.js'

/**
 * `claude plugin` CLI 호출.
 *
 * 마켓플레이스 등록과 플러그인 설치·갱신은 모두 공식 CLI 에 맡긴다.
 * known_marketplaces.json 과 installed_plugins.json 을 직접 쓰지 않는 이유는
 * remove.ts 와 같다 — 그 파일들은 Claude Code 가 소유하고, 포맷에 맞춰
 * 직접 써도 캐시 디렉토리나 git 체크아웃까지 우리가 만들어줄 수는 없다.
 *
 * 결과 판정에서 두 가지를 실측에 맞춰 처리한다:
 *
 *  1. 종료 코드를 믿지 않는다. `marketplace update <없는이름> --json` 은
 *     outcome:"failed" 를 내놓으면서 0 으로 끝난다. 그래서 --json 의
 *     outcome 필드가 유일하게 믿을 수 있는 신호다.
 *  2. JSON 이 마지막 줄이라고 가정하지 않는다. 실측에서 JSON 뒤에
 *     사람용 메시지("✘ Failed to update…")가 따라붙었다. 뒤에서부터
 *     훑어 파싱되는 첫 줄을 쓴다.
 */

const execFileAsync = promisify(execFile)

/**
 * CLI 상한.
 *
 * 마켓플레이스 추가·갱신은 git clone 을 돌리고, CLI 자체가 clone 에
 * 120초를 준다(실측 메시지: "timeout: 120s"). 그보다 짧게 끊으면 CLI 가
 * 정상적으로 기다리는 중인데 우리가 먼저 포기하게 된다. 여유를 둔다.
 */
const CLI_TIMEOUT_MS = 180_000

/** `--json` 결과 한 줄. 필드는 명령마다 다르므로 전부 optional 로 받는다. */
interface JsonLine {
  command?: unknown
  outcome?: unknown
  message?: unknown
  failureCode?: unknown
  updateOutcome?: unknown
  oldVersion?: unknown
  newVersion?: unknown
}

/** 문자열이면 그대로, 아니면 undefined. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 출력에서 `--json` 결과 줄을 찾는다.
 *
 * 뒤에서부터 보는 이유: 앞쪽에는 진행 로그가 섞일 수 있고, 결과는 출력
 * 후반에 나온다. `{` 로 시작하는 줄만 파싱을 시도해 사람용 메시지에
 * 괄호가 들어간 경우를 건너뛴다.
 */
function findJsonLine(stdout: string): JsonLine | null {
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as JsonLine
      }
    } catch {
      // 이 줄은 JSON 이 아니다. 더 앞을 본다.
    }
  }
  return null
}

/** 작업을 CLI 인자로 바꾼다. */
function argsFor(op: PluginOp): string[] {
  switch (op.op) {
    case 'marketplaceAdd':
      return ['plugin', 'marketplace', 'add', op.source, '--json']
    case 'marketplaceUpdate':
      return ['plugin', 'marketplace', 'update', op.name, '--json']
    case 'marketplaceUpdateAll':
      /*
        이름 없는 갱신에는 --json 을 붙이지 않는다. 붙이면 CLI 가
        거부한다(문서: "--json without a name is refused"). 결과는
        종료 코드로만 판정한다.
      */
      return ['plugin', 'marketplace', 'update']
    case 'pluginInstall':
      // -y: 비대화형이라 마켓플레이스가 선언한 설치 명령 확인을 넘긴다.
      return ['plugin', 'install', op.plugin, '--json', '-y']
    case 'pluginUpdate':
      return ['plugin', 'update', op.plugin, '--json', '-y']
  }
}

/** CLI 실패에서 사용자에게 보여줄 사유를 뽑는다. */
function detailFrom(err: unknown): { detail: string; enoent: boolean } {
  const e = err as {
    stderr?: string
    stdout?: string
    message?: string
    code?: string
    killed?: boolean
  }
  const enoent = e.code === 'ENOENT'
  // 타임아웃은 kill 로 끝나서 stderr 가 비어 있을 수 있다. 먼저 걸러낸다.
  if (e.killed === true) {
    return { detail: 'CLI 가 제한 시간 안에 끝나지 않아 중단했습니다.', enoent: false }
  }
  const detail =
    str(e.stderr?.trim()) ??
    str(e.stdout?.trim()) ??
    str(e.message) ??
    String(err)
  return { detail, enoent }
}

/**
 * 작업 하나를 수행한다.
 *
 * 예외를 던지지 않는다 — renderer 까지 올라가면 UI 가 통째로 멈춘다.
 * 성공·실패 모두 PluginOpResult 로 돌려주고, UI 는 결과만 보고 말한다.
 */
export async function runPluginOp(op: PluginOp): Promise<PluginOpResult> {
  const base = { op: op.op } as const

  let stdout: string
  try {
    const result = await execFileAsync('claude', argsFor(op), {
      timeout: CLI_TIMEOUT_MS,
      // 카탈로그가 큰 마켓플레이스에서는 출력이 기본 1MB 를 넘을 수 있다.
      maxBuffer: 16 * 1024 * 1024
    })
    stdout = result.stdout
  } catch (err) {
    /*
      비영 종료 코드. 이 경우에도 --json 줄이 있으면 그쪽 메시지가
      stderr 보다 구체적이다(failureCode 가 붙는다). 먼저 본다.
    */
    const e = err as { stdout?: string }
    const json = typeof e.stdout === 'string' ? findJsonLine(e.stdout) : null
    if (json) {
      return {
        ok: false,
        ...base,
        ...(str(json.message) ? { message: str(json.message)! } : {}),
        ...(str(json.failureCode) ? { failureCode: str(json.failureCode)! } : {}),
        error: str(json.message) ?? '작업이 실패했습니다.'
      }
    }

    const { detail, enoent } = detailFrom(err)
    return {
      ok: false,
      ...base,
      error: enoent ? `${detail} (claude CLI 를 PATH 에서 찾지 못했습니다)` : detail
    }
  }

  const json = findJsonLine(stdout)

  /*
    --json 을 붙이지 않은 전체 갱신은 JSON 이 없는 것이 정상이다.
    종료 코드가 0 으로 돌아왔다는 사실만으로 성공으로 본다.
  */
  if (!json) {
    if (op.op === 'marketplaceUpdateAll') {
      return { ok: true, ...base, message: stdout.trim() || '전체 갱신을 마쳤습니다.' }
    }
    /*
      JSON 을 기대했는데 없다. 종료 코드가 0 이어도 성공이라고 단정하지
      않는다 — 결과를 읽지 못한 것과 성공한 것은 다르고, 여기서 성공으로
      보고하면 사용자가 바뀌지 않은 상태를 바뀐 것으로 믿는다.
    */
    return {
      ok: false,
      ...base,
      error: `CLI 응답을 읽지 못했습니다. 출력: ${stdout.trim().slice(0, 300) || '(없음)'}`
    }
  }

  const failed = json.outcome === 'failed'
  const message = str(json.message)
  const updateOutcome =
    json.updateOutcome === 'updated' || json.updateOutcome === 'up_to_date'
      ? json.updateOutcome
      : undefined

  return {
    ok: !failed,
    ...base,
    ...(message ? { message } : {}),
    ...(str(json.failureCode) ? { failureCode: str(json.failureCode)! } : {}),
    ...(updateOutcome ? { updateOutcome } : {}),
    ...(str(json.oldVersion) ? { oldVersion: str(json.oldVersion)! } : {}),
    ...(str(json.newVersion) ? { newVersion: str(json.newVersion)! } : {}),
    ...(failed ? { error: message ?? '작업이 실패했습니다.' } : {})
  }
}
