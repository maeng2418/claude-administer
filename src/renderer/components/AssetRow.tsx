import { ConflictBadge, OffBadge, ScopeBadge } from './Badges.js'
import { ExternalLinkIcon, FolderIcon, TrashIcon } from './Icons.js'
import type { Asset } from '../../shared/types.js'

/** 한 자산을 한 줄로 그린다. 종류별로 다른 보조 정보를 덧붙인다. */
export function AssetRow({
  asset,
  onReveal,
  onToggle,
  onGoToPlugin,
  inPluginGroup,
  onGoToMarketplacePlugins,
  onRemove,
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
  busy?: boolean
}): React.JSX.Element {
  const isOff = asset.disabled === true

  return (
    <div className="row">
      <div className="row-main">
        <div className="row-head">
          <span className={`row-name${isOff ? ' is-off' : ''}`}>{asset.name}</span>
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
    case 'marketplace':
      return (
        <>
          <span className="chip">{asset.source}</span>
          <span className={`chip${asset.installedPlugins === 0 ? ' chip-warn' : ''}`}>
            플러그인 {asset.installedPlugins}개
          </span>
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
