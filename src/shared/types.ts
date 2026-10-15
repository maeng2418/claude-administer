/**
 * 공유 타입 정의.
 * main 프로세스(스캐너)와 renderer(UI)가 같은 모양을 쓰도록 한 곳에 모아둔다.
 */

/** 자산이 어느 범위에 설치됐는지. 같은 이름이 양쪽에 있으면 project 가 user 를 덮는다. */
export type Scope = 'user' | 'project' | 'plugin'

/** 좌측 사이드바 탭과 1:1 대응되는 자산 종류. */
export type AssetKind =
  | 'skill'
  | 'agent'
  | 'command'
  | 'hook'
  | 'plugin'
  | 'mcp'
  | 'marketplace'

/**
 * 자산을 끄는 방법. settings.json 의 어느 키를 쓰는지가 종류마다 다르다.
 *
 *  - skillOverrides: 전역·프로젝트 스킬 — settings.json 의 skillOverrides[name] = "off"
 *  - enabledPlugins: 플러그인 — enabledPlugins[id] = false
 *  - marketplaceAutoUpdate: 마켓플레이스 자동 갱신 —
 *    extraKnownMarketplaces[name].autoUpdate = true/false
 */
export type ToggleMechanism =
  | 'skillOverrides'
  | 'enabledPlugins'
  | 'marketplaceAutoUpdate'

/** 자산 하나의 토글 가능 여부. */
export interface ToggleCapability {
  /** 끌 수 있으면 어떤 방법으로. 끌 수 없으면 null. */
  mechanism: ToggleMechanism | null
  /** 지금 켜져 있는지. */
  enabled: boolean
  /** mechanism 이 null 일 때 왜 끌 수 없는지. UI 툴팁에 쓴다. */
  reason?: string
  /**
   * 직접 끌 수는 없지만 이 플러그인을 끄면 함께 꺼지는 경우, 그 플러그인 ID.
   *
   * UI 는 이 값이 있으면 '끄기 불가' 대신 해당 플러그인으로 이동하는 버튼을
   * 보여준다 — 막다른 버튼보다 다음 행동을 주는 쪽이 낫다.
   */
  viaPlugin?: string
}

/** 토글 요청. renderer 가 보내는 값이므로 main 에서 다시 검사한다. */
export interface ToggleRequest {
  mechanism: ToggleMechanism
  /** skillOverrides / permissionsDeny 는 자산 이름, enabledPlugins 는 플러그인 ID. */
  key: string
  enabled: boolean
}

/**
 * 자산을 제거하는 방법.
 *
 *  - trash: 파일이나 디렉토리를 macOS 휴지통으로 보낸다. Finder 에서 되돌릴 수 있다.
 *  - pluginUninstall: `claude plugin uninstall` 를 호출한다. installed_plugins.json 과
 *    cache/ 를 직접 쓰지 않는 이유는 그 파일들을 Claude Code 가 소유하기 때문이다.
 *    영구 삭제지만 재설치할 수 있다.
 */
export type RemoveMechanism = 'trash' | 'pluginUninstall'

/** 자산 하나의 제거 가능 여부. */
export interface RemoveCapability {
  /** 제거할 수 있으면 어떤 방법으로. 못 하면 null. */
  mechanism: RemoveMechanism | null
  /** 실제로 지워지는 대상. 확인 대화에 그대로 보여준다. */
  target?: string
  /** mechanism 이 null 일 때 왜 못 지우는지. */
  reason?: string
  /** 휴지통으로 가는지(되돌릴 수 있는지). */
  restorable?: boolean
}

/** 제거 요청. renderer 가 보내는 값이므로 main 에서 다시 검사한다. */
export interface RemoveRequest {
  mechanism: RemoveMechanism
  /** trash 면 경로, pluginUninstall 이면 플러그인 ID. */
  target: string
  /** 확인 대화에 보여줄 이름. */
  label: string
}

/** 제거 결과. */
export interface RemoveResult {
  ok: boolean
  /** 사용자가 확인 대화에서 취소했는지. 취소는 오류가 아니다. */
  canceled?: boolean
  mechanism: RemoveMechanism
  target: string
  /** 휴지통으로 보냈으면 true. UI 가 복구 방법을 안내한다. */
  trashed?: boolean
  error?: string
}

