#!/bin/sh
# 빌드한 앱을 /Applications 에 설치하고 다시 띄운다.
#
# 실행 중인 앱을 덮어쓰면 macOS 가 번들을 잠그고 있어 복사가 깨지므로,
# 반드시 먼저 종료한다. DMG 가 마운트돼 있어도 같은 이유로 떼어낸다.
set -eu

APP_NAME="Claude Administer"
SRC="release/mac-arm64/${APP_NAME}.app"
DEST="/Applications/${APP_NAME}.app"
VOLUME="/Volumes/${APP_NAME}"

if [ ! -d "$SRC" ]; then
  echo "빌드 산출물이 없습니다: $SRC" >&2
  echo "먼저 'npm run dist' 또는 'npm run pack' 을 실행하세요." >&2
  exit 1
fi

# 마운트된 DMG 가 있으면 떼어낸다. 없으면 조용히 넘어간다.
if [ -d "$VOLUME" ]; then
  hdiutil detach "$VOLUME" -quiet 2>/dev/null || true
  echo "DMG 언마운트"
fi

# 실행 중이면 종료하고 완전히 내려갈 때까지 기다린다.
if pgrep -f "${DEST}/Contents/MacOS/" >/dev/null 2>&1; then
  echo "실행 중인 앱 종료"
  osascript -e "quit app \"${APP_NAME}\"" 2>/dev/null || true
  i=0
  while pgrep -f "${DEST}/Contents/MacOS/" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt 20 ]; then
      # 정상 종료를 기다려도 안 내려가면 강제 종료한다.
      pkill -f "${DEST}/Contents/MacOS/" 2>/dev/null || true
      break
    fi
    sleep 0.5
  done
fi

# 이전 설치본을 지우고 새로 복사한다. 덮어쓰기는 옛 파일이 남을 수 있다.
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
echo "설치: $DEST"

# 빌드 산출물을 Spotlight 색인에서 뺀다.
#
# release/ 에도 같은 앱 번들이 있어서, 색인되면 Spotlight 검색에 같은
# 이름이 둘 뜬다 — 설치본과 빌드 산출물. 어느 쪽을 누르는지 알 수 없어
# 엉뚱한 사본을 띄우게 된다.
#
# 복사가 끝난 뒤에 심는 이유: 먼저 두면 마커가 $DEST 안으로 함께 복사돼
# /Applications 의 설치본까지 색인에서 빠진다.
#
# 파일은 빌드할 때마다 사라지므로 설치할 때마다 다시 심는다.
touch "$(dirname "$SRC")/.metadata_never_index" 2>/dev/null || true

open -a "$DEST"
echo "실행: ${APP_NAME}"
