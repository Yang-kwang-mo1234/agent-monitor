# Agent Monitor

Claude Code가 지금 무엇을 하고 있는지 보여주는 라이브 카드입니다. 현재 단계, 단계 타임라인, 실행 타이머, 이번 실행 비용을 표시하고 **Pause / Resume / Cancel**로 에이전트를 제어할 수 있습니다.

Claude Code 스킬(`/agent-monitor`)로 동작하며, Node.js 18 이상만 있으면 됩니다(외부 의존성 없음).

## 설치

### 1. 스킬 폴더에 두기

이 저장소를 Claude Code 스킬 폴더에 두거나 심볼릭 링크로 연결합니다.

```bash
git clone https://github.com/Yang-kwang-mo1234/agent-monitor.git
```

```bash
ln -s "$PWD/agent-monitor" ~/.claude/skills/agent-monitor
```

### 2. 스킬 실행

Claude Code에서 다음을 입력합니다.

```
/agent-monitor
```

Claude가 Node 버전을 확인하고, hook과 status line을 설치한 뒤, 대시보드 서버를 띄웁니다.

### 수동 설치

스킬 없이 직접 설치하려면:

```bash
node scripts/install.js
```

```bash
node scripts/server.js
```

- `install.js`는 사용자 전역 `~/.claude/settings.json`에 hook과 status line을 추가합니다. 현재 프로젝트에만 설치하려면 `--project`를 붙입니다(`./.claude/settings.json`).
- 여러 번 실행해도 안전합니다. 자신이 추가한 항목만 교체하고 다른 hook은 그대로 둡니다.
- 실행할 때마다 `settings.json.agent-monitor.bak` 백업을 남깁니다.
- 기존 status line이 있으면 감싸서 그대로 표시하고, 제거할 때 원래대로 복원합니다.

> hook은 **다음** Claude Code 세션부터 적용됩니다.

## 사용법

### 대시보드

브라우저에서 <http://localhost:4777>을 엽니다(127.0.0.1에서만 접근 가능).

- **Pause**: 다음 tool 호출 직전에 에이전트를 멈춥니다. **Resume**으로 이어갑니다.
- **Cancel**: 다음 tool 호출 직전에 현재 실행을 끝냅니다.
- **⌄⌃ 버튼**: 카드를 pill 형태로 접거나 펼칩니다.
- **세그먼트/아이콘에 마우스를 올리면** 해당 단계의 상세가 툴팁으로 나옵니다.
- **Log ↗**: 원본 이벤트 로그(JSONL)를 엽니다.

### 셸에서 제어

```bash
node scripts/control.js pause
```

```bash
node scripts/control.js resume
```

```bash
node scripts/control.js cancel <session_id>
```

`session_id`를 생략하면 가장 최근 세션에 적용됩니다.

### 제거

```bash
node scripts/install.js --uninstall
```

프로젝트 단위로 설치했다면 `--project`를 함께 붙입니다. 기록된 로그(`~/.claude/agent-monitor`)는 남아 있으니 필요 없으면 직접 지우세요.

## 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `AGENT_MONITOR_PORT` | `4777` | 대시보드 서버 포트 |
| `AGENT_MONITOR_DIR` | `~/.claude/agent-monitor` | 세션 로그와 제어 파일을 저장하는 위치 |

## 구성

| 파일 | 역할 |
|---|---|
| `scripts/hook.js` | 프롬프트, tool 호출(시작/종료/실패), 알림, 종료를 `sessions/<session>.jsonl`에 기록. tool 호출 전 Pause/Cancel을 확인 |
| `scripts/statusline.js` | 모델명과 세션 비용을 기록하고 한 줄 요약을 출력 |
| `scripts/server.js` + `scripts/dashboard.html` | SSE로 실시간 갱신되는 로컬 대시보드 |
| `scripts/install.js` | settings.json에 hook과 status line 설치/제거 |
| `scripts/control.js` | 셸에서 pause / resume / cancel |
| `scripts/lib/labels.js` | tool 호출을 단계 라벨·아이콘으로 변환(커스터마이즈 가능) |

## 알아둘 점

- 비용은 Claude Code의 클라이언트 측 추정치(`cost.total_cost_usd`)이며, 카드에는 이번 실행분(세션 비용 − 프롬프트 시점 비용)이 표시됩니다.
- Pause와 Cancel은 tool 호출 **사이**에서 동작합니다. 이미 실행 중인 명령은 끝까지 실행됩니다.
- Pause는 최대 55분까지 유지되고 그 뒤에는 자동으로 재개됩니다.
- 텍스트 생성 중 Esc로 중단하면 알려주는 hook이 없어, 다음 프롬프트나 세션 종료 전까지 Running으로 보일 수 있습니다.

구현 배경과 미검증 사항은 [HANDOFF.md](HANDOFF.md), 스킬 동작 정의는 [SKILL.md](SKILL.md)를 참고하세요.
