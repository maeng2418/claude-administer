import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { userClaudeRoot } from './scanner.js'
import type { UsageLimit, UsageReadResult, UsageSnapshot } from '../shared/types.js'

/**
 * Claude 구독 사용량 조회.
 *
 * Claude Code 가 쓰는 것과 같은 경로를 쓴다: 로컬에 저장된 OAuth 토큰으로
 * /api/oauth/usage 를 직접 호출한다. 세션을 돌릴 필요가 없고 값은 실시간이다.
 *
 * 토큰 저장 위치는 두 곳이고 Claude Code 도 이 순서로 본다:
 *
 *   1. macOS 키체인 — 서비스 "Claude Code-credentials", 계정은 현재 사용자
 *   2. ~/.claude/.credentials.json — 키체인을 못 쓰는 환경의 평문 대안
 *
 * 토큰은 읽기만 하고 저장하지 않는다. 약 4시간마다 만료되지만 Claude Code 가
 * 갱신하므로, 호출할 때마다 다시 읽으면 최신 값을 얻는다.
 */

const execFileAsync = promisify(execFile)

/** 키체인·네트워크가 멈춰도 UI 가 영구히 기다리지 않도록 하는 상한. */
const KEYCHAIN_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 10_000

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

/** 키체인 서비스 이름. Claude Code 가 쓰는 값 그대로다. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials'

/** 평문 대안 저장소. 키체인이 없는 환경에서 Claude Code 가 쓴다. */
function credentialsPath(): string {
  return join(userClaudeRoot(), '.credentials.json')
}

// ---------------------------------------------------------------------------
// 토큰 읽기
// ---------------------------------------------------------------------------

/** 자격증명 JSON 에서 액세스 토큰을 꺼낸다. 모양이 다르면 null. */
function accessTokenFrom(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const oauth = parsed['claudeAiOauth']
    if (!oauth || typeof oauth !== 'object' || Array.isArray(oauth)) return null
    const token = (oauth as Record<string, unknown>)['accessToken']
    return typeof token === 'string' && token !== '' ? token : null
  } catch {
    return null
  }
}

/**
 * 저장된 OAuth 토큰을 읽는다.
 *
 * 계정(-a)을 반드시 지정한다. 같은 서비스 이름에 계정이 다른 항목이 함께
 * 있을 수 있고, 계정 없이 조회하면 그중 아무거나 — 토큰이 없는 쪽이 —
 * 돌아온다. 실제로 그렇게 생긴 항목이 있었다.
 */
async function readAccessToken(): Promise<string | null> {
  // 1. 키체인 먼저. Claude Code 의 기본 저장소다.
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', process.env['USER'] ?? '', '-w'],
      { timeout: KEYCHAIN_TIMEOUT_MS }
    )
    const token = accessTokenFrom(stdout)
    if (token) return token
  } catch {
    // 항목이 없거나 접근이 거부됐다. 평문 저장소를 본다.
  }

  // 2. 평문 파일. 키체인을 못 쓰는 환경에서 Claude Code 가 쓰는 대안이다.
  try {
    return accessTokenFrom(await readFile(credentialsPath(), 'utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 응답 해석
// ---------------------------------------------------------------------------

/**
 * 한도 하나를 화면용으로 바꾼다.
 *
 * limits 배열을 쓰는 이유는 여기에만 이름이 들어있기 때문이다 — 최상위의
 * five_hour / seven_day 에는 모델별 한도의 이름(scope.model.display_name)이
 * 없어서, Claude 의 사용량 화면과 같은 구성을 만들 수 없다.
 */
function parseLimit(raw: unknown): UsageLimit | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>

  const kind = value['kind']
  if (typeof kind !== 'string' || kind === '') return null

  const percent = value['percent']
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null

  // resets_at 은 ISO 문자열. 없거나 깨졌으면 재설정 줄만 빠진다.
  const resets = value['resets_at']
  const resetsAt = typeof resets === 'string' && resets !== '' ? resets : null

  // 모델별 한도의 이름. 전체 한도에는 없다.
  let scopeLabel: string | null = null
  const scope = value['scope']
  if (scope && typeof scope === 'object' && !Array.isArray(scope)) {
    const model = (scope as Record<string, unknown>)['model']
    if (model && typeof model === 'object' && !Array.isArray(model)) {
      const name = (model as Record<string, unknown>)['display_name']
      if (typeof name === 'string' && name !== '') scopeLabel = name
    }
  }

  return {
    kind,
    percent,
    resetsAt,
    scopeLabel,
    severity: typeof value['severity'] === 'string' ? (value['severity'] as string) : null
  }
}

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------

/**
 * 사용량을 지금 조회한다.
 *
 * 실패는 전부 UsageReadResult 로 돌려준다 — 예외를 renderer 까지 던지지 않는다.
 * reason 으로 원인을 구분해 UI 가 할 말을 고를 수 있게 한다.
 */
export async function readUsage(): Promise<UsageReadResult> {
  const token = await readAccessToken()
  if (!token) {
    return {
      ok: false,
      reason: 'no-token',
      error:
        'Claude Code 로그인 정보를 찾지 못했습니다. 터미널에서 claude 에 로그인돼 있는지 확인해 주세요.'
    }
  }

  let response: Response
  try {
    response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        // Claude Code 클라이언트로 식별되어야 한다. 이 헤더가 없으면
        // 개발자 API 경로로 취급되어 x-api-key 를 요구한다.
        'User-Agent': 'claude-code/2.1.299',
        'anthropic-beta': 'oauth-2025-04-20'
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (err) {
    return {
      ok: false,
      reason: 'network',
      error: `사용량을 가져오지 못했습니다: ${
        err instanceof Error ? err.message : String(err)
      }`
    }
  }

  if (!response.ok) {
    // 401/403 은 토큰이 만료됐거나 권한이 없다는 뜻이다. Claude Code 가
    // 토큰을 갱신하면 저절로 풀리므로, 그 사실을 알려준다.
    const expired = response.status === 401 || response.status === 403
    return {
      ok: false,
      reason: expired ? 'expired' : 'http',
      error: expired
        ? '로그인 정보가 만료된 것 같습니다. Claude Code 를 한 번 실행하면 갱신됩니다.'
        : `사용량 조회 실패 (HTTP ${response.status})`
    }
  }

  let body: Record<string, unknown>
  try {
    body = (await response.json()) as Record<string, unknown>
  } catch (err) {
    return {
      ok: false,
      reason: 'parse',
      error: `응답을 읽지 못했습니다: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  const rawLimits = body['limits']
  const limits = Array.isArray(rawLimits)
    ? rawLimits.map(parseLimit).filter((l): l is UsageLimit => l !== null)
    : []

  if (limits.length === 0) {
    return {
      ok: false,
      reason: 'empty',
      error: '표시할 한도가 없습니다. 구독 상태를 확인해 주세요.'
    }
  }

  const snapshot: UsageSnapshot = { fetchedAt: new Date().toISOString(), limits }
  return { ok: true, snapshot }
}
