import { copyFile, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { userClaudeRoot } from './scanner.js'
import type { ToggleResult } from '../shared/types.js'

/**
 * settings.json 쓰기. 이 프로젝트에서 유일하게 파괴적인 코드다.
 *
 * settings.json 은 64KB 짜리 사용자 설정 전체이고, 망가지면 Claude Code 가
 * 뜨지 않는다. 그래서 네 가지를 지킨다:
 *
 *  1. 백업 먼저 — 쓰기 전에 타임스탬프 사본을 만든다.
 *  2. 한 키만 — enabledPlugins 외의 키는 읽은 그대로 되돌려 쓴다.
 *  3. 원자적 교체 — 임시 파일에 쓰고 rename 한다. 쓰기 중 종료되어도
 *     원본이 반쯤 덮인 상태로 남지 않는다.
 *  4. 되읽어 검증 — 쓴 뒤 다시 파싱해서 의도한 값인지 확인한다.
 *     실패하면 백업에서 즉시 복구한다.
 */

/** settings.json 경로. */
function settingsPath(): string {
  return join(userClaudeRoot(), 'settings.json')
}

/**
 * 테스트에서 대상 파일을 명시적으로 주입하기 위한 옵션.
 *
 * 환경변수(HOME)를 바꿔 경로를 돌리는 방식은 전역 상태에 의존해서
 * 검증 코드가 실수로 실제 파일을 보게 되기 쉽다. 경로를 인자로 받으면
 * 그런 혼동이 구조적으로 불가능해진다.
 */
export interface ToggleOptions {
  /** 쓰기 대상 settings.json 경로. 생략하면 사용자 홈의 실제 파일. */
  path?: string
}

/** 되돌릴 수 있도록 타임스탬프 백업을 만든다. 백업 경로를 돌려준다. */
async function backupSettings(path: string): Promise<string> {
  // 파일명에 콜론이 들어가지 않도록 ISO 문자열을 정리한다.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${path}.bak-${stamp}`
  await copyFile(path, backupPath)
  return backupPath
}

/**
 * 플러그인 활성 상태를 토글한다.
 *
 * 성공/실패 모두 ToggleResult 로 돌려준다 — 예외를 renderer 까지 던지지 않는다.
 * UI 는 결과만 보고 상태를 갱신하거나 오류를 띄운다.
 */
export async function togglePlugin(
  pluginId: string,
  enabled: boolean,
  options: ToggleOptions = {}
): Promise<ToggleResult> {
  const path = options.path ?? settingsPath()
  let backupPath: string | undefined

  try {
    // 1. 현재 내용을 읽고 파싱한다. 파싱 실패 시 아예 쓰지 않는다 —
    //    이미 깨진 파일에 덮어쓰면 복구 불가능한 상태가 된다.
    const raw = await readFile(path, 'utf8')
    let settings: Record<string, unknown>
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          ok: false,
          pluginId,
          enabled,
          error: 'settings.json 이 객체 형태가 아닙니다. 쓰기를 중단했습니다.'
        }
      }
      settings = parsed as Record<string, unknown>
    } catch (err) {
      return {
        ok: false,
        pluginId,
        enabled,
        error: `settings.json 파싱 실패로 쓰기를 중단했습니다: ${
          err instanceof Error ? err.message : String(err)
        }`
      }
    }

    // 2. 대상 플러그인이 실제로 존재하는지 확인한다.
    //    없는 키를 새로 만들면 설정에 유령 항목이 남는다.
    const current = settings['enabledPlugins']
    const enabledPlugins: Record<string, unknown> =
      current && typeof current === 'object' && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>) }
        : {}

    if (!(pluginId in enabledPlugins)) {
      return {
        ok: false,
        pluginId,
        enabled,
        error: `enabledPlugins 에 "${pluginId}" 항목이 없습니다. 쓰기를 중단했습니다.`
      }
    }

    // 3. 백업.
    backupPath = await backupSettings(path)

    // 4. 한 키만 바꾼 새 객체를 만든다. 나머지 키는 그대로 유지된다.
    enabledPlugins[pluginId] = enabled
    const next = { ...settings, enabledPlugins }

    // 5. 임시 파일에 쓰고 원자적으로 교체한다.
    //    들여쓰기 2칸 + 끝 개행은 Claude Code 가 쓰는 형식과 같다.
    const tmpPath = `${path}.tmp-${process.pid}`
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    await rename(tmpPath, path)

    // 6. 되읽어 검증한다. 의도한 값이 아니면 백업에서 복구한다.
    const verifyRaw = await readFile(path, 'utf8')
    const verify = JSON.parse(verifyRaw) as Record<string, unknown>
    const verifyPlugins = verify['enabledPlugins'] as Record<string, unknown> | undefined
    if (!verifyPlugins || verifyPlugins[pluginId] !== enabled) {
      await copyFile(backupPath, path)
      return {
        ok: false,
        pluginId,
        enabled,
        backupPath,
        error: '쓰기 후 검증이 실패해 백업에서 복구했습니다.'
      }
    }

    // 다른 키가 유실되지 않았는지도 확인한다.
    const beforeKeys = Object.keys(settings).sort().join(',')
    const afterKeys = Object.keys(verify).sort().join(',')
    if (beforeKeys !== afterKeys) {
      await copyFile(backupPath, path)
      return {
        ok: false,
        pluginId,
        enabled,
        backupPath,
        error: '설정 키 구성이 바뀌어 백업에서 복구했습니다.'
      }
    }

    return { ok: true, pluginId, enabled, backupPath }
  } catch (err) {
    // 예상 못한 실패. 백업이 있으면 되돌린다.
    if (backupPath) {
      try {
        await copyFile(backupPath, path)
      } catch {
        // 복구까지 실패하면 백업 경로를 오류 메시지에 남겨 수동 복구를 돕는다.
      }
    }
    return {
      ok: false,
      pluginId,
      enabled,
      backupPath,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}
