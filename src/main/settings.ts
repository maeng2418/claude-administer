import { copyFile, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { userClaudeRoot } from './scanner.js'
import type { ToggleMechanism, ToggleRequest, ToggleResult } from '../shared/types.js'

/**
 * settings.json 쓰기. 이 프로젝트에서 유일하게 파괴적인 코드다.
 *
 * settings.json 은 64KB 짜리 사용자 설정 전체이고, 망가지면 Claude Code 가
 * 뜨지 않는다. 그래서 다섯 가지를 지킨다:
 *
 *  1. 백업 먼저 — 쓰기 전에 타임스탬프 사본을 만든다.
 *  2. 한 키만 — 담당 키 외의 키는 읽은 그대로 되돌려 쓴다.
 *  3. 원자적 교체 — 임시 파일에 쓰고 rename 한다. 쓰기 중 종료되어도
 *     원본이 반쯤 덮인 상태로 남지 않는다.
 *  4. 되읽어 검증 — 쓴 뒤 다시 파싱해서 의도한 값인지 확인한다.
 *     실패하면 백업에서 즉시 복구한다.
 *  5. 깨진 파일은 건드리지 않음 — 파싱이 실패하면 아예 쓰지 않는다.
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
 * 한 메커니즘이 settings.json 에 적용하는 변경 하나.
 *
 * apply 는 읽은 설정을 받아 바뀐 사본을 돌려주고, verify 는 되읽은 설정이
 * 의도대로인지 판정한다. 둘을 짝으로 두는 이유는, 쓰기와 검증이 같은
 * 키·같은 조건을 보도록 한 곳에 묶어두기 위해서다.
 */
type ApplyOutcome =
  | { ok: true; settings: Record<string, unknown> }
  | { ok: false; error: string }

interface MechanismPlan {
  /** 이 변경이 새로 만들어도 되는 최상위 키. 없으면 키 추가를 허용하지 않는다. */
  createsKey?: string
  apply(settings: Record<string, unknown>): ApplyOutcome
  verify(settings: Record<string, unknown>): boolean
}

/** 객체인 값만 얕은 사본으로 돌려준다. 그 외(배열·null·원시값)는 빈 객체. */
function objectClone(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

/** 문자열 배열만 남긴 사본. */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

// ---------------------------------------------------------------------------
// 메커니즘별 변경 계획
// ---------------------------------------------------------------------------

/**
 * 플러그인: enabledPlugins[id] = enabled
 *
 * 이미 존재하는 항목만 바꾼다 — 없는 플러그인 ID 를 새로 넣으면 설정에
 * 유령 항목이 남는다.
 */
function planEnabledPlugins(key: string, enabled: boolean): MechanismPlan {
  return {
    apply(settings) {
      const plugins = objectClone(settings['enabledPlugins'])
      if (!(key in plugins)) {
        return {
          ok: false,
          error: `enabledPlugins 에 "${key}" 항목이 없습니다. 쓰기를 중단했습니다.`
        }
      }
      plugins[key] = enabled
      return { ok: true, settings: { ...settings, enabledPlugins: plugins } }
    },
    verify(settings) {
      const plugins = settings['enabledPlugins']
      if (!plugins || typeof plugins !== 'object') return false
      return (plugins as Record<string, unknown>)[key] === enabled
    }
  }
}

/**
 * 스킬: skillOverrides[name] = "off" / 항목 제거
 *
 * 끌 때는 "off" 를 넣고, 켤 때는 항목을 지운다 — 기본값(켜짐)을 명시하는
 * 값이 없으므로, 지우는 것이 "원래대로"다.
 *
 * 주의: 플러그인이 제공하는 스킬에는 skillOverrides 가 적용되지 않는다.
 * 그 판정은 스캐너가 하고(sourcePlugin 유무), 이 함수는 호출되지 않는다.
 */
function planSkillOverrides(key: string, enabled: boolean): MechanismPlan {
  return {
    // skillOverrides 는 아직 없을 수 있다. 이 경우 새로 만드는 것이 정상이다.
    createsKey: 'skillOverrides',
    apply(settings) {
      const overrides = objectClone(settings['skillOverrides'])
      if (enabled) delete overrides[key]
      else overrides[key] = 'off'
      return { ok: true, settings: { ...settings, skillOverrides: overrides } }
    },
    verify(settings) {
      const overrides = settings['skillOverrides']
      const value =
        overrides && typeof overrides === 'object'
          ? (overrides as Record<string, unknown>)[key]
          : undefined
      return enabled ? value === undefined : value === 'off'
    }
  }
}

/**
 * 에이전트: permissions.deny 에 Agent(name) 추가 / 제거
 *
 * deny 키가 아직 없으면 새로 만든다. allow 목록은 건드리지 않는다 —
 * 지금 57개 항목이 들어있고, 그건 권한 승인 설정이라 끄기와 무관하다.
 */
function planPermissionsDeny(key: string, enabled: boolean): MechanismPlan {
  const entry = `Agent(${key})`
  return {
    createsKey: 'permissions',
    apply(settings) {
      const permissions = objectClone(settings['permissions'])
      const deny = stringArray(permissions['deny'])
      const next = enabled
        ? deny.filter((d) => d !== entry)
        : deny.includes(entry)
          ? deny
          : [...deny, entry]
      return {
        ok: true,
        settings: { ...settings, permissions: { ...permissions, deny: next } }
      }
    },
    verify(settings) {
      const permissions = settings['permissions']
      const deny =
        permissions && typeof permissions === 'object'
          ? stringArray((permissions as Record<string, unknown>)['deny'])
          : []
      return enabled ? !deny.includes(entry) : deny.includes(entry)
    }
  }
}

/** 요청을 변경 계획으로 바꾼다. */
function planFor(mechanism: ToggleMechanism, key: string, enabled: boolean): MechanismPlan {
  switch (mechanism) {
    case 'enabledPlugins':
      return planEnabledPlugins(key, enabled)
    case 'skillOverrides':
      return planSkillOverrides(key, enabled)
    case 'permissionsDeny':
      return planPermissionsDeny(key, enabled)
  }
}

// ---------------------------------------------------------------------------
// 쓰기 본체
// ---------------------------------------------------------------------------

/**
 * 자산 하나를 켜거나 끈다.
 *
 * 성공/실패 모두 ToggleResult 로 돌려준다 — 예외를 renderer 까지 던지지 않는다.
 * UI 는 결과만 보고 상태를 갱신하거나 오류를 띄운다.
 */
export async function toggleAsset(
  request: ToggleRequest,
  options: ToggleOptions = {}
): Promise<ToggleResult> {
  const { mechanism, key, enabled } = request
  const path = options.path ?? settingsPath()
  const fail = (error: string, backupPath?: string): ToggleResult => ({
    ok: false,
    mechanism,
    key,
    enabled,
    ...(backupPath ? { backupPath } : {}),
    error
  })

  if (key === '') return fail('대상 이름이 비어 있습니다.')

  let backupPath: string | undefined

  try {
    // 1. 현재 내용을 읽고 파싱한다. 파싱 실패 시 아예 쓰지 않는다 —
    //    이미 깨진 파일에 덮어쓰면 복구 불가능한 상태가 된다.
    const raw = await readFile(path, 'utf8')
    let settings: Record<string, unknown>
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return fail('settings.json 이 객체 형태가 아닙니다. 쓰기를 중단했습니다.')
      }
      settings = parsed as Record<string, unknown>
    } catch (err) {
      return fail(
        `settings.json 파싱 실패로 쓰기를 중단했습니다: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }

    // 2. 변경 계획을 만든다. 적용 불가 사유가 있으면 쓰기 전에 멈춘다.
    const plan = planFor(mechanism, key, enabled)
    const applied = plan.apply(settings)
    if (!applied.ok) return fail(applied.error)
    const nextSettings = applied.settings

    // 3. 백업.
    backupPath = await backupSettings(path)

    // 4. 임시 파일에 쓰고 원자적으로 교체한다.
    //    들여쓰기 2칸 + 끝 개행은 Claude Code 가 쓰는 형식과 같다.
    const tmpPath = `${path}.tmp-${process.pid}`
    await writeFile(tmpPath, `${JSON.stringify(nextSettings, null, 2)}\n`, 'utf8')
    await rename(tmpPath, path)

    // 5. 되읽어 검증한다. 의도한 값이 아니면 백업에서 복구한다.
    const verifyRaw = await readFile(path, 'utf8')
    const verified = JSON.parse(verifyRaw) as Record<string, unknown>
    if (!plan.verify(verified)) {
      await copyFile(backupPath, path)
      return fail('쓰기 후 검증이 실패해 백업에서 복구했습니다.', backupPath)
    }

    // 6. 다른 키가 유실되지 않았는지 확인한다.
    //    이 변경이 새로 만들기로 한 키 하나만 늘어나는 것을 허용하고,
    //    그 외의 추가·삭제는 전부 실패로 본다.
    const before = new Set(Object.keys(settings))
    const after = new Set(Object.keys(verified))
    const added = [...after].filter((k) => !before.has(k))
    const removed = [...before].filter((k) => !after.has(k))
    const allowedAddition = plan.createsKey
    const additionOk =
      added.length === 0 || (added.length === 1 && added[0] === allowedAddition)
    if (!additionOk || removed.length > 0) {
      await copyFile(backupPath, path)
      return fail(
        `설정 키 구성이 예상과 달라 백업에서 복구했습니다. (추가: ${
          added.join(',') || '없음'
        } / 삭제: ${removed.join(',') || '없음'})`,
        backupPath
      )
    }

    return { ok: true, mechanism, key, enabled, backupPath }
  } catch (err) {
    // 예상 못한 실패. 백업이 있으면 되돌린다.
    if (backupPath) {
      try {
        await copyFile(backupPath, path)
      } catch {
        // 복구까지 실패하면 백업 경로를 오류 메시지에 남겨 수동 복구를 돕는다.
      }
    }
    return fail(err instanceof Error ? err.message : String(err), backupPath)
  }
}
