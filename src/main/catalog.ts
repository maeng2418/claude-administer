import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CatalogPlugin, CatalogResult, ScanIssue } from '../shared/types.js'

/**
 * 설치할 수 있는 플러그인 카탈로그.
 *
 * 각 마켓플레이스의 `.claude-plugin/marketplace.json` 을 읽어 모은다.
 * 실측 기준 11곳에서 2,619개가 나오고, 한 곳(claude-community)이 2,282개를
 * 차지한다. 그래서 두 가지를 지킨다:
 *
 *  1. 설명을 줄여 담는다. 원문 설명이 수백 자인 항목이 있어서 전부
 *     들고 가면 IPC 로 수 MB 를 넘긴다 — renderer 는 목록에서 한 줄만
 *     보여주므로 그 길이만 넘긴다.
 *  2. 한 곳이 깨져도 전체를 실패시키지 않는다. 읽지 못한 마켓플레이스는
 *     issues 로 모아 UI 에 알린다.
 */

/** 목록 한 줄에 들어가는 길이. 넘는 설명은 자른다. */
const DESCRIPTION_LIMIT = 200

/** marketplace.json 의 plugins 항목 하나. */
interface RawCatalogEntry {
  name?: unknown
  description?: unknown
  author?: unknown
  category?: unknown
  homepage?: unknown
}

interface RawCatalog {
  plugins?: unknown
}

/** 문자열이면 그대로, 아니면 undefined. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 설명을 한 줄로 만든다.
 *
 * 개행과 연속 공백을 한 칸으로 접는 이유: 원문에 여러 줄 설명과 불릿
 * 목록이 들어있고, 그대로 넘기면 목록 행이 들쭉날쭉해진다.
 */
function oneLine(value: unknown): string | undefined {
  const text = str(value)
  if (!text) return undefined
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat === '') return undefined
  return flat.length > DESCRIPTION_LIMIT
    ? `${flat.slice(0, DESCRIPTION_LIMIT - 1)}…`
    : flat
}

/**
 * author 를 문자열로 만든다.
 *
 * 스키마가 두 모양을 허용한다 — 문자열이거나 `{name, url}` 객체다.
 * 객체일 때 name 만 쓰는 이유는 목록에 한 줄로 들어가기 때문이다.
 */
function authorOf(value: unknown): string | undefined {
  if (typeof value === 'string') return str(value)
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return str((value as { name?: unknown }).name)
  }
  return undefined
}

/**
 * 마켓플레이스 한 곳의 카탈로그를 읽는다.
 *
 * @param installLocation 마켓플레이스가 체크아웃된 디렉토리
 * @param marketplace 마켓플레이스 이름 (플러그인 ID 조합에 쓴다)
 * @param installedIds 이미 설치된 플러그인 ID 목록
 */
async function readOne(
  installLocation: string,
  marketplace: string,
  installedIds: Set<string>,
  issues: ScanIssue[]
): Promise<CatalogPlugin[]> {
  const path = join(installLocation, '.claude-plugin', 'marketplace.json')

  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    const code = (err as { code?: string }).code
    /*
      카탈로그가 없는 마켓플레이스가 있다. 그 자체는 고장이 아니라
      "설치할 것이 없다" 는 뜻이므로 경고를 만들지 않는다 — 경고를
      띄우면 사용자가 고칠 것이 없는 문제를 보게 된다.
    */
    if (code === 'ENOENT') return []
    issues.push({
      path,
      message: err instanceof Error ? err.message : String(err)
    })
    return []
  }

  let parsed: RawCatalog
  try {
    parsed = JSON.parse(raw) as RawCatalog
  } catch (err) {
    issues.push({
      path,
      message: `카탈로그 파싱 실패: ${err instanceof Error ? err.message : String(err)}`
    })
    return []
  }

  if (!Array.isArray(parsed.plugins)) return []

  const out: CatalogPlugin[] = []
  for (const value of parsed.plugins) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as RawCatalogEntry
    const name = str(entry.name)
    if (!name) continue

    const description = oneLine(entry.description)
    const author = authorOf(entry.author)
    const category = str(entry.category)
    const homepage = str(entry.homepage)

    out.push({
      name,
      marketplace,
      ...(description ? { description } : {}),
      ...(author ? { author } : {}),
      ...(category ? { category } : {}),
      ...(homepage ? { homepage } : {}),
      installed: installedIds.has(`${name}@${marketplace}`)
    })
  }
  return out
}

/** 카탈로그를 읽을 대상 하나. */
export interface CatalogTarget {
  name: string
  installLocation: string
}

/**
 * 모든 마켓플레이스의 카탈로그를 모아 읽는다.
 *
 * 마켓플레이스별로 병렬로 읽는다 — 서로 다른 디렉토리라 순서가 의미
 * 없고, 11곳을 순차로 읽으면 디스크 대기가 그대로 더해진다.
 */
export async function collectCatalog(
  targets: CatalogTarget[],
  installedIds: string[]
): Promise<CatalogResult> {
  const installed = new Set(installedIds)
  const issues: ScanIssue[] = []

  const lists = await Promise.all(
    targets.map((target) =>
      readOne(target.installLocation, target.name, installed, issues)
    )
  )

  const plugins = lists.flat()

  /*
    이름순으로 정렬한다. 마켓플레이스별로 묶지 않는 이유: renderer 는
    검색으로 걸러 쓰고, 검색 결과에서는 어느 출처에서 왔는지가 행의
    배지로 보인다. 출처로 묶으면 검색 결과가 여러 덩어리로 쪼개진다.
  */
  plugins.sort(
    (a, b) => a.name.localeCompare(b.name) || a.marketplace.localeCompare(b.marketplace)
  )

  return { plugins, issues }
}