/** 모든 자산이 공유하는 필드. */
export interface AssetBase {
  kind: AssetKind
  /** 자산 식별자. 같은 kind 안에서 충돌 판정의 기준이 된다. */
  name: string
  scope: Scope
  /** 파일/디렉토리 절대 경로. "에디터로 열기" 대상. */
  path: string
  description?: string
  /** 이 자산이 비활성 상태인지. */
  disabled?: boolean
  /**
   * 이 자산을 앱에서 끌 수 있는지, 끌 수 없으면 왜인지.
   *
   * 자산 종류마다 Claude Code 가 제공하는 끄기 방법이 다르다. 전용 키가 있는
   * 것만 토글을 노출하고, 나머지는 이유를 붙여 비활성으로 보여준다.
   */
  toggle?: ToggleCapability
  /** 이 자산을 제거할 수 있는지, 못 하면 왜인지. */
  remove?: RemoveCapability
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

/** 마켓플레이스 출처 종류. */
export type MarketplaceSource = 'github' | 'git' | 'directory' | 'unknown'

/**
 * 자동 갱신이 켜져 있는지.
 *
 * 세 값인 이유: 플래그가 없을 때의 기본값이 출처에 따라 다르다. 공식
 * 마켓플레이스는 적지 않아도 켜져 있고, 그 외는 꺼져 있다. 그래서 "적혀
 * 있지 않음"을 'default' 로 따로 두고, 실제로 어느 쪽인지는 effective 가
 * 말한다 — 두 값으로 줄이면 "기본값 그대로"와 "직접 켰음"이 같아 보인다.
 */
export type AutoUpdateState = 'on' | 'off' | 'default'

/**
 * 자동 갱신을 이 앱에서 바꿀 수 없는 이유.
 *
 *  - notDeclared: 레지스트리에만 있고 사용자 settings.json 에는 없다.
 *    내장 기본 마켓플레이스가 이 경우다.
 *  - foreignScope: 다른 프로젝트나 관리자 설정이 선언했다. 그 파일을
 *    우리가 쓰면 남의 설정을 전역으로 끌어오는 셈이 된다.
 */
export type AutoUpdateBlockReason = 'notDeclared' | 'foreignScope'

/** 마켓플레이스 하나의 자동 갱신 상태. */
export interface AutoUpdateInfo {
  /** settings.json 에 적힌 값. 없으면 'default'. */
  declared: AutoUpdateState
  /** 기본값을 반영해 실제로 켜져 있는지. */
  effective: boolean
  /** 이 앱에서 바꿀 수 있는지. */
  editable: boolean
  /** editable 이 false 일 때 그 이유. */
  blockedBy?: AutoUpdateBlockReason
}

/** 플러그인 마켓플레이스 하나. */
export interface MarketplaceAsset extends AssetBase {
  kind: 'marketplace'
  source: MarketplaceSource
  /** github 면 owner/repo, git 이면 URL, directory 면 경로. */
  origin?: string
  installLocation?: string
  lastUpdated?: string
  /** 이 마켓플레이스에서 설치된 플러그인 수. 0 이면 쓰이지 않는 출처다. */
  installedPlugins: number
  /** settings.json 의 extraKnownMarketplaces 에도 있는지. */
  inSettings: boolean
  /** 이 마켓플레이스에서 설치할 수 있는 플러그인 수 (카탈로그 기준). */
  availablePlugins?: number
  /** 자동 갱신 상태. 토글은 별도 메커니즘을 쓰므로 toggle 과 분리한다. */
  autoUpdate: AutoUpdateInfo
}

/**
 * 설치할 수 있는 플러그인 하나. 마켓플레이스의 marketplace.json 에서 읽는다.
 *
 * 설치된 플러그인(PluginAsset)과 다른 타입인 이유: 공통 필드가 이름과 설명
 * 뿐이고, 이쪽에는 경로도 버전도 범위도 없다. AssetBase 를 상속하면 채울 수
 * 없는 필드를 빈 값으로 메워야 한다.
 */
export interface CatalogPlugin {
  /** 플러그인 이름. 설치 시 `<이름>@<마켓플레이스>` 로 조합한다. */
  name: string
  /** 이 플러그인을 제공하는 마켓플레이스 이름. */
  marketplace: string
  description?: string
  author?: string
  category?: string
  homepage?: string
  /** 이미 설치돼 있는지. 설치 버튼을 숨기는 데 쓴다. */
  installed: boolean
}

/** 카탈로그 읽기 결과. */
export interface CatalogResult {
  plugins: CatalogPlugin[]
  /** 카탈로그를 읽지 못한 마켓플레이스. 전체를 실패시키지 않고 모아 보여준다. */
  issues: ScanIssue[]
}

/** CLI 로 수행하는 플러그인·마켓플레이스 작업. */
export type PluginOp =
  | { op: 'marketplaceAdd'; source: string }
  | { op: 'marketplaceUpdate'; name: string }
  | { op: 'marketplaceUpdateAll' }
  | { op: 'pluginInstall'; plugin: string }
  | { op: 'pluginUpdate'; plugin: string }

/**
 * CLI 작업 결과.
 *
 * ok 를 CLI 종료 코드로 정하지 않는다 — 실측 결과 실패해도 0 을 내놓는
 * 경우가 있어서, --json 의 outcome 필드가 유일하게 믿을 수 있는 신호다.
 */
export interface PluginOpResult {
  ok: boolean
  op: PluginOp['op']
  /** 사용자에게 보여줄 CLI 의 메시지. 우리가 다시 쓰지 않고 그대로 전달한다. */
  message?: string
  /** CLI 가 준 실패 코드 (not_found, invalid_source 등). */
  failureCode?: string
  /**
   * 플러그인 업데이트에서 실제로 버전이 바뀌었는지.
   * 'up_to_date' 는 실패가 아니라 "이미 최신" 이다.
   */
  updateOutcome?: 'updated' | 'up_to_date'
  oldVersion?: string
  newVersion?: string
  error?: string
}

export type Asset =
  | SkillAsset
  | AgentAsset
  | CommandAsset
  | HookAsset
  | PluginAsset
  | McpAsset
  | MarketplaceAsset

/** 프로젝트를 어떻게 알게 됐는지. 목록에서 출처를 구분해 보여준다. */
export type ProjectOrigin = 'discovered' | 'added'

/** 스캔 대상이 될 수 있는 프로젝트 하나. */
export interface ProjectRef {
  /** 프로젝트 루트 절대 경로 (.claude 의 부모). */
  path: string
  /** 목록에 보여줄 이름. 보통 디렉토리명. */
  name: string
  origin: ProjectOrigin
  /** 이 프로젝트가 .claude/ 를 가지고 있는지. */
  hasClaudeDir: boolean
  /** 프로젝트 루트에 .mcp.json 이 있는지. */
  hasMcpConfig: boolean
  /** Claude Code 세션 기록상 마지막 사용 시각. 발견된 프로젝트에만 있다. */
  lastUsedAt?: string
}

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
  /** 스캔 대상이던 프로젝트. 전역만 스캔했으면 null. */
  project: ProjectRef | null
  skills: SkillAsset[]
  agents: AgentAsset[]
  commands: CommandAsset[]
  hooks: HookAsset[]
  plugins: PluginAsset[]
  mcp: McpAsset[]
  marketplaces: MarketplaceAsset[]
  issues: ScanIssue[]
}

