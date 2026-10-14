/**
 * 공유 타입 정의.
 * main 프로세스(스캐너)와 renderer(UI)가 같은 모양을 쓰도록 한 곳에 모아둔다.
 */

/** 자산이 어느 범위에 설치됐는지. 같은 이름이 양쪽에 있으면 project 가 user 를 덮는다. */
export type Scope = 'user' | 'project' | 'plugin'

/** 좌측 사이드바 탭과 1:1 대응되는 자산 종류. */
export type AssetKind = 'skill' | 'agent' | 'command' | 'hook' | 'plugin' | 'mcp'

/** 모든 자산이 공유하는 필드. */
export interface AssetBase {
  kind: AssetKind
  /** 자산 식별자. 같은 kind 안에서 충돌 판정의 기준이 된다. */
  name: string
  scope: Scope
  /** 파일/디렉토리 절대 경로. "에디터로 열기" 대상. */
  path: string
  description?: string
  /** 이 자산이 비활성 상태인지 (현재는 플러그인에만 해당). */
  disabled?: boolean
  /**
   * 같은 kind·같은 name 이 다른 scope 에도 존재할 때 그 scope 목록.
   * 비어있지 않으면 UI 에 충돌 배지를 띄운다.
   */
  shadowedBy?: Scope[]
}

export interface SkillAsset extends AssetBase {
  kind: 'skill'
  /** SKILL.md frontmatter 의 trigger 필드 (예: /graphify). */
  trigger?: string
  /** 플러그인이 제공한 스킬이면 그 플러그인 ID. */
  sourcePlugin?: string
}

export interface AgentAsset extends AssetBase {
  kind: 'agent'
  /** frontmatter tools 필드. 문자열(CSV)이든 배열이든 배열로 정규화한다. */
  tools?: string[]
  model?: string
}

export interface CommandAsset extends AssetBase {
  kind: 'command'
  /** 실제 호출 문자열 (예: /humanize, /stay:jira). */
  invocation: string
  sourcePlugin?: string
}

/** settings.json 의 hooks 항목 하나. */
export interface HookAsset extends AssetBase {
  kind: 'hook'
  /** SessionStart, PreToolUse 등 훅 이벤트 이름. */
  event: string
  /** 어떤 툴에 걸리는지. 빈 문자열이면 전체 대상. */
  matcher: string
  /** 실행되는 명령 전문. */
  command: string
  type: string
  timeout?: number
  async?: boolean
  /** settings.json 상의 위치. 편집 시 역추적용. */
  index: number
}

export interface PluginAsset extends AssetBase {
  kind: 'plugin'
  /** installed_plugins.json 의 키 (예: caveman@caveman). */
  id: string
  marketplace: string
  version?: string
  installedAt?: string
  /** settings.json enabledPlugins 값. 토글 대상. */
  enabled: boolean
  /** 이 플러그인이 제공하는 자산 개수. */
  provides: { skills: number; agents: number; commands: number }
}

export interface McpAsset extends AssetBase {
  kind: 'mcp'
  /** stdio 서버면 실행 명령, 그 외에는 transport 종류. */
  transport: string
  command?: string
  args?: string[]
}

export type Asset =
  | SkillAsset
  | AgentAsset
  | CommandAsset
  | HookAsset
  | PluginAsset
  | McpAsset

/** 스캔 중 생긴 문제. 스캔 전체를 실패시키지 않고 UI 에 모아 보여준다. */
export interface ScanIssue {
  path: string
  message: string
}

/** 스캔 한 번의 결과 전체. */
export interface Inventory {
  scannedAt: string
  /** 스캔한 사용자 홈의 .claude 경로. */
  userRoot: string
  /** 스캔한 프로젝트의 .claude 경로. 프로젝트가 없으면 null. */
  projectRoot: string | null
  skills: SkillAsset[]
  agents: AgentAsset[]
  commands: CommandAsset[]
  hooks: HookAsset[]
  plugins: PluginAsset[]
  mcp: McpAsset[]
  issues: ScanIssue[]
}

/** 플러그인 토글 결과. 백업 경로를 함께 돌려줘 UI 에서 되돌릴 근거를 보여준다. */
export interface ToggleResult {
  ok: boolean
  pluginId: string
  enabled: boolean
  /** 수정 직전에 만든 settings.json 백업 경로. */
  backupPath?: string
  error?: string
}

/** renderer 가 preload 를 통해 쓸 수 있는 API. window.api 로 노출된다. */
export interface AdminApi {
  scan(): Promise<Inventory>
  togglePlugin(pluginId: string, enabled: boolean): Promise<ToggleResult>
  openPath(path: string): Promise<{ ok: boolean; error?: string }>
  revealPath(path: string): Promise<{ ok: boolean; error?: string }>
}
