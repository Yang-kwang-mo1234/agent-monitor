# Agent Monitor — 작업 인수인계 (HANDOFF)

> 이 문서는 이 스킬을 이어서 작업할 사람/agent를 위한 것이다. 사용 방법은 `SKILL.md`, 구현 맥락·결정·미검증 사항은 이 문서를 본다.

## 1. 목표

Threads에 올라온 "Agent monitor component" 영상(Claude Code 에이전트 실행 상태 카드)을 **실제 Claude Code 실행에 연결된 동작하는 기능**으로 만드는 것. 사용자가 고른 형태는 **Claude Code 확장 → 스킬(`/agent-monitor`)**.

참고 디자인에서 재현한 요소:
- 헤더: Claude 로고, 모델명, 부제(`프로젝트 · 프롬프트`), 비용 카운터(마지막 자리 흐리게), 상태 pill(Running/Finished 등), 접기 버튼
- 현재 단계 행: 아이콘 + shimmer 텍스트 + 실행 타이머(`m:ss`)
- 세그먼트 진행 바: 단계별 1칸, 진행 중 칸은 파란 그라데이션 흐름 애니메이션, hover 시 툴팁 + 히스토리 행 하이라이트
- 최근 완료 3단계 목록(최신이 위, 점점 흐려짐) + 소요시간
- 하단: Pause / Cancel, `완료/전체` 카운트, `Log ↗`
- 접힌 상태: pill 형태(로고 · 모델명 · 겹친 단계 아이콘 · 타이머), 아이콘 hover 툴팁 (`라벨 / 소스 · 시간`)
- 완료 상태: "Finished in 14s · N steps", 다크 모드

## 2. 아키텍처

```
Claude Code ──(hooks, stdin JSON)──▶ scripts/hook.js ──append──▶ ~/.claude/agent-monitor/sessions/<sid>.jsonl
Claude Code ──(statusLine, stdin JSON)──▶ scripts/statusline.js ──write──▶ <sid>.meta.json  (model, cost, cwd)
                                                                         ▲
Dashboard (browser) ◀──SSE── scripts/server.js ──read/fold (lib/state.js)┘
Dashboard ──POST /api/control──▶ server.js ──write──▶ <sid>.control.json ◀──poll── hook.js (PreToolUse)
```

- 의존성 없음. Node 18+ 표준 모듈만 사용.
- 모든 상태는 파일 기반. 프로세스 간 통신은 파일로만 한다. 데몬이 꺼져 있어도 hook은 기록을 계속한다.
- 데이터 디렉터리: `~/.claude/agent-monitor/` (`AGENT_MONITOR_DIR` 환경변수로 덮어쓸 수 있음. 테스트에서 사용)

## 3. 파일별 역할

| 파일 | 역할 |
|---|---|
| `SKILL.md` | 스킬 진입점. `disable-model-invocation: true` (사용자가 `/agent-monitor`로만 호출). 설치 → 서버 실행 → 안내 절차 |
| `scripts/hook.js` | 모든 hook 이벤트를 처리하는 단일 스크립트. `hook_event_name`으로 분기. **어떤 경우에도 exit 0** (Claude Code를 깨뜨리지 않기 위해 try/catch 후 `process.exit(0)`) |
| `scripts/statusline.js` | statusLine 명령. meta(비용·모델) 기록 후 한 줄 출력. `--wrap <base64 JSON>`이 있으면 사용자의 기존 statusLine 명령을 같은 stdin으로 실행해 그 출력을 대신 보여준다 |
| `scripts/server.js` | `127.0.0.1:4777` HTTP 서버. 라우트는 아래 참고. 포트 사용 중이면 "이미 실행 중" 메시지 후 exit 0 |
| `scripts/dashboard.html` | 단일 파일 UI(HTML/CSS/JS 인라인). SSE로 state를 받고, 타이머/세그먼트 폭/비용 tween은 클라이언트 `requestAnimationFrame` 루프로 갱신 |
| `scripts/install.js` | settings.json 수정. `--project`, `--uninstall` 플래그. 재실행해도 안전(idempotent) |
| `scripts/control.js` | CLI: `pause|resume|cancel [session_id]` (기본값: 가장 최근 세션) |
| `scripts/lib/paths.js` | 경로, JSONL append/read, control/meta 파일 읽기/쓰기(원자적 rename), 세션 목록 |
| `scripts/lib/labels.js` | tool 호출 → `{label, icon, source}` 변환. 커스터마이즈 지점 |
| `scripts/lib/state.js` | 이벤트 로그 → 카드 상태로 fold하는 순수 로직. server와 statusline이 공유 |