/** 토글 결과. 백업 경로를 함께 돌려줘 UI 에서 되돌릴 근거를 보여준다. */
export interface ToggleResult {
  ok: boolean
  mechanism: ToggleMechanism
  /** 토글한 대상 키 (스킬·에이전트 이름 또는 플러그인 ID). */
  key: string
  enabled: boolean
  /** 수정 직전에 만든 settings.json 백업 경로. */
  backupPath?: string
  error?: string
}

/** 프로젝트 목록 조회 결과. 발견 과정의 문제도 함께 돌려준다. */
export interface ProjectListResult {
  projects: ProjectRef[]
  /**
   * 목록에서 숨긴 프로젝트. 되돌릴 수 있도록 함께 돌려준다.
   *
   * 발견된 프로젝트는 Claude Code 의 세션 기록에서 나오므로 지울 수 없다 —
   * 지우면 사용자의 대화 기록이 사라진다. 가리기만 한다.
   */
  hidden: ProjectRef[]
  /** 마지막으로 선택했던 프로젝트 경로. 없으면 null. */
  lastSelected: string | null
  issues: ScanIssue[]
}

/**
 * 사용량 한도 하나.
 *
 * Anthropic 의 /api/oauth/usage 응답 중 limits 배열 항목에 대응한다.
 * 이 배열을 쓰는 이유는 모델별 한도의 이름이 여기에만 있기 때문이다 —
 * 최상위 five_hour / seven_day 에는 "Fable" 같은 이름이 없다.
 */
export interface UsageLimit {
  /** session / weekly_all / weekly_scoped 등. 같은 kind 가 여럿일 수 있다. */
  kind: string
  /** 0~100. Anthropic 이 계산한 값을 그대로 쓴다. */
  percent: number
  /** 재설정 시각 (ISO 문자열). 알 수 없으면 null. */
  resetsAt: string | null
  /** 모델별 한도의 이름 (예: "Fable"). 전체 한도에는 없다. */
  scopeLabel: string | null
  /** normal / warning 등 서버가 매긴 심각도. 참고용이며 색은 percent 로 정한다. */
  severity: string | null
}

