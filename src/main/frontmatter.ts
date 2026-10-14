import { parse as parseYaml } from 'yaml'

/**
 * Markdown 파일 앞부분의 YAML frontmatter 를 읽는다.
 *
 * Claude Code 자산(SKILL.md, 에이전트/커맨드 .md)은 description 안에 콜론·따옴표·
 * 멀티라인이 흔해서 직접 만든 정규식 파서로는 깨진다. 그래서 yaml 라이브러리를 쓴다.
 */

/** frontmatter 를 읽어낸 결과. 본문은 UI 가 쓰지 않으므로 돌려주지 않는다. */
export interface Frontmatter {
  /** 파싱된 키-값. frontmatter 가 없거나 깨지면 빈 객체. */
  data: Record<string, unknown>
  /** 파싱이 실패한 경우의 사유. 스캔을 멈추지 않고 issue 로 모은다. */
  error?: string
}

const FM_DELIMITER = /^---[ \t]*\r?\n/

/**
 * 파일 전체 내용에서 frontmatter 블록만 떼어 파싱한다.
 *
 * frontmatter 가 없는 파일은 에러가 아니다 — 빈 data 를 돌려준다.
 * YAML 이 깨진 경우에만 error 를 채운다.
 */
export function parseFrontmatter(content: string): Frontmatter {
  // BOM 이 있으면 구분자 매칭이 실패하므로 먼저 제거한다.
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content

  if (!FM_DELIMITER.test(text)) {
    return { data: {} }
  }

  const afterOpen = text.replace(FM_DELIMITER, '')

  // 닫는 구분자를 줄 단위로 찾는다. 본문 안의 `---` 를 잘못 잡지 않도록
  // 줄 전체가 `---` 인 첫 지점만 인정한다.
  const lines = afterOpen.split(/\r?\n/)
  const closeIndex = lines.findIndex((line) => line.trimEnd() === '---')

  if (closeIndex === -1) {
    return { data: {}, error: 'frontmatter 닫는 --- 구분자를 찾지 못했습니다' }
  }

  const yamlBlock = lines.slice(0, closeIndex).join('\n')

  if (yamlBlock.trim() === '') {
    return { data: {} }
  }

  try {
    const parsed = parseYaml(yamlBlock)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { data: {}, error: 'frontmatter 가 키-값 형태가 아닙니다' }
    }
    return { data: parsed as Record<string, unknown> }
  } catch (err) {
    return { data: {}, error: err instanceof Error ? err.message : String(err) }
  }
}

/** frontmatter 값을 문자열로 꺼낸다. 없거나 타입이 다르면 undefined. */
export function readString(
  data: Record<string, unknown>,
  key: string
): string | undefined {
  const value = data[key]
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return undefined
}

/**
 * frontmatter 값을 문자열 배열로 정규화한다.
 *
 * 에이전트의 tools 필드는 실제로 두 형태가 섞여 있다 —
 * `tools: Read, Write` (CSV 문자열) 와 `tools: [Read, Write]` (배열).
 * 양쪽 모두 배열로 맞춘다.
 */
export function readStringList(
  data: Record<string, unknown>,
  key: string
): string[] | undefined {
  const value = data[key]

  if (Array.isArray(value)) {
    const items = value
      .filter((v): v is string | number | boolean => v !== null && typeof v !== 'object')
      .map((v) => String(v).trim())
      .filter((v) => v !== '')
    return items.length > 0 ? items : undefined
  }

  if (typeof value === 'string') {
    const items = value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== '')
    return items.length > 0 ? items : undefined
  }

  return undefined
}