## 4. 데이터 형식

### 4.1 이벤트 로그 `<sid>.jsonl` (append-only, 한 줄에 한 JSON, 모두 `t`(ms epoch) 포함)

| type | 발생 hook | 필드 |
|---|---|---|
| `session_start` | SessionStart | `cwd`, `source` |
| `run_start` | UserPromptSubmit | `prompt`(400자 컷), `cwd`, `costAtStart`(그 시점 meta.cost) |
| `tool_start` | PreToolUse | `id`(tool_use_id), `tool`, `label`, `icon`, `source` |
| `tool_end` | PostToolUse / PostToolUseFailure | `id`, `tool`, `ok`(bool), `error`(실패 시, 300자) |
| `paused` / `resumed` | PreToolUse 대기 시작/종료 | – |
| `notice` | Notification | `message` |
| `run_end` | Stop / 취소 / Esc 중단(PostToolUseFailure `is_interrupt`) / StopFailure | `status`: `finished` \| `cancelled` \| `interrupted` \| `failed`, `error`(StopFailure의 오류 종류) |
| `session_end` | SessionEnd | `reason` |

### 4.2 `<sid>.meta.json` (statusline이 씀)
`{ cost, model, cwd, project, updated }` — 보이는 값이 바뀔 때만 다시 써서 SSE 변경 감지를 조용하게 유지.

### 4.3 `<sid>.control.json`
`{ action: "pause" | "cancel", t, done? }`. resume = 파일 삭제. UserPromptSubmit / Stop / StopFailure / SessionEnd / Esc 중단에서도 삭제(지난 실행의 요청이 다음 실행으로 새지 않게). cancel은 처리 후에도 지우지 않고 `done:true`만 붙인다(아래 Cancel 참고).

### 4.4 state.js 출력 (SSE `state` 이벤트 payload)
```
{ session, model, project, prompt, status, startedAt, endedAt,
  steps: [{id, tool, label, icon, source, start, end, ok, error?}],
  cost /*이번 실행 비용 = meta.cost - run_start.costAtStart*/, sessionCost, notice, error, now }
```
`status` 우선순위: `run_end`가 있으면 그 값(없이 `session_end`가 오면 `interrupted`) → 아니면 `paused`(hook이 대기 중) → `pausing`/`cancelling`(control 파일만 있음) → `waiting`(Notification 이후 열린 단계 없음) → `running`. run이 없으면 `idle`, 세션이 없으면 `empty`.
상태는 **마지막 `run_start` 이후, 첫 `run_end` 전까지의 이벤트만** 사용한다(카드 = 현재/마지막 실행 1건). 취소와 경합한 늦은 이벤트는 무시한다.

## 5. 핵심 동작

### Pause
PreToolUse에서 control이 `pause`면 `paused`를 기록하고 400ms 간격으로 control 파일을 polling (`Atomics.wait`로 동기 sleep). 해제되면 `resumed`. 최대 55분 대기 후 자동 해제. 이를 위해 **PreToolUse hook timeout = 3600초**로 설치한다.

### Cancel
PreToolUse에서 control이 `cancel`이면 `run_end{status:cancelled}`를 기록하고 stdout으로 다음을 출력:
```json
{"continue": false, "stopReason": "Cancelled from Agent Monitor",
 "hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "..."}}
```
`continue:false`로 처리를 멈추고, 혹시 무시돼도 `deny`로 해당 도구 호출은 막는 이중 장치. 문서상 `continue:false`가 우선하며, 실제 실행에서도 턴이 바로 끝났다.
같은 턴의 병렬 도구 호출도 막도록 control 파일을 지우지 않고 `done:true`로 표시만 한다(`run_end`는 한 번만 기록). 다음 UserPromptSubmit 등에서 지워진다.

### 중단과 API 오류
- Esc 중단 시 `Stop`은 실행되지 않는다(공식 문서). 도구 실행 중 중단이면 `PostToolUseFailure`에 `is_interrupt:true`가 오므로 `run_end{interrupted}`를 기록한다.
- 텍스트 생성 중 중단은 알려주는 hook이 없다. 다음 프롬프트가 새 실행을 시작하거나, 세션이 닫히면(`session_end`) `interrupted`로 처리된다.
- API 오류로 턴이 끝나면 `Stop` 대신 `StopFailure`가 오고, `run_end{failed, error}`로 기록한다. 카드에 오류 종류(예: `rate limit`)가 표시된다.

