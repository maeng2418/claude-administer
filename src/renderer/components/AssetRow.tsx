import { ConflictBadge, OffBadge, ScopeBadge } from './Badges.js'
import { ExternalLinkIcon, FolderIcon, TrashIcon, UpdateIcon } from './Icons.js'
import type { Asset, MarketplaceAsset } from '../../shared/types.js'

/** 한 자산을 한 줄로 그린다. 종류별로 다른 보조 정보를 덧붙인다. */
export function AssetRow({
  asset,
  onReveal,
  onToggle,
  onGoToPlugin,
  inPluginGroup,
  onGoToMarketplacePlugins,
  onRemove,
  onAutoUpdate,
  onUpdateNow,
  busy
}: {
  asset: Asset
  onReveal: (path: string) => void
  onToggle?: (asset: Asset, next: boolean) => void
  /** 플러그인 탭으로 이동해 해당 플러그인을 찾아준다. */
  onGoToPlugin?: (pluginId: string) => void
  /**
   * 플러그인 그룹 안의 행인지.
   *
   * 그룹 헤더에 이미 그 플러그인의 토글과 제거가 있으므로, 그룹 안에서는
   * 토글 칸을 아예 비운다. '플러그인으로' 를 빼고 '끄기 불가' 를 남기면
   * 중복 버튼이 죽은 버튼으로 바뀌는 것뿐이라 더 나쁘다.
   */
  inPluginGroup?: boolean
  /** 마켓플레이스 행에서 그 출처의 플러그인 목록으로 이동한다. */
  onGoToMarketplacePlugins?: (marketplace: string) => void
  onRemove?: (asset: Asset) => void
  /** 마켓플레이스 자동 갱신을 켜거나 끈다. */
  onAutoUpdate?: (asset: MarketplaceAsset, next: boolean) => void
  /** 마켓플레이스를 지금 갱신하거나, 플러그인을 최신 버전으로 올린다. */
  onUpdateNow?: (asset: Asset) => void
  busy?: boolean
}): React.JSX.Element {
  const isOff = asset.disabled === true

  return (
    <div className="row">
      <div className="row-main">
        <div className="row-head">
          {/*
            규칙은 이름이 아니라 상대 경로로 식별한다. moai/core/x.md 처럼
            디렉토리가 분류 역할을 해서, 파일명만 보면 어느 묶음인지 알 수 없다.
          */}
          <span className={`row-name${isOff ? ' is-off' : ''}`}>
            {asset.kind === 'rule' ? asset.relativePath : asset.name}
          </span>
          {/* 그룹 안에서는 scope 배지를 숨긴다 — 헤더가 이미 '플러그인' 이라고 말한다. */}
          {!inPluginGroup && <ScopeBadge scope={asset.scope} />}
          {isOff && <OffBadge />}
          <ConflictBadge scope={asset.scope} shadowedBy={asset.shadowedBy ?? []} />
          <AssetExtras asset={asset} inPluginGroup={inPluginGroup} />
        </div>

        {asset.description && (
          <div className="row-desc" title={asset.description}>
            {asset.description}
          </div>
        )}

        <div className="row-meta" title={asset.path}>
          {shortenPath(asset.path)}
        </div>
      </div>

      <div className="row-actions">
        {asset.kind === 'marketplace' && onAutoUpdate && (
          <AutoUpdateSwitch asset={asset} onAutoUpdate={onAutoUpdate} busy={busy} />
        )}
        {/*
          지금 갱신. 자동 갱신과 나란히 두는 이유: 자동을 켜 두었더라도
          즉시 받아오고 싶은 순간이 따로 있다(방금 올린 플러그인을 바로
          쓰려는 경우). 자동 갱신은 세션 시작 뒤 지연 실행이라 "지금" 을
          대신하지 못한다.
        */}
        {onUpdateNow && (asset.kind === 'marketplace' || asset.kind === 'plugin') && (
          <button
            type="button"
            className="btn btn-icon"
            disabled={busy}
            onClick={() => onUpdateNow(asset)}
            title={
              asset.kind === 'marketplace'
                ? `${asset.name} 을(를) 출처에서 지금 다시 받아옵니다.`
                : `${asset.name} 을(를) 최신 버전으로 올립니다. (Claude Code 재시작 후 적용)`
            }
            aria-label={`${asset.name} 지금 갱신`}
          >
            {busy ? '…' : <UpdateIcon />}
          </button>
        )}
        {asset.kind === 'marketplace' &&
          onGoToMarketplacePlugins &&
          asset.installedPlugins > 0 && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onGoToMarketplacePlugins(asset.name)}
              title={`이 출처에서 설치된 플러그인 ${asset.installedPlugins}개를 봅니다.`}
            >
              플러그인 보기
            </button>
          )}
        {onToggle && !inPluginGroup && (
          <ToggleButton
            asset={asset}
            onToggle={onToggle}
            onGoToPlugin={onGoToPlugin}
            busy={busy}
          />
        )}
        {onRemove && <RemoveButton asset={asset} onRemove={onRemove} busy={busy} />}
        <button
          type="button"
          className="btn btn-icon"
          onClick={() => onReveal(asset.path)}
          title={`Finder 에서 보기 — ${asset.path}`}
          aria-label={`${asset.name} 을(를) Finder 에서 보기`}
        >
          <FolderIcon />
        </button>
      </div>
    </div>
  )
}

