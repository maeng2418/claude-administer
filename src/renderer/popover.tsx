import { StrictMode, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { UsagePanel } from './components/UsagePanel.js'
import type { UsageReadResult } from '../shared/types.js'
import './styles.css'
import './popover.css'

/**
 * 메뉴바 아이콘을 눌렀을 때 뜨는 작은 창.
 *
 * macOS 기본 메뉴 대신 창을 쓰는 이유는 그림을 그릴 수 있기 때문이다 —
 * 메뉴 항목은 글자만 받으므로 막대 게이지를 문자로 흉내 내야 하는데,
 * 창이면 설정 화면에서 쓰는 UsagePanel 을 그대로 가져다 쓸 수 있다.
 *
 * 설정 창과 별개의 renderer 다. 같은 styles.css 를 공유해 색과 막대
 * 모양이 두 화면에서 어긋나지 않는다.
 */

/** 사용량 갱신 간격. 팝오버는 열려 있는 동안만 돌므로 짧게 잡아도 싸다. */
const REFRESH_MS = 60_000

function Popover(): React.JSX.Element {
  const [usage, setUsage] = useState<UsageReadResult | null>(null)
  const [loading, setLoading] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setUsage(await window.api.readUsage())
    } catch (err) {
      /*
        IPC 자체가 실패한 경우다 — 핸들러가 없거나 main 이 죽었을 때.
        잡지 않으면 usage 가 null 로 남아 "읽는 중…" 에서 영원히 멈춘다.
        실패도 결과이므로 결과 모양에 맞춰 담는다.
      */
      setUsage({
        ok: false,
        reason: 'network',
        error: err instanceof Error ? err.message : '사용량을 불러오지 못했습니다.'
      })
    } finally {
      setLoading(false)
    }
  }, [])

  // 열릴 때마다 한 번 읽고, 열려 있는 동안 주기적으로 갱신한다.
  // 팝오버는 닫히면 창이 숨겨질 뿐 살아 있으므로, main 이 보낼 때마다
  // 다시 읽도록 'popover:shown' 도 듣는다.
  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), REFRESH_MS)
    const off = window.api.onPopoverShown(() => void load())
    return () => {
      clearInterval(timer)
      off()
    }
  }, [load])

  /*
    내용 높이를 재서 main 에 알린다. 창이 그 높이에 맞춰진다.

    ResizeObserver 를 쓰는 이유는 높이가 바뀌는 시점이 여럿이기 때문이다 —
    사용량이 도착할 때, 한도 개수가 달라질 때, 실패 메시지가 길어질 때.
    매번 수동으로 알리면 한 곳을 빠뜨리고 그만큼 빈 자리가 남는다.
  */
  useEffect(() => {
    const element = rootRef.current
    if (!element) return

    const report = (): void => {
      // 테두리까지 포함한 바깥 치수를 보내야 창 크기와 맞는다.
      window.api.resizePopover(Math.ceil(element.getBoundingClientRect().height))
    }

    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="popover" ref={rootRef}>
      <div className="popover-usage">
        {/*
          아직 한 번도 못 읽었으면 UsagePanel 이 아무것도 그리지 않는다.
          사이드바에서는 자리만 비면 그만이지만 팝오버는 그게 내용의
          전부라 빈 판이 뜬다 — 읽는 중이라고 적어 둔다.
        */}
        {usage === null ? (
          <div className="popover-placeholder">사용량 읽는 중…</div>
        ) : (
          <UsagePanel usage={usage} loading={loading} onRefresh={() => void load()} wide />
        )}
      </div>
      <div className="popover-actions">
        <button
          type="button"
          className="popover-btn popover-btn-primary"
          onClick={() => void window.api.openSettings()}
        >
          설정
        </button>
        <button
          type="button"
          className="popover-btn"
          onClick={() => void window.api.quitApp()}
          title="앱을 완전히 종료합니다"
        >
          종료
        </button>
      </div>
    </div>
  )
}

const container = document.getElementById('root')
if (!container) {
  throw new Error('#root 요소를 찾지 못했습니다')
}

createRoot(container).render(
  <StrictMode>
    <Popover />
  </StrictMode>
)