### 서버 라우트
- `GET /` 대시보드, `GET /api/sessions` 최근 25개, `GET /api/state?session=`, `GET /api/log?session=` 원본 JSONL
- `GET /events?session=` SSE. session이 없으면 "최신 세션 따라가기". 300ms마다 (sid + log/control/meta mtime) 시그니처를 비교해 바뀔 때만 push. 15초 ping
- `POST /api/control` `{session, action}` — **`content-type: application/json` 필수**(CORS preflight를 강제해 다른 웹사이트가 버튼을 누르지 못하게 함). 127.0.0.1 바인딩
- 모든 요청은 Host 헤더가 `localhost` / `127.0.0.1` / `[::1]`(포트 포함 가능)일 때만 응답, 그 외 403(DNS rebinding 방지)

### 설치기
- 우리 항목 식별: command 문자열에 `agent-monitor`와 `hook.js|statusline.js`가 둘 다 있으면 우리 것
- 설치 시 먼저 우리 항목을 전부 제거한 뒤 다시 추가 → idempotent. 사용자의 다른 hook 그룹은 보존
- 등록 이벤트: `PreToolUse`(matcher `*`, timeout 3600), `PostToolUse`, `PostToolUseFailure`(matcher `*`, 10), `UserPromptSubmit`, `Stop`, `StopFailure`, `Notification`, `SessionStart`, `SessionEnd`(10)
- 기존 statusLine이 있으면 그 객체를 base64로 `--wrap`에 넣어 감싼다. 별도 설정 파일이 필요 없고, uninstall 때 command에서 디코딩해 원래 값을 복원
- 매번 `settings.json.agent-monitor.bak` 백업. JSON 파싱 실패 시 아무것도 바꾸지 않고 종료

## 6. 설계 결정과 이유

| 결정 | 이유 |
|---|---|
| 파일 기반 IPC | hook은 매번 새 프로세스로 짧게 실행된다. 서버가 꺼져 있어도 기록이 남고, 상태 공유가 단순해진다 |
| 비용은 statusline에서 얻음 | hook 입력에는 비용 정보가 없다. statusLine 입력에는 `cost.total_cost_usd`가 있다 |
| 카드 비용 = 실행 단위 차액 | 참고 영상의 작은 금액($0.036)처럼 "이번 작업 비용"을 보여주기 위함. 세션 누적액은 `sessionCost`로 따로 제공 |
| 세그먼트 폭 = `0.6 + sqrt(초)` | 선형 비례로 하면 긴 빌드 한 칸이 나머지를 짓눌렀다(스크린샷으로 확인 후 변경) |
| 전체 단계 수를 미리 알 수 없음 | 영상의 `3/6`은 데모 값이다. 여기서는 `완료/지금까지 단계 수`로 표시 |
| 브랜드 아이콘은 단순화한 글리프 | GitHub=branch, Notion=N 박스, Slack=4색 막대, Linear=사선 원. 공식 로고를 그대로 쓰지 않음 |
| `propose_skills`를 쓰지 않고 zip으로 전달 | 그 도구는 SKILL.md 한 파일만 저장한다. 이 스킬은 scripts 폴더가 반드시 필요하다 |

## 7. 검증한 것 (클라우드 작업 공간, Node 22, hook 입력은 가짜 JSON)

- hook 이벤트 시뮬레이션 → state fold 정확 (run 비용 0.048 − 0.012 = 0.036)
- Pause: hook이 resume까지 실제로 블로킹(약 1.6초 보류 후 반환), 대기 중 status=`paused`
- Cancel: 위 JSON을 출력하고 status=`cancelled`, 진행 중이던 단계는 `ok:false`
- `POST /api/control`에 JSON content-type이 없으면 415로 거부
- 설치기: 기존 statusLine·사용자 hook이 있는 가짜 HOME에서 설치 → 재설치(그룹 중복 없음) → wrap된 statusline이 사용자 출력(`MY-LINE`)을 표시하면서 비용도 기록 → uninstall 후 원본 settings.json과 **완전히 동일**
- Playwright 스크린샷: light 진행 중(+세그먼트 툴팁), 접힌 pill(+아이콘 툴팁), dark 완료(+실패 단계), Log 드로어, 360px 모바일(가로 넘침 없음. 수정 후 재확인)
- 모든 스크립트 `node --check` 통과

