import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'

/**
 * 메뉴바 아이콘 아래 뜨는 작은 창.
 *
 * macOS 기본 메뉴(Menu) 대신 창을 쓰는 이유는 메뉴 항목이 글자만
 * 받기 때문이다. 사용량 막대를 그리려면 그릴 면이 필요하고, 창이면
 * 설정 화면의 UsagePanel 을 그대로 재사용할 수 있다.
 *
 * 창은 한 번 만들고 숨겼다 보였다 한다 — 누를 때마다 새로 만들면
 * 매번 React 를 다시 띄워야 해서 눈에 띄게 늦다.
 */

/** 팝오버 폭. 세로와 달리 내용이 늘어날 일이 없어 고정이다. */
const WIDTH = 260

/**
 * 시작 높이. 내용이 그려지면 renderer 가 실제 높이를 알려와 바뀐다.
 *
 * 한도 세 줄 + 버튼일 때의 실측값이다. 흔한 경우에 맞춰 두면 창이
 * 떴다가 크기를 고치는 덜컹임이 보이지 않는다. 한도 개수가 다르면
 * 그때만 renderer 가 알려와 조정된다.
 */
const INITIAL_HEIGHT = 227

/**
 * 높이의 상·하한.
 *
 * renderer 가 보내는 값을 그대로 믿지 않는다 — 렌더 도중 0 이 오거나
 * (아직 레이아웃 전), 비정상적으로 큰 값이 오면 창이 사라지거나
 * 화면을 덮는다.
 */
const MIN_HEIGHT = 90
const MAX_HEIGHT = 520

/** 메뉴바 아이콘과 팝오버 사이 틈. 붙여 두면 메뉴바에 먹힌 것처럼 보인다. */
const GAP = 6

/** 화면 가장자리에서 띄울 최소 여백. 모서리에 딱 붙으면 잘린 느낌이 난다. */
const EDGE_MARGIN = 8

let popover: BrowserWindow | null = null

/**
 * 창을 만든다. 보여주지는 않는다 — 위치를 먼저 정해야 하기 때문이다.
 *
 * 처음 만드는 데 React 로드까지 1.7초쯤 걸린다(실측). 아이콘을 누른
 * 뒤에 만들면 그 시간만큼 아무것도 안 뜨므로, 앱 시작 때 미리 만들어
 * 둔다(prepare). 이후로는 숨겼다 보이기만 해서 70ms 안쪽이다.
 */
