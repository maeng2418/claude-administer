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

/**
 * 캐시 유효 시간.
 *
 * 창과 팝오버가 각각 1분마다 호출하면 분당 2회가 되고, 아이콘을 누를
 * 때마다 한 번이 더해진다. 실측으로 HTTP 429 를 받았다. 둘이 같은
 * readUsage() 를 거치므로 여기서 한 번 받아 나눠 주면 호출이 분당
 * 1회로 떨어진다.
 *
 * 55초인 이유: 호출 주기(60초)보다 짧아야 한 주기에 한 번은 실제로
 * 갱신된다. 60초로 맞추면 타이머가 조금만 빨라도 캐시가 계속 살아
 * 값이 영영 묵는다.
 */
const CACHE_TTL_MS = 55_000

/**
 * 429 를 받은 뒤 쉬는 시간.
 *
 * 429 는 "너무 잦다" 는 뜻이라 같은 간격으로 또 치면 풀리지 않는다.
 * 성공하면 즉시 원복하므로, 한 번 막혔다고 오래 묶이지는 않는다.
 */
const BACKOFF_MS = 5 * 60_000

/**
 * 마지막 조회 결과. 두 창이 나눠 쓴다.
 *
 * 실패도 담는다 — 토큰이 없는 상태에서 1분마다 키체인을 다시 읽을
 * 이유가 없다.
 */
let cached: { at: number; result: UsageReadResult } | null = null

/**
 * 마지막으로 성공한 결과. 실패가 덮어쓰지 않는다.
 *
 * 백오프 중에 보여줄 값이다. 429 를 받았다고 화면의 숫자가 오류 문구로
 * 바뀌면, 사용자는 사용량을 볼 수 없는 것으로 오해한다. 조금 묵은
 * 숫자를 그대로 두는 편이 낫다.
 */
let lastOk: UsageReadResult | null = null

/** 이 시각 전에는 호출하지 않는다. 429 를 받으면 미래로 민다. */
let blockedUntil = 0

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
/** 실제 조회. 캐시·백오프는 readUsage() 가 맡는다. */
async function fetchUsage(): Promise<UsageReadResult> {
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

    /*
      429 는 호출이 잦다는 뜻이다. 같은 간격으로 또 치면 풀리지 않으므로
      다음 시도를 뒤로 민다. 사유를 따로 적어 UI 가 "기다리는 중" 이라고
      말할 수 있게 한다 — 로그인 문제로 오해하면 엉뚱한 곳을 고치게 된다.
    */
    if (response.status === 429) {
      blockedUntil = Date.now() + BACKOFF_MS
      return {
        ok: false,
        reason: 'rate-limit',
        error: `요청이 잦아 잠시 멈춥니다. ${Math.round(
          BACKOFF_MS / 60_000
        )}분 뒤 자동으로 다시 시도합니다.`
      }
    }

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

/**
 * 진행 중인 조회.
 *
 * 창과 팝오버가 같은 순간에 부르면 캐시가 아직 비어 있어 둘 다 통과한다.
 * 그 둘이 각각 네트워크를 치면 캐시를 둔 의미가 없으므로, 먼저 시작한
 * 약속을 뒤에 온 쪽이 함께 기다린다.
 */
let inFlight: Promise<UsageReadResult> | null = null

/**
 * 사용량을 읽는다. 창과 팝오버가 공유하는 유일한 진입점이다.
 *
 * 세 겹으로 호출을 줄인다:
 *
 *  1. 캐시 — 55초 안에 받은 값이 있으면 그대로 돌려준다
 *  2. 백오프 — 429 를 받았으면 쉬는 동안 네트워크를 치지 않는다
 *  3. 합류 — 동시에 들어온 호출은 하나의 요청을 함께 기다린다
 *
 * @param force 사용자가 "다시 시도" 를 눌렀을 때. 캐시를 건너뛴다.
 *   백오프는 건너뛰지 않는다 — 막힌 동안 수동으로 또 치면 그 사이에
 *   풀릴 것도 안 풀린다.
 */
export async function readUsage(force = false): Promise<UsageReadResult> {
  const now = Date.now()

  if (!force && cached && now - cached.at < CACHE_TTL_MS) {
    return cached.result
  }

  if (now < blockedUntil) {
    // 쉬는 중이다. 마지막 성공값이 있으면 그것을, 없으면 남은 시간을 알린다.
    if (lastOk) return lastOk
    return {
      ok: false,
      reason: 'rate-limit',
      error: `요청이 잦아 잠시 멈춘 상태입니다. ${Math.ceil(
        (blockedUntil - now) / 60_000
      )}분 뒤 다시 시도합니다.`
    }
  }

  if (inFlight) return inFlight

  inFlight = fetchUsage()
    .then((result) => {
      // 성공하면 백오프를 즉시 푼다 — 한 번 막혔다고 오래 묶일 이유가 없다.
      if (result.ok) {
        blockedUntil = 0
        lastOk = result
      }
      /*
        실패도 캐시한다. 토큰이 없거나 만료된 상태에서 1분마다 키체인을
        다시 읽을 이유가 없고, 429 중에는 직전 값을 돌려줄 근거가 된다.
      */
      cached = { at: Date.now(), result }
      return result
    })
    .finally(() => {
      inFlight = null
    })

  return inFlight
}