/** 조회한 사용량 한 벌. */
export interface UsageSnapshot {
  /** 조회 시각 (ISO 문자열). */
  fetchedAt: string
  /** 응답에 있던 한도 전부. 순서는 서버가 준 그대로다. */
  limits: UsageLimit[]
}

/** 사용량 조회가 실패한 이유. UI 가 할 말을 고르는 데 쓴다. */
export type UsageFailureReason = 'no-token' | 'expired' | 'network' | 'http' | 'parse' | 'empty'

/** 사용량 조회 결과. */
export type UsageReadResult =
  | { ok: true; snapshot: UsageSnapshot }
  | { ok: false; reason: UsageFailureReason; error: string }

/** renderer 가 preload 를 통해 쓸 수 있는 API. window.api 로 노출된다. */
export interface AdminApi {
  /** @param projectPath 스캔할 프로젝트 루트. 생략하면 전역 자산만 읽는다. */
  scan(projectPath?: string | null): Promise<Inventory>
  /**
   * 알고 있는 프로젝트 전체 목록 (발견 + 직접 추가).
   *
   * @param refresh true 면 캐시를 버리고 세션 기록을 다시 훑는다.
   */
  listProjects(refresh?: boolean): Promise<ProjectListResult>
  /** 폴더 선택 다이얼로그를 띄워 프로젝트를 추가한다. 취소하면 added 가 null. */
  addProject(): Promise<{ added: ProjectRef | null; error?: string }>
  /**
   * 프로젝트를 목록에서 뺀다. 직접 추가한 것은 등록을 지우고,
   * 발견된 것은 숨긴다(세션 기록은 건드리지 않는다).
   */
  removeProject(path: string): Promise<{ ok: boolean; error?: string }>
  /** 숨긴 프로젝트를 다시 보이게 한다. */
  restoreProject(path: string): Promise<{ ok: boolean; error?: string }>
  /** 자산을 켜거나 끈다. 어떤 키를 쓸지는 mechanism 이 정한다. */
  toggleAsset(request: ToggleRequest): Promise<ToggleResult>
  /** 자산을 제거한다. 확인 대화는 main 에서 띄운다. */
  removeAsset(request: RemoveRequest): Promise<RemoveResult>
  /**
   * 설치할 수 있는 플러그인 목록. 마켓플레이스 카탈로그를 모아 읽는다.
   *
   * 2,600개가 넘으므로 renderer 가 검색으로 걸러 쓴다. 한 번 읽으면
   * main 이 캐시하고, refresh 로만 다시 읽는다.
   */
  listCatalog(refresh?: boolean): Promise<CatalogResult>
  /**
   * 마켓플레이스를 추가한다. source 는 owner/repo, git URL, 또는 경로.
   *
   * 입력은 사용자가 손으로 치므로 main 에서 모양을 검사한다.
   */
  addMarketplace(source: string): Promise<PluginOpResult>
  /** 마켓플레이스를 갱신한다. name 을 비우면 전체를 갱신한다. */
  updateMarketplace(name?: string): Promise<PluginOpResult>
  /** 플러그인을 설치한다. `<이름>@<마켓플레이스>` 형식을 쓴다. */
  installPlugin(plugin: string): Promise<PluginOpResult>
  /** 설치된 플러그인을 최신 버전으로 올린다. */
  updatePlugin(plugin: string): Promise<PluginOpResult>
  revealPath(path: string): Promise<{ ok: boolean; error?: string }>
  /** 구독 사용량을 지금 조회한다. Claude Code 의 로그인 정보를 그대로 쓴다. */
  readUsage(): Promise<UsageReadResult>
  /** 설정 창을 연다. 메뉴바 팝오버의 "설정" 이 쓴다. */
  openSettings(): Promise<void>
  /** 앱을 완전히 종료한다. 메뉴바 팝오버의 "종료" 가 쓴다. */
  quitApp(): Promise<void>
  /**
   * 팝오버가 화면에 뜰 때마다 불린다. 닫혀 있던 동안 멈춰 있던 값을
   * 다시 읽으라는 신호다.
   *
   * @returns 구독을 끊는 함수. 컴포넌트가 사라질 때 반드시 호출한다 —
   *   하지 않으면 같은 핸들러가 겹겹이 쌓인다.
   */
  onPopoverShown(handler: () => void): () => void
  /**
   * 팝오버 내용의 높이를 알린다. main 이 창을 그 높이에 맞춘다.
   *
   * 창 높이를 코드에 박지 않는 이유는 한도 개수가 바뀔 수 있어서다 —
   * 모델별 한도가 하나 늘면 줄이 하나 더 생긴다.
   */
  resizePopover(height: number): void
}
