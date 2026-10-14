import { useMemo, useState } from 'react'
import { AssetRow } from './AssetRow.js'
import { ExternalLinkIcon, TrashIcon } from './Icons.js'
import type { Asset, PluginAsset } from '../../shared/types.js'

/**
 * 자산 목록.
 *
 * 전역·프로젝트 자산은 평면 목록으로 위에 두고, 플러그인이 제공하는 자산은
 * 플러그인별로 접을 수 있게 묶는다. 플러그인 하나가 스킬 7개를 주는 경우가 있어
 * 평면으로 두면 어느 플러그인에서 온 것인지 섞여 읽기 어렵다.
 *
 * 그룹 헤더에는 그 플러그인의 토글과 제거를 그대로 둔다 — 자산을 보다가
 * "이 플러그인 자체를 끄자"로 넘어가는 흐름이 가장 흔하다.
 */
export function GroupedList({
  assets,
  plugins,
  searching,
  onReveal,
  onToggle,
  onGoToPlugin,
  onGoToMarketplacePlugins,
  onRemove,
  busyKey,
  rowKeyFor
}: {
  assets: Asset[]
  /** 그룹 헤더에 쓸 플러그인 정보. id 로 찾는다. */
  plugins: PluginAsset[]
  /** 검색 중이면 그룹을 모두 펼친다 — 접힌 안에 결과가 숨으면 못 찾은 줄 안다. */
  searching: boolean
  onReveal: (path: string) => void
  onToggle: (asset: Asset, next: boolean) => void
  onGoToPlugin: (pluginId: string) => void
  onGoToMarketplacePlugins: (marketplace: string) => void
  onRemove: (asset: Asset) => void
  busyKey: string | null
  rowKeyFor: (asset: Asset) => string
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const { flat, groups } = useMemo(() => {
    const flatList: Asset[] = []
    const byPlugin = new Map<string, Asset[]>()

    for (const asset of assets) {
      // sourcePlugin 을 가진 것만 묶는다. 플러그인 제공 에이전트는 scope 로 판별한다.
      const pluginId =
        'sourcePlugin' in asset && typeof asset.sourcePlugin === 'string'
          ? asset.sourcePlugin
          : null
      if (pluginId === null) {
        flatList.push(asset)
        continue
      }
      const bucket = byPlugin.get(pluginId)
      if (bucket) bucket.push(asset)
      else byPlugin.set(pluginId, [asset])
    }

    // 자산을 많이 주는 플러그인이 위로.
    const sorted = [...byPlugin.entries()].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])
    )
    return { flat: flatList, groups: sorted }
  }, [assets])

  const pluginById = useMemo(
    () => new Map(plugins.map((p) => [p.id, p])),
    [plugins]
  )

  /**
   * 행 하나.
   *
   * @param inGroup 그룹 안의 행인지. 그룹 안에서는 토글 칸을 비운다 —
   *   그룹 헤더에 이미 같은 플러그인의 토글과 제거가 있어서, 행마다 반복하면
   *   같은 버튼이 수십 개 중복된다.
   */
  const row = (asset: Asset, inGroup = false): React.JSX.Element => (
    <AssetRow
      key={rowKeyFor(asset)}
      asset={asset}
      onReveal={onReveal}
      onToggle={onToggle}
      onGoToPlugin={onGoToPlugin}
      inPluginGroup={inGroup}
      onGoToMarketplacePlugins={onGoToMarketplacePlugins}
      onRemove={onRemove}
      busy={busyKey === rowKeyFor(asset)}
    />
  )

  const toggleGroup = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <>
      {flat.map((asset) => row(asset))}

      {groups.map(([pluginId, items]) => {
        const plugin = pluginById.get(pluginId)
        const isCollapsed = !searching && collapsed.has(pluginId)
        return (
          <section className="group" key={pluginId}>
            <div className="group-head">
              <button
                type="button"
                className="group-toggle"
                aria-expanded={!isCollapsed}
                onClick={() => toggleGroup(pluginId)}
                disabled={searching}
                title={searching ? '검색 중에는 모두 펼칩니다' : undefined}
              >
                <span className="group-caret">{isCollapsed ? '▸' : '▾'}</span>
                <span className="group-name">{plugin?.name ?? pluginId}</span>
                <span className="badge badge-plugin">플러그인</span>
                {plugin?.disabled && <span className="badge badge-off">꺼짐</span>}
                <span className="chip">{items.length}개</span>
                {plugin?.marketplace && (
                  <span className="chip chip-quiet">{plugin.marketplace}</span>
                )}
              </button>

              {plugin && (
                <div className="group-actions">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={plugin.disabled !== true}
                    className={`switch${plugin.disabled !== true ? ' is-on' : ''}`}
                    disabled={busyKey === rowKeyFor(plugin)}
                    onClick={() => onToggle(plugin, plugin.disabled === true)}
                    title="이 플러그인을 켜거나 끕니다. 제공하는 자산도 함께 바뀝니다."
                    aria-label={`${plugin.name} 플러그인 ${plugin.disabled ? '켜기' : '끄기'}`}
                  >
                    <span className="switch-track">
                      <span className="switch-thumb" />
                    </span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-icon"
                    onClick={() => onGoToPlugin(pluginId)}
                    title={`플러그인 탭에서 ${pluginId} 를 찾아줍니다.`}
                    aria-label={`${pluginId} 플러그인으로 이동`}
                  >
                    <ExternalLinkIcon />
                  </button>
                  <button
                    type="button"
                    className="btn btn-icon btn-danger"
                    disabled={busyKey === rowKeyFor(plugin)}
                    onClick={() => onRemove(plugin)}
                    title="claude plugin uninstall 로 이 플러그인을 제거합니다."
                    aria-label={`${plugin.name} 플러그인 제거`}
                  >
                    <TrashIcon />
                  </button>
                </div>
              )}
            </div>

            {!isCollapsed && (
              <div className="group-body">{items.map((a) => row(a, true))}</div>
            )}
          </section>
        )
      })}
    </>
  )
}
