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

  const strict = tryParse(yamlBlock)
  if (strict.ok) return { data: strict.data }

  // 엄격한 YAML 이 실패하면 따옴표 없는 힌트 줄을 문자열로 돌려 한 번 더 시도한다.
  const relaxed = tryParse(quoteHintLines(yamlBlock))
  if (relaxed.ok) return { data: relaxed.data }

  // 두 번 다 실패했으면 진짜로 깨진 파일이다. 원래 사유를 남긴다.
  return { data: {}, error: strict.error }
}

/** 한 번의 파싱 시도. 성공 여부를 값으로 돌려준다. */
function tryParse(
  block: string
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed = parseYaml(block)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'frontmatter 가 키-값 형태가 아닙니다' }
    }
    return { ok: true, data: parsed as Record<string, unknown> }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 따옴표 없이 대괄호를 쓰는 힌트 줄을 문자열 리터럴로 감싼다.
 *
 * Claude Code 는 이 값들을 YAML 타입이 아니라 사람이 읽을 문자열로 쓴다.
 * 그래서 아래가 정상적인 파일인데,
 *
 *     argument-hint: [list|save|load] [name]
 *
 * YAML 로는 `[` 가 flow sequence 시작이라 `]` 뒤에 또 값이 와서 깨진다
 * (실측: diagram-design/profile.md line 2, column 58). 실제로 74개 파일이
 * 이 필드에 대괄호를 쓰고, 그중 따옴표를 생략한 것들이 모두 걸린다.
 *
 * 파서가 Claude Code 보다 엄격해서 멀쩡한 파일을 못 읽는 것이므로,
 * 이 필드들만 문자열로 보고 다시 읽는다.
 */
const HINT_KEYS = ['argument-hint', 'argument_hint', 'arguments']

function quoteHintLines(block: string): string {
  return block
    .split('\n')
    .map((line) => {
      const match = /^(\s*)([A-Za-z_][\w-]*)\s*:\s*(.+?)\s*$/.exec(line)
      if (!match) return line
      const [, indent, key, rawValue] = match
      if (!key || !rawValue || !HINT_KEYS.includes(key)) return line
      // 이미 따옴표로 감쌌으면 그대로 둔다.
      const quoted = /^(["']).*\1$/.test(rawValue)
      if (quoted) return line
      // 대괄호나 중괄호가 없으면 YAML 이 깨질 이유가 없다.
      if (!/[[\]{}]/.test(rawValue)) return line
      // 작은따옴표를 이스케이프해 단일 인용 문자열로 만든다.
      return `${indent}${key}: '${rawValue.replace(/'/g, "''")}'`
    })
    .join('\n')
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