function create(): BrowserWindow {
  const window = new BrowserWindow({
    width: WIDTH,
    height: INITIAL_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // 둥근 모서리 바깥이 비쳐야 하므로 투명 창으로 둔다.
    transparent: true,
    backgroundColor: '#00000000',
    // 메뉴바 아이콘 아래에 떠 있어야 하므로 항상 위. 다른 앱으로 전환해도
    // 팝오버만 남는 일이 없도록 포커스를 잃으면 바로 숨긴다(아래 blur).
    alwaysOnTop: true,
    // Dock 과 Cmd+Tab 에 나타나지 않게 한다 — 이 창은 메뉴 대용이다.
    skipTaskbar: true,
    // 전체화면 앱 위에도 뜨게 한다. 메뉴바가 보이는 곳이면 떠야 한다.
    visualEffectState: 'active',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 전체화면(Space)에서도 같은 자리에 뜨게 한다.
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // 바깥을 누르면 닫힌다 — 메뉴와 같은 감각이다.
  window.on('blur', () => {
    if (!window.isDestroyed()) window.hide()
  })

  // 외부 링크는 기본 브라우저로. 설정 창과 같은 규칙이다.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void window.loadURL(`${devUrl}/popover.html`)
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/popover.html'))
  }

  popover = window
  return window
}

/**
 * 트레이 아이콘 아래에 오도록 위치를 정한다.
 *
 * 아이콘 중앙에 맞추되 화면 밖으로 나가지 않게 가둔다 — 아이콘이
 * 오른쪽 끝에 있으면 가운데 정렬만으로는 창이 화면을 넘는다.
 */
function positionUnder(window: BrowserWindow, anchor: Electron.Rectangle): void {
  // 아이콘이 있는 화면을 쓴다. 외부 모니터에 메뉴바가 있을 수 있다.
  const display = screen.getDisplayNearestPoint({
    x: Math.round(anchor.x + anchor.width / 2),
    y: Math.round(anchor.y + anchor.height / 2)
  })
  const area = display.workArea

  const centered = Math.round(anchor.x + anchor.width / 2 - WIDTH / 2)
  const maxX = area.x + area.width - WIDTH - EDGE_MARGIN
  const x = Math.round(Math.min(Math.max(centered, area.x + EDGE_MARGIN), maxX))

  // workArea 는 메뉴바 아래부터 시작한다. 아이콘 바로 아래와 거의 같지만,
  // 아이콘 하단을 기준으로 잡아야 메뉴바 높이가 다른 환경에서도 맞는다.
  const y = Math.round(Math.max(anchor.y + anchor.height + GAP, area.y + GAP))

  window.setPosition(x, y, false)
}

/**
 * 내용 높이에 맞춰 창을 줄이거나 늘린다. renderer 가 알려올 때 불린다.
 *
 * 위쪽 모서리(y)는 건드리지 않는다 — 팝오버는 메뉴바 아이콘 바로 아래
 * 붙어 있어야 하고, 아래로만 자라야 한다. setSize 는 y 를 유지하므로
 * 그대로 쓰면 된다.
 *
 * @param height renderer 가 잰 내용 높이. 신뢰하지 않고 범위를 가둔다.
 */
export function resizePopoverTo(height: number): void {
  if (!popover || popover.isDestroyed()) return
  if (!Number.isFinite(height)) return

  const next = Math.round(Math.min(Math.max(height, MIN_HEIGHT), MAX_HEIGHT))
  // getSize() 는 [폭, 높이] 를 준다. 타입상 요소가 없을 수도 있어 기본값을 둔다.
  const current = popover.getSize()[1] ?? 0

  /*
    작은 차이는 무시한다. 창 크기를 바꾸면 내용이 다시 레이아웃되고
    ResizeObserver 가 또 울리는데, 그 값이 몇 px 어긋나면 227↔229 를
    오가며 끝나지 않는다 — 실측으로 확인했다. 임계값을 두어 끊는다.
  */
  if (Math.abs(current - next) <= 2) return

  popover.setSize(WIDTH, next, false)
}

/**
 * 창을 미리 만들어 둔다. 앱 시작 때 한 번 부른다.
 *
 * 첫 클릭의 1.7초 공백을 없애는 것이 목적이다. 눈에 보이지 않으므로
 * 실패해도 조용히 넘어간다 — togglePopover 가 필요할 때 다시 만든다.
 */
export function preparePopover(): void {
  if (!popover || popover.isDestroyed()) create()
}

/**
 * 팝오버를 연다. 이미 열려 있으면 닫는다 — 아이콘을 다시 눌렀을 때
 * 메뉴가 닫히는 것과 같은 감각이다.
 *
 * @param anchor 트레이 아이콘의 화면상 위치(tray.getBounds()).
 * @returns 이번 호출로 열렸으면 true, 닫혔으면 false.
 */
export function togglePopover(anchor: Electron.Rectangle): boolean {
  const window = popover && !popover.isDestroyed() ? popover : create()

  if (window.isVisible()) {
    window.hide()
    return false
  }

  positionUnder(window, anchor)
  // 열릴 때마다 사용량을 다시 읽게 알린다. 닫혀 있는 동안 멈춰 있던
  // 값이 그대로 보이면 "방금 값" 이라는 약속이 깨진다.
  window.webContents.send('popover:shown')
  // showInactive 가 아니라 show 를 쓴다 — 포커스를 받아야 blur 로 닫힌다.
  window.show()
  window.focus()
  return true
}

/** 팝오버를 닫는다. 설정 창을 열거나 종료할 때 먼저 치운다. */
export function hidePopover(): void {
  if (popover && !popover.isDestroyed() && popover.isVisible()) popover.hide()
}

/** 앱 종료 시 정리. */
export function destroyPopover(): void {
  if (popover && !popover.isDestroyed()) popover.destroy()
  popover = null
}
