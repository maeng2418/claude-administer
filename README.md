# Claude Administer

맥에 설치된 Claude Code 자산 — 스킬 · 커맨드 · 에이전트 · 훅 · 플러그인 · MCP 서버 — 를
한 화면에서 보고 관리하는 데스크톱 앱.

Electron + TypeScript + React.

## 무엇을 보여주는가

전역(`~/.claude/`), 현재 프로젝트(`.claude/`), 그리고 설치된 플러그인이 제공하는 자산을
한곳에 모아 보여준다. 각 항목은 어느 범위에서 왔는지 배지로 표시되고, 같은 이름이
여러 범위에 있으면 어느 쪽이 우선하는지(`덮어씀` / `가려짐`) 알려준다.

| 탭 | 읽는 곳 |
|---|---|
| 스킬 | `skills/<name>/SKILL.md` (전역 · 프로젝트 · 플러그인) |
| 커맨드 | `commands/**/*.md` — 하위 디렉토리는 `/dir:name` 네임스페이스 |
| 에이전트 | `agents/**/*.md` |
| 훅 | `settings.json` 의 `hooks` 블록 (이벤트별로 평탄화) |
| 플러그인 | `plugins/installed_plugins.json` + `settings.json` 의 `enabledPlugins` |
| MCP 서버 | `~/.claude/mcp.json`, 프로젝트 `.mcp.json` |

## 할 수 있는 것

- **검색** — 이름 · 설명 · 경로 · 트리거 · 훅 명령 전문을 한 번에 훑는다
- **열기 / 위치** — 기본 편집기로 열거나 Finder 에서 위치 보기
- **플러그인 켜기 / 끄기** — `settings.json` 의 `enabledPlugins` 한 키만 수정

플러그인을 토글하면 Claude Code 를 재시작해야 적용된다.

## 설치와 실행

```bash
npm install

# Electron 44 는 패키지에 postinstall 훅이 없어 바이너리가 자동으로
# 내려오지 않는다. 설치 후 한 번 직접 실행해야 한다.
node node_modules/electron/install.js

npm run dev
```

`npm run dev` 는 앱을 실행한 디렉토리를 "현재 프로젝트"로 본다. 다른 프로젝트를 보려면
그 디렉토리에서 실행하면 된다.

```bash
npm run typecheck   # main + renderer 타입 검사
npm run build       # out/ 에 번들 생성
npm run pack        # .app 생성 (서명 없음)
```

## 안전장치

이 도구가 쓰는 파일은 `~/.claude/settings.json` 하나뿐이고, 그 쓰기 경로는 다음을 지킨다.

1. **백업 먼저** — 쓰기 전에 `settings.json.bak-<타임스탬프>` 사본을 만든다
2. **한 키만** — `enabledPlugins` 외의 키는 읽은 그대로 되돌려 쓴다
3. **원자적 교체** — 임시 파일에 쓰고 `rename` 한다. 중간에 끊겨도 반쯤 덮인 파일이 남지 않는다
4. **되읽어 검증** — 쓴 뒤 다시 파싱해 값과 키 구성을 확인하고, 어긋나면 백업에서 복구한다
5. **깨진 파일은 건드리지 않음** — `settings.json` 파싱이 실패하면 아예 쓰지 않는다
6. **없는 항목은 만들지 않음** — `enabledPlugins` 에 없는 플러그인 ID 는 거부한다

renderer 에는 Node 를 주지 않는다(`contextIsolation: true`, `nodeIntegration: false`).
파일 접근은 전부 IPC 를 거치며, `열기` / `위치` 가 받는 경로는 정규화 후
`~/.claude` 와 현재 프로젝트 아래로 제한된다 — `..` 를 쓴 경로 탈출은 거부된다.

스캔은 읽기 전용이고 부분 실패를 허용한다. 파일 하나가 깨져도 스캔 전체가 멈추지 않고,
읽지 못한 파일은 화면 상단에 접힌 목록으로 모인다.

## 검증된 범위

| 대상 | 방법 | 결과 |
|---|---|---|
| frontmatter 파서 | 실제 파일 3종 + 엣지 8종 | 5/5 통과 |
| 스캐너 | 실제 자산 275개 스캔 | 스킬 116 · 커맨드 58 · 에이전트 19 · 훅 64 · 플러그인 16 · MCP 2 |
| 충돌 탐지 | 합성 이름 충돌 주입 | 양방향 표시 확인 |
| settings 쓰기 | 실파일 사본 대상 14개 단정 | 통과, 실제 파일 sha256 불변 확인 |
| 경로 가드 | traversal 5종 + 접두사 혼동 등 21종 | 21/21 거부/허용 일치 |
| 앱 실행 | 오프스크린 실행 후 실제 DOM 조회 | 9/9 통과, 콘솔 오류 0 |

## 구조

```
src/
  shared/types.ts      자산 타입 (main · renderer 공용)
  main/
    frontmatter.ts     YAML frontmatter 파서
    scanner.ts         자산 스캔 (읽기 전용)
    settings.ts        settings.json 쓰기 (백업 · 검증 · 복구)
    index.ts           Electron main + IPC + 경로 가드
  preload/index.ts     contextBridge — 4개 함수만 노출
  renderer/            React UI
```

## 알려진 한계

- 플러그인 활성 토글 외의 쓰기는 지원하지 않는다. 스킬 · 에이전트 · 커맨드 · 훅은
  읽기와 "편집기로 열기"까지다
- 프로젝트는 앱을 실행한 디렉토리 하나만 본다. 맥 전체 프로젝트 스캔은 없다
- 앱 서명이 없어 `npm run pack` 산출물은 이 기계에서만 실행된다
