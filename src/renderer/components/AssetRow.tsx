import { ConflictBadge, OffBadge, ScopeBadge } from './Badges.js'
import type { Asset } from '../../shared/types.js'

/** 한 자산을 한 줄로 그린다. 종류별로 다른 보조 정보를 덧붙인다. */
export function AssetRow({
  asset,
  onOpen,
  onReveal,
  onToggle,
  busy
}: {
  asset: Asset
  onOpen: (path: string) => void
  onReveal: (path: string) => void
  onToggle?: (asset: Asset, next: boolean) => void
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
        {asset.kind === 'plugin' && onToggle && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => onToggle(asset, isOff)}
            title={
              isOff
                ? 'settings.json 을 백업한 뒤 이 플러그인을 켭니다'
                : 'settings.json 을 백업한 뒤 이 플러그인을 끕니다'
            }
          >
            {busy ? '…' : isOff ? '켜기' : '끄기'}
          </button>
        )}
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
