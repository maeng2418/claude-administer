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
 *  2. 한 키만 — 담당 키(skillOverrides 또는 enabledPlugins) 외의 키는
 *     읽은 그대로 되돌려 쓴다.
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
  /**
   * marketplaceAutoUpdate 전용: 항목을 새로 만들 때 쓸 source 블록.
   *
   * 레지스트리(known_marketplaces.json)에서 읽어 넘긴다. settings.json 에
   * 아직 항목이 없는 마켓플레이스를 켜려면 이 값이 있어야 한다.
   */
  marketplaceSource?: Record<string, unknown>
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
 * 마켓플레이스 자동 갱신: extraKnownMarketplaces[name].autoUpdate
 *
 * 다른 두 메커니즘과 달리 값만 바꿔서는 안 된다. 이 항목은 source 가
 * 있어야 유효하고(autoUpdate 만 있는 항목은 Claude Code 가 무시한다),
 * 레지스트리에만 있고 settings.json 에는 없는 마켓플레이스가 실제로
 * 존재한다(실측: 11곳 중 2곳). 그래서 항목이 없을 때는 호출하는 쪽이
 * 넘겨준 source 로 완전한 항목을 새로 만든다.
 *
 * source 없이 없는 항목을 켜달라는 요청은 거부한다 — 무효한 항목을
 * 남기면 사용자는 켰다고 믿는데 아무 일도 일어나지 않는다.
 *
 * 끌 때도 항목을 지우지 않고 autoUpdate: false 를 명시한다. 지우면
 * 기본값으로 돌아가는데, 공식 마켓플레이스의 기본값은 '켜짐' 이라서
 * "껐다" 가 "켜짐" 이 되는 경우가 생긴다.
 */
function planMarketplaceAutoUpdate(
  key: string,
  enabled: boolean,
  source?: Record<string, unknown>
): MechanismPlan {
  return {
    // extraKnownMarketplaces 가 아직 없는 설정도 있을 수 있다.
    createsKey: 'extraKnownMarketplaces',
    apply(settings) {
      const known = objectClone(settings['extraKnownMarketplaces'])
      const existing = known[key]
      const entry = objectClone(existing)

      if (!existing) {
        if (!source) {
          return {
            ok: false,
            error: `settings.json 에 "${key}" 항목이 없고 출처 정보도 없어 새로 만들 수 없습니다.`
          }
        }
        entry['source'] = source
      }

      entry['autoUpdate'] = enabled
      known[key] = entry
      return { ok: true, settings: { ...settings, extraKnownMarketplaces: known } }
    },
    verify(settings) {
      const known = settings['extraKnownMarketplaces']
      if (!known || typeof known !== 'object') return false
      const entry = (known as Record<string, unknown>)[key]
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
      const record = entry as Record<string, unknown>
      // source 가 함께 남아 있는지도 본다 — 값만 맞고 source 가 없으면 무효한 항목이다.
      return record['autoUpdate'] === enabled && record['source'] !== undefined
    }
  }
}

/** 요청을 변경 계획으로 바꾼다. */
function planFor(
  mechanism: ToggleMechanism,
  key: string,
  enabled: boolean,
  source?: Record<string, unknown>
): MechanismPlan {
  switch (mechanism) {
    case 'enabledPlugins':
      return planEnabledPlugins(key, enabled)
    case 'skillOverrides':
      return planSkillOverrides(key, enabled)
    case 'marketplaceAutoUpdate':
      return planMarketplaceAutoUpdate(key, enabled, source)
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
    const plan = planFor(mechanism, key, enabled, options.marketplaceSource)
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
