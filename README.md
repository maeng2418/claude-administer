# Claude Administer

맥에 설치된 Claude Code 자산 — 스킬 · 커맨드 · 에이전트 · 훅 · 플러그인 · MCP 서버 — 를
한 화면에서 보고 관리하는 데스크톱 앱.

Electron + TypeScript + React.

## 무엇을 보여주는가

전역(`~/.claude/`), 선택한 프로젝트(`.claude/`), 그리고 설치된 플러그인이 제공하는 자산을
한곳에 모아 보여준다. 각 항목은 어느 범위에서 왔는지 배지로 표시되고, 같은 이름이
여러 범위에 있으면 어느 쪽이 우선하는지(`덮어씀` / `가려짐`) 알려준다.

프로젝트는 사이드바에서 골라 전환한다. 목록은 두 곳에서 모은다.

- **사용 기록에서 발견** — `~/.claude/projects/` 의 세션 파일에서 실제 경로(`cwd`)를 읽는다.
  디렉토리명은 경로 구분자와 이름 속 하이픈이 똑같이 `-` 로 바뀌어 역산이 불가능하므로,
  파일 내용의 `cwd` 를 유일한 근거로 쓴다.
- **폴더 직접 추가** — 사용 기록이 없는 새 프로젝트용. 선택은 앱 전용 파일에 저장되며
  `~/.claude/` 는 건드리지 않는다.

한 번에 한 프로젝트만 본다. 여러 프로젝트를 한 목록에 합치지 않는 이유는 `가려짐` 배지가
거짓이 되기 때문이다 — 가림은 같은 프로젝트 안에서 전역 대 프로젝트일 때만 일어나고,
다른 프로젝트끼리는 서로 영향이 없다.

홈(`~`)과 `Desktop` 같은 상위 폴더는 목록에서 뺀다. 그 자리에서 Claude Code 를 한 번
띄우면 `.claude/` 가 생겨 발견 조건을 통과하지만, 이들은 프로젝트가 아니라 프로젝트를
담는 그릇이고 파일 접근 허용 범위로 쓰면 그 아래 전부가 열린다.

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
- **프로젝트 전환** — 발견된 프로젝트 또는 직접 추가한 폴더를 골라 본다
- **켜기 / 끄기** — 전용 설정 키가 있는 자산만

### 무엇을 끌 수 있는가

Claude Code 는 자산 종류마다 끄는 방법이 다르고, 전용 키가 없는 것도 있다.
전용 키가 있는 세 종류만 토글을 제공하고, 나머지는 사유를 툴팁에 붙여
`끄기 불가` 로 보여준다 — 버튼을 숨기면 "왜 없지"를 매번 묻게 된다.

| 자산 | 끄는 방법 | 토글 |
|---|---|---|
| 스킬 (전역 · 프로젝트) | `settings.json` 의 `skillOverrides[name] = "off"` | 가능 |
| 스킬 (플러그인 제공) | `skillOverrides` 가 적용되지 않음 | 불가 — 플러그인을 끄세요 |
| 에이전트 | `settings.json` 의 `permissions.deny` 에 `Agent(name)` | 가능 |
| 플러그인 | `settings.json` 의 `enabledPlugins[id] = false` | 가능 |
| 커맨드 | 전용 설정 없음 | 불가 — 파일을 옮기거나 지워야 함 |
| 훅 | `hooks` 항목을 직접 지워야 함 | 불가 — 편집기로 열어 수정 |
| MCP 서버 | `mcp.json` 항목을 직접 지워야 함 | 불가 — 편집기로 열어 수정 |

훅과 MCP 를 토글에 넣지 않은 이유는 전용 스위치가 없어서다. 끄려면 원래 설정 항목을
지우고 되돌릴 사본을 따로 보관해야 하는데, `hooks` 는 중첩 구조라 같은 안전장치를
쓸 수 없다. 쓰기 범위를 넓히는 것보다 안 깨지는 쪽을 골랐다.

토글은 모두 전역 `~/.claude/settings.json` 에 쓴다. 적용에는 Claude Code 재시작이 필요하다.

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
| 스캐너 | 실제 자산 스캔 | 스킬 116 · 커맨드 58 · 에이전트 29 · 훅 64 · 플러그인 16 · MCP 2 |
| 충돌 탐지 | 합성 이름 충돌 주입 | 양방향 표시 확인 |
| 토글 쓰기 (3종) | 실파일 사본 대상 33개 단정 | 33/33, 실제 파일 sha256 불변 확인 |
| 프로젝트 발견 · 경로 가드 | 실제 `~/.claude/projects/` + traversal 7종 | 41/41 |
| 앱 실행 | 오프스크린 실행 후 실제 DOM 조회 | 32/32 통과, 콘솔 오류 0 |

에이전트 수가 19에서 29로 늘어난 것은 플러그인이 제공하는 에이전트를 이전에는
개수만 세고 목록에서 버렸기 때문이다.

## 구조

```
src/
  shared/types.ts      자산 타입 (main · renderer 공용)
  main/
    frontmatter.ts     YAML frontmatter 파서
    scanner.ts         자산 스캔 (읽기 전용)
    projects.ts        프로젝트 발견 · 선택 저장 · 허용 경로
    settings.ts        settings.json 쓰기 (백업 · 검증 · 복구)
    index.ts           Electron main + IPC + 경로 가드
  preload/index.ts     contextBridge — 7개 함수만 노출
  renderer/            React UI
```

## 알려진 한계

- 쓰기는 `settings.json` 의 세 키(`skillOverrides` · `permissions.deny` · `enabledPlugins`)
  뿐이다. 커맨드 · 훅 · MCP 는 읽기와 "편집기로 열기"까지다
- 한 번에 한 프로젝트만 본다. 여러 프로젝트를 나란히 비교하는 화면은 없다
- 프로젝트 발견은 Claude Code 사용 기록에 의존한다. 기록이 없는 프로젝트는
  폴더를 직접 추가해야 한다
- 권한 규칙(`permissions.allow` 57개) · 마켓플레이스 · 플러그인 설정값
  (`pluginConfigs`) · `settings.local.json` 은 아직 화면에 없다
- 앱 서명이 없어 `npm run pack` 산출물은 이 기계에서만 실행된다
