import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { shell } from 'electron'
import type { RemoveRequest, RemoveResult } from '../shared/types.js'

/**
 * 자산 제거.
 *
 * 두 가지 방식만 쓴다:
 *
 *  1. 휴지통 — 파일과 디렉토리는 shell.trashItem() 으로 macOS 휴지통에 넣는다.
 *     직접 unlink 하지 않는 이유는 되돌릴 방법을 남겨두기 위해서다. 사용자가
 *     직접 쓴 47KB SKILL.md 를 영구 삭제하면 복구할 길이 없다.
 *
 *  2. 공식 CLI — 플러그인은 `claude plugin uninstall` 에 맡긴다.
 *     installed_plugins.json 과 plugins/cache/ 는 Claude Code 가 소유하는
 *     파일이고, 그 포맷에 맞춰 직접 쓰면 Claude Code 의 플러그인 상태와
 *     어긋날 수 있다. 영구 삭제지만 재설치가 가능하다.
 */

const execFileAsync = promisify(execFile)

/** CLI 가 멈춰도 UI 가 영구히 기다리지 않도록 하는 상한. */
const UNINSTALL_TIMEOUT_MS = 60_000

/** 경로를 휴지통으로 보낸다. */
async function trashPath(target: string): Promise<RemoveResult> {
  const base: Pick<RemoveResult, 'mechanism' | 'target'> = {
    mechanism: 'trash',
    target
  }

  // 없는 경로를 휴지통에 넣으려 하면 예외가 난다. 먼저 확인해 사유를 분명히 한다.
  try {
    await stat(target)
  } catch {
    return { ok: false, ...base, error: '대상이 이미 없습니다.' }
  }

  try {
    await shell.trashItem(target)
    return { ok: true, ...base, trashed: true }
  } catch (err) {
    return {
      ok: false,
      ...base,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/** `claude plugin uninstall` 의 --json 출력 한 줄. */
interface UninstallJson {
  ok?: unknown
  error?: unknown
  message?: unknown
}

/**
 * 플러그인을 공식 CLI 로 제거한다.
 *
 * --json 으로 기계 판독 가능한 결과를, -y 로 비대화형 확인 생략을 받는다
 * (stdout 이 TTY 가 아닐 때 -y 가 필요하다).
 */
async function uninstallPlugin(pluginId: string): Promise<RemoveResult> {
  const base: Pick<RemoveResult, 'mechanism' | 'target'> = {
    mechanism: 'pluginUninstall',
    target: pluginId
  }

  try {
    const { stdout } = await execFileAsync(
      'claude',
      ['plugin', 'uninstall', pluginId, '--json', '-y'],
      { timeout: UNINSTALL_TIMEOUT_MS }
    )

    // --json 은 한 줄을 내놓는다고 문서화돼 있지만, 형식이 달라져도
    // 종료 코드 0 이면 성공으로 본다 — 실패는 아래 catch 로 온다.
    const line = stdout.trim().split('\n').pop() ?? ''
    try {
      const parsed = JSON.parse(line) as UninstallJson
      if (parsed.ok === false) {
        const reason =
          typeof parsed.error === 'string'
            ? parsed.error
            : typeof parsed.message === 'string'
              ? parsed.message
              : line
        return { ok: false, ...base, error: reason }
      }
    } catch {
      // JSON 이 아니어도 종료 코드가 0 이면 성공으로 둔다.
    }
    return { ok: true, ...base, trashed: false }
  } catch (err) {
    // CLI 가 비영 종료 코드를 내면 stderr 를 그대로 전달한다 —
    // 우리가 사유를 다시 쓰면 실제 원인이 가려진다.
    const e = err as { stderr?: string; stdout?: string; message?: string; code?: string }
    const detail =
      (typeof e.stderr === 'string' && e.stderr.trim() !== '' ? e.stderr.trim() : '') ||
      (typeof e.stdout === 'string' && e.stdout.trim() !== '' ? e.stdout.trim() : '') ||
      e.message ||
      String(err)
    const hint =
      e.code === 'ENOENT'
        ? ' (claude CLI 를 PATH 에서 찾지 못했습니다)'
        : ''
    return { ok: false, ...base, error: `${detail}${hint}` }
  }
}

/**
 * 제거를 수행한다.
 *
 * 경로 허용 여부는 호출하는 쪽(main/index.ts)이 이미 검사한 뒤 넘긴다 —
 * 이 모듈은 어떤 경로가 허용 범위인지 모르고, 알아야 할 이유도 없다.
 */
export async function removeAsset(request: RemoveRequest): Promise<RemoveResult> {
  switch (request.mechanism) {
    case 'trash':
      return trashPath(request.target)
    case 'pluginUninstall':
      return uninstallPlugin(request.target)
  }
}
