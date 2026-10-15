import { Tray, app, nativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { togglePopover } from './popover.js'

/**
 * 메뉴바(트레이) 상주.
 *
 * 창을 닫아도 앱이 살아있게 만드는 쪽은 index.ts 가 맡고, 이 파일은
 * "살아있는 동안 어디서 앱을 다시 부르는가" 만 담당한다.
 *
 * Dock 아이콘을 숨기므로 트레이가 유일한 진입점이다. 트레이를 만들지
 * 못하면 앱을 되살릴 길이 없어지니, 실패하면 Dock 을 다시 띄운다.
 *
 * 아이콘을 누르면 macOS 기본 메뉴 대신 팝오버 창이 뜬다 — 메뉴 항목은
 * 글자만 받아서 사용량 막대를 그릴 수 없기 때문이다(popover.ts).
 */

/**
 * 트레이는 전역 하나다.
 *
 * 모듈 변수로 붙잡아 두는 이유는 가비지 컬렉션이다 — 참조를 놓으면
 * Tray 가 수거되면서 아이콘이 메뉴바에서 조용히 사라진다.
 */
let tray: Tray | null = null

/**
 * 트레이 아이콘 경로.
 *
 * 패키징 여부로 갈린다. 두 경로를 모두 뒤지는 대신 명시적으로 나누는
 * 이유는, 패키징 후 app.getAppPath() 가 app.asar 안을 가리켜 아이콘을
 * 영원히 못 찾는 조용한 실패가 되기 때문이다 — 아이콘은 asar 밖
 * Resources/resources/ 에 extraResources 로 복사된다.
 *
 * build/ 가 아니라 resources/ 에 두는 이유: electron-builder 는 build/ 를
 * 자기 설정 폴더(buildResources)로 쓰고 그 안의 파일을 extraResources
 * 복사 대상에서 제외한다. build/ 에 두면 패키징된 앱에 아이콘이 아예
 * 들어가지 않아 트레이가 조용히 꺼진다 — 실측으로 확인했다.
 *
 * @2x 파일은 경로에 적지 않는다. nativeImage 가 같은 폴더에서 이름
 * 규약으로 찾아 함께 싣는다(scaleFactors=[1,2] 로 확인).
 */
function iconPath(): string | null {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'resources', 'tray.png')
    : join(app.getAppPath(), 'resources', 'tray.png')
  return existsSync(path) ? path : null
}

/**
 * 트레이를 띄운다.
 *
 * @returns 성공 여부. 실패하면 호출 측이 Dock 을 다시 띄워야 한다.
 */
export function createTray(): boolean {
  if (tray) return true

  const path = iconPath()
  if (path === null) return false

  const image = nativeImage.createFromPath(path)
  if (image.isEmpty()) return false
  // 컬러 아이콘(코랄 애스터리스크)이라 템플릿 모드를 쓰지 않는다 —
  // 템플릿으로 표시하면 macOS 가 색을 버리고 알파 실루엣만 남긴다.

  try {
    tray = new Tray(image)
  } catch {
    return false
  }

  tray.setToolTip('Claude Administer')

  /*
    setContextMenu 를 쓰지 않는다. 메뉴를 걸면 그것이 아이콘 클릭을
    가져가 팝오버를 띄울 기회가 없다.

    왼쪽·오른쪽 클릭 모두 같은 팝오버를 연다 — 아이콘 하나에 동작이
    둘이면 어느 쪽이 무엇인지 기억해야 한다.
  */
  const open = (): void => {
    if (tray) togglePopover(tray.getBounds())
  }
  tray.on('click', open)
  tray.on('right-click', open)

  return true
}

/** 앱 종료 시 정리. */
export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}
