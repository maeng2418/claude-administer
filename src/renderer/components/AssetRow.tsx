import { ConflictBadge, OffBadge, ScopeBadge } from './Badges.js'
import type { Asset } from '../../shared/types.js'

/** 한 자산을 한 줄로 그린다. 종류별로 다른 보조 정보를 덧붙인다. */
export function AssetRow({
  asset,
  onOpen,
  onReveal,
  onToggle,
  onGoToPlugin,
  onRemove,
  busy
}: {
  asset: Asset
  onOpen: (path: string) => void
  onReveal: (path: string) => void
  onToggle?: (asset: Asset, next: boolean) => void
  /** 플러그인 탭으로 이동해 해당 플러그인을 찾아준다. */
  onGoToPlugin?: (pluginId: string) => void
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
        {onToggle && (
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
      : toggle.mechanism === 'permissionsDeny'
        ? 'settings.json 의 permissions.deny'
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
    default:
      return null
  }
}