### 7.1 실제 Claude Code 검증 (2026-10-31, macOS, Claude Code 2.1.308, Node 26)
- 임시 프로젝트에 `install.js --project`로 설치하고 `AGENT_MONITOR_DIR`로 기록을 격리한 뒤 `claude -p --model haiku`로 실행
- 실제 `tool_use_id`(`toolu_…`)로 시작/종료가 짝지어짐. Bash와 Read 병렬 호출도 각자 맞게 기록
- 없는 파일 Read → `PostToolUseFailure`의 `error`에 실제 문구가 들어와 `ok:false`로 기록
- Cancel → `continue:false`로 턴이 실제로 끝나고 최종 답변이 나오지 않음. 병렬 호출까지 모두 거부되는 것도 확인(수정 후)
- 공식 문서(code.claude.com/docs/en/hooks) 확인: timeout은 **초** 단위, `tool_use_id`·`error`·`is_interrupt` 필드 존재, `PostToolUseFailure`/`StopFailure`는 정식 이벤트, `continue:false`는 event별 결정 필드보다 우선
- 서버: 외부 Host 헤더 403, 브라우저 대시보드에서 Pause/Resume 버튼, 접힌 pill, Interrupted/Failed 카드 표시 확인

## 8. 검증하지 못한 것 / 위험 요소 (다음 작업자가 먼저 확인할 것)

1. **대화형 세션에서 Esc 중단은 실제로 눌러보지 못했다.** 샌드박스 pty에서 대화형 `claude`가 화면을 그리지 않았다. 문서의 `is_interrupt` 필드 기준으로 구현했고 가짜 입력으로만 검증했다. 직접 `sleep 40` 같은 명령 중에 Esc를 눌러 카드가 Interrupted가 되는지 확인할 것.
2. 텍스트 생성 중 Esc 중단은 hook이 없어 다음 프롬프트나 세션 종료 때까지 Running으로 보인다(알려진 한계).
3. 병렬 tool 호출 시 단계가 겹친다. 기록은 정확하지만 UI는 "첫 번째 열린 단계"만 현재 단계로 보여준다.
4. 서브에이전트 내부 tool 호출은 같은 session_id로 들어와 한 타임라인에 섞인다. 입력에 `agent_id`/`agent_type`이 있으므로 이걸로 묶을 수 있다.
5. statusline 입력에 `workspace`가 빠지면 meta의 project가 null로 덮어써진다(실제 Claude Code는 항상 보내므로 영향 작음).
6. Windows: 경로를 `JSON.stringify`로 따옴표 처리했지만 테스트하지 않았다.
7. Google Fonts(Inter)는 오프라인이면 시스템 폰트로 대체된다(정상 동작).

## 9. 다음에 할 만한 일

- 대화형 세션에서 Esc 중단 확인 (위 1번)
- 완료 단계 라벨을 과거형으로 바꾸기 ("Building the preview" → "Built the preview in 41s", 참고 영상 스타일). `labels.js`에 done 라벨 추가 + state/hist 렌더에 반영
- 병렬 단계 표시, 서브에이전트 단계 그룹핑(`agent_id` 사용)
- 여러 세션을 동시에 보여주는 멀티 카드 뷰
- 오래된 세션 로그 정리(현재는 무한 누적)

## 10. 빠른 재현 (테스트용)

```bash
export AGENT_MONITOR_DIR=/tmp/am AGENT_MONITOR_PORT=4799
node scripts/server.js &
ev(){ echo "$1" | node scripts/hook.js; }
echo '{"session_id":"s1","model":{"display_name":"Claude Opus 5.5"},"workspace":{"project_dir":"/x/web-app"},"cost":{"total_cost_usd":0}}' | node scripts/statusline.js
ev '{"hook_event_name":"UserPromptSubmit","session_id":"s1","prompt":"ship v3.2.0"}'
ev '{"hook_event_name":"PreToolUse","session_id":"s1","tool_name":"Bash","tool_input":{"command":"npm run build","description":"Building the preview"},"tool_use_id":"t1"}'
# → http://localhost:4799 에서 Running 카드 확인
ev '{"hook_event_name":"PostToolUse","session_id":"s1","tool_name":"Bash","tool_use_id":"t1"}'
ev '{"hook_event_name":"Stop","session_id":"s1"}'
```
