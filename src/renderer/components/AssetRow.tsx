import { ConflictBadge, OffBadge, ScopeBadge } from './Badges.js'
import type { Asset } from '../../shared/types.js'

/** 한 자산을 한 줄로 그린다. 종류별로 다른 보조 정보를 덧붙인다. */
export function AssetRow({
  asset,
  onOpen,
  onReveal,
  onToggle,
  onGoToPlugin,
  inPluginGroup,
  onGoToMarketplacePlugins,
  onRemove,
  busy
}: {
  asset: Asset
  onOpen: (path: string) => void
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
          <ScopeBadge scope={asset.scope} />
          {isOff && <OffBadge />}
          <ConflictBadge scope={asset.scope} shadowedBy={asset.shadowedBy ?? []} />
          <AssetExtras asset={asset} />
        </div>

        {asset.description && <div className="row-desc">{asset.description}</div>}

        <div className="row-meta">{asset.path}</div>
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
          className="btn btn-sm"
          onClick={() => onOpen(asset.path)}
          title="기본 편집기로 열기"
        >
          열기
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => onReveal(asset.path)}
          title="Finder 에서 보기"
        >
          위치
        </button>
      </div>
    </div>
  )
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
          className="btn btn-sm"
          onClick={() => onGoToPlugin(pluginId)}
          title={`${toggle.reason ?? ''}\n\n누르면 플러그인 탭에서 ${pluginId} 를 찾아줍니다.`}
        >
          플러그인으로
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
      className={`btn btn-sm${isOn ? '' : ' btn-on'}`}
      disabled={busy}
      onClick={() => onToggle(asset, !isOn)}
      title={`${mechanismLabel} 를 백업 후 수정합니다 (Claude Code 재시작 후 적용)`}
    >
      {busy ? '…' : isOn ? '끄기' : '켜기'}
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
      className="btn btn-sm btn-danger"
      disabled={busy}
      onClick={() => onRemove(asset)}
      title={
        remove.restorable
          ? `${remove.target} 을(를) 휴지통으로 보냅니다. Finder 에서 되돌릴 수 있습니다.`
          : `${remove.target} 을(를) claude plugin uninstall 로 제거합니다. 휴지통을 거치지 않지만 다시 설치할 수 있습니다.`
      }
    >
      {busy ? '…' : '제거'}
    </button>
  )
}

/** 자산 종류별 보조 정보(트리거, 이벤트, 버전 등). */
function AssetExtras({ asset }: { asset: Asset }): React.JSX.Element | null {
  switch (asset.kind) {
    case 'skill':
      return (
        <>
          {asset.trigger && <span className="chip">{asset.trigger}</span>}
          {asset.sourcePlugin && <span className="chip">{asset.sourcePlugin}</span>}
        </>
      )
    case 'command':
      return (
        <>
          <span className="chip">{asset.invocation}</span>
          {asset.sourcePlugin && <span className="chip">{asset.sourcePlugin}</span>}
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