/** 바이트를 사람이 읽는 단위로. 1KB 미만은 바이트 그대로 둔다. */
function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`
}

/** 토큰 어림값. 1,000 이상은 K 로 접는다. */
function formatTokens(tokens: number): string {
  return tokens < 1000 ? `${tokens}` : `${(tokens / 1000).toFixed(1)}K`
}

/**
 * 긴 절대 경로를 뒤쪽 위주로 줄인다.
 *
 * 한 그룹 안의 경로는 앞부분이 거의 같고(…/plugins/cache/<marketplace>/<plugin>/<버전>/)
 * 구분되는 건 뒤쪽이다. 홈은 `~` 로 접고, 그래도 길면 앞을 잘라낸다.
 * 전체 경로는 title 에 남겨 마우스를 올리면 볼 수 있다.
 */
function shortenPath(path: string): string {
  const home = path.match(/^\/Users\/[^/]+/)?.[0]
  const tilde = home ? path.replace(home, '~') : path
  if (tilde.length <= 64) return tilde
  const segments = tilde.split('/')
  // 뒤에서부터 64자에 들어가는 만큼만 남긴다.
  const kept: string[] = []
  let length = 0
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]!
    if (length + segment.length + 1 > 60) break
    kept.unshift(segment)
    length += segment.length + 1
  }
  return `…/${kept.join('/')}`
}

/**
 * 켜기/끄기 스위치.
 *
 * 자산마다 Claude Code 가 제공하는 끄기 방법이 달라서, 스캐너가 붙여준
 * toggle 정보만 보고 그린다. 끌 수 없는 자산은 사유를 툴팁에 담아
 * 비활성 상태로 보여준다 — 아예 숨기면 "왜 없지"를 매번 묻게 된다.
 */
function ToggleButton({
  asset,
  onToggle,
  onGoToPlugin,
  busy
}: {
  asset: Asset
  onToggle: (asset: Asset, next: boolean) => void
  onGoToPlugin?: (pluginId: string) => void
  busy?: boolean
}): React.JSX.Element | null {
  const toggle = asset.toggle
  if (!toggle) return null

  if (toggle.mechanism === null) {
    // 플러그인을 끄면 함께 꺼지는 자산이면, 막다른 버튼 대신 그 플러그인으로 보낸다.
    // 단 그룹 안에서는 onGoToPlugin 을 넘기지 않는다 — 그룹 헤더에 이미 같은
    // 플러그인의 토글과 제거가 있어서 행마다 반복하면 같은 버튼이 수십 개 된다.
    if (toggle.viaPlugin && onGoToPlugin) {
      const pluginId = toggle.viaPlugin
      return (
        <button
          type="button"
          className="btn btn-icon"
          onClick={() => onGoToPlugin(pluginId)}
          title={`${toggle.reason ?? ''}\n\n누르면 플러그인 탭에서 ${pluginId} 를 찾아줍니다.`}
          aria-label={`${pluginId} 플러그인으로 이동`}
        >
          <ExternalLinkIcon />
        </button>
      )
    }
    return (
      <button type="button" className="btn btn-sm" disabled title={toggle.reason}>
        끄기 불가
      </button>
    )
  }

  const isOn = toggle.enabled
  const mechanismLabel =
    toggle.mechanism === 'skillOverrides'
      ? 'settings.json 의 skillOverrides'
      : 'settings.json 의 enabledPlugins'

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isOn}
      className={`switch${isOn ? ' is-on' : ''}`}
      disabled={busy}
      onClick={() => onToggle(asset, !isOn)}
      title={`${mechanismLabel} 를 백업 후 수정합니다 (Claude Code 재시작 후 적용)`}
      aria-label={`${asset.name} ${isOn ? '끄기' : '켜기'}`}
    >
      <span className="switch-track">
        <span className="switch-thumb" />
      </span>
    </button>
  )
}

/**
 * 마켓플레이스 자동 갱신 스위치.
 *
 * 라벨을 붙이는 이유: 같은 행에 다른 버튼들이 있어서 맨 스위치만 두면
 * 무엇을 켜고 끄는지 알 수 없다. 다른 탭의 스위치는 "자산 켜기/끄기" 라는
 * 하나의 뜻이지만, 여기서는 마켓플레이스가 아니라 자동 갱신을 켠다.
 *
 * 세 상태를 구분해 보여준다. 플래그가 없을 때의 기본값이 출처에 따라
 * 다르기 때문이다 — 공식 마켓플레이스는 적지 않아도 켜져 있다. '기본값'
 * 을 따로 표시하지 않으면 사용자가 직접 켠 것과 원래 켜져 있던 것을
 * 구분할 수 없고, 끈 적도 없는데 왜 켜져 있는지 설명할 길이 없다.
 */
function AutoUpdateSwitch({
  asset,
  onAutoUpdate,
  busy
}: {
  asset: MarketplaceAsset
  onAutoUpdate: (asset: MarketplaceAsset, next: boolean) => void
  busy?: boolean
}): React.JSX.Element {
  const info = asset.autoUpdate
  const isOn = info.effective

  if (!info.editable) {
    const reason =
      info.blockedBy === 'foreignScope'
        ? '이 값은 다른 프로젝트나 관리자 설정에서 정했습니다. 여기서 바꾸면 그 설정과 충돌하므로 잠가 두었습니다.'
        : '내장 기본 마켓플레이스라 사용자 설정에 항목이 없습니다. 이 도구는 없는 항목을 새로 만들지 않습니다.'
    return (
      <span className="auto-update is-locked" title={reason}>
        <span className="auto-update-label">자동 갱신</span>
        <span className="auto-update-state">{isOn ? '켜짐(기본)' : '꺼짐(기본)'}</span>
      </span>
    )
  }

  // 직접 적은 값과 기본값을 구분해 보여준다.
  const stateLabel =
    info.declared === 'default' ? (isOn ? '기본 켜짐' : '기본 꺼짐') : isOn ? '켜짐' : '꺼짐'

  return (
    <span className="auto-update">
      <span className="auto-update-label">자동 갱신</span>
      <button
        type="button"
        role="switch"
        aria-checked={isOn}
        className={`switch${isOn ? ' is-on' : ''}`}
        disabled={busy}
        onClick={() => onAutoUpdate(asset, !isOn)}
        title={`settings.json 의 extraKnownMarketplaces["${asset.name}"].autoUpdate 를 백업 후 ${
          isOn ? 'false' : 'true'
        } 로 바꿉니다.\n\n현재: ${stateLabel}\n켜면 세션 시작 후 이 출처와 거기서 설치한 플러그인을 자동으로 갱신합니다.`}
        aria-label={`${asset.name} 자동 갱신 ${isOn ? '끄기' : '켜기'}`}
      >
        <span className="switch-track">
          <span className="switch-thumb" />
        </span>
      </button>
    </span>
  )
}

/**
 * 제거 버튼.
 *
 * 제거할 수 없는 자산에는 버튼을 아예 그리지 않는다 — 토글과 달리 '제거 불가'를
 * 보여줄 이유가 없다. 끄기는 사용자가 찾는 기능이지만, 제거는 그렇지 않다.
 */
function RemoveButton({
  asset,
  onRemove,
  busy
}: {
  asset: Asset
  onRemove: (asset: Asset) => void
  busy?: boolean
}): React.JSX.Element | null {
  const remove = asset.remove
  if (!remove || remove.mechanism === null) return null

  return (
    <button
      type="button"
      className="btn btn-icon btn-danger"
      disabled={busy}
      onClick={() => onRemove(asset)}
      title={
        remove.restorable
          ? `${remove.target} 을(를) 휴지통으로 보냅니다. Finder 에서 되돌릴 수 있습니다.`
          : `${remove.target} 을(를) claude plugin uninstall 로 제거합니다. 휴지통을 거치지 않지만 다시 설치할 수 있습니다.`
      }
      aria-label={`${asset.name} 제거`}
    >
      {busy ? '…' : <TrashIcon />}
    </button>
  )
}

/**
 * 자산 종류별 보조 정보(트리거, 이벤트, 버전 등).
 *
 * 그룹 안에서는 sourcePlugin 칩을 숨긴다 — 그룹 전체가 같은 플러그인이라
 * 행마다 반복하면 같은 글자가 수십 번 나온다.
 */
function AssetExtras({
  asset,
  inPluginGroup
}: {
  asset: Asset
  inPluginGroup?: boolean
}): React.JSX.Element | null {
  switch (asset.kind) {
    case 'skill':
      return (
        <>
          {asset.trigger && <span className="chip">{asset.trigger}</span>}
          {asset.sourcePlugin && !inPluginGroup && (
            <span className="chip">{asset.sourcePlugin}</span>
          )}
        </>
      )
    case 'command':
      return (
        <>
          <span className="chip chip-mono">{asset.invocation}</span>
          {asset.sourcePlugin && !inPluginGroup && (
            <span className="chip">{asset.sourcePlugin}</span>
          )}
        </>
      )
    case 'agent':
      return (
        <>
          {asset.model && <span className="chip">{asset.model}</span>}
          {asset.tools && <span className="chip">tools {asset.tools.length}</span>}
        </>
      )
    case 'hook':
      return (
        <>
          <span className="chip">{asset.event}</span>
          {asset.async && <span className="chip">async</span>}
          {asset.timeout !== undefined && <span className="chip">{asset.timeout}s</span>}
        </>
      )
    case 'plugin':
      return (
        <>
          <span className="chip">{asset.marketplace}</span>
          {asset.version && <span className="chip">{asset.version}</span>}
          <span className="chip">
            S{asset.provides.skills} · C{asset.provides.commands} · A
            {asset.provides.agents}
          </span>
        </>
      )
    case 'mcp':
      return <span className="chip">{asset.transport}</span>
    case 'rule':
      return (
        <>
          {/*
            항상 로드되는 것만 강조한다. 조건부는 다수(실측 74개 중 60개)이고
            비용이 들지 않으므로, 둘 다 칠하면 정작 봐야 할 쪽이 묻힌다.
          */}
          {asset.alwaysLoaded ? (
            <span
              className="chip chip-warn"
              title="frontmatter 에 paths: 가 없어 매 세션 로드됩니다"
            >
              항상 로드
            </span>
          ) : (
            <span className="chip" title={`paths: ${asset.paths ?? ''}`}>
              조건부
            </span>
          )}
          <span className="chip" title={`${asset.bytes.toLocaleString()} 바이트`}>
            {formatSize(asset.bytes)}
          </span>
          {/*
            토큰은 어림이라는 것을 ~ 로 드러낸다. 정확한 값처럼 보이면
            예산을 그 숫자에 맞춰 세우게 된다.
          */}
          <span
            className="chip"
            title="바이트를 4로 나눈 어림값입니다. 정확한 토큰 수는 토크나이저가 필요합니다."
          >
            ~{formatTokens(asset.estimatedTokens)}
          </span>
          {asset.frontmatterError && (
            <span
              className="chip chip-danger"
              title={`frontmatter 파싱 실패: ${asset.frontmatterError}\n\npaths: 가 적혀 있어도 Claude Code 가 무시하고 매 세션 로드합니다.`}
            >
              frontmatter 깨짐
            </span>
          )}
        </>
      )
    case 'marketplace':
      return (
        <>
          <span className="chip">{asset.source}</span>
          <span className={`chip${asset.installedPlugins === 0 ? ' chip-warn' : ''}`}>
            설치 {asset.installedPlugins}개
          </span>
          {asset.availablePlugins !== undefined && (
            <span className="chip" title="이 출처에서 설치할 수 있는 플러그인 수">
              설치 가능 {asset.availablePlugins}개
            </span>
          )}
          {!asset.inSettings && (
            <span
              className="chip"
              title="settings.json 의 extraKnownMarketplaces 에는 없고 레지스트리에만 있습니다"
            >
              레지스트리만
            </span>
          )}
          {asset.lastUpdated && (
            <span className="chip" title={asset.lastUpdated}>
              {asset.lastUpdated.slice(0, 10)}
            </span>
          )}
        </>
      )
    default:
      return null
  }
}
