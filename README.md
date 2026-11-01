# Agent Monitor

Claude Code가 지금 무엇을 하고 있는지 채팅 옆 패널에 보여주는 플러그인(`agent-monitor-pane`)입니다. 입력창 위에는 git 브랜치 띠도 나옵니다.

## 옆 패널 플러그인 (agent-monitor-pane)

### 설치

**필요한 것**
- Claude Code 2.1.275 이상
- 이 저장소를 읽을 수 있는 GitHub 계정과, 그 PC의 github.com git 인증
  - 저장소가 비공개라서 인증이 없으면 묻지 않고 그냥 실패합니다. SSH 키를 등록했다면 생략하고, 아니면 먼저 다음을 실행해 두세요.

```bash
gh auth login
```

```bash
gh auth setup-git
```

**설치**: 터미널에서 실행한 Claude Code 프롬프트에 입력합니다.

```
/plugin install agent-monitor-pane --marketplace Yang-kwang-mo1234/agent-monitor
```

셸에서 바로 설치할 수도 있습니다.

```bash
claude plugin install agent-monitor-pane --marketplace Yang-kwang-mo1234/agent-monitor
```

1. `Add marketplace?`에 `y`를 입력합니다.
2. 설치 범위는 **user**(모든 프로젝트)를 고릅니다.
3. 옵션 화면은 기본값 그대로 두면 됩니다. 기본값은 모델을 바꾸지 않고 비용만 기록하며, 예산도 걸지 않습니다.
4. `Installed agent-monitor-pane`이 나오면 끝입니다. 다음 세션부터 패널이 자동으로 열립니다.

데스크톱 앱(Code 탭)에서는 `/plugin`이 동작하지 않습니다. 프롬프트 옆 **+** → **Plugins** → **Add marketplace**에 `Yang-kwang-mo1234/agent-monitor`를 넣고 **Add plugin**으로 설치하거나, 터미널에서 user 범위로 설치하세요. user 범위로 설치하면 데스크톱 앱 세션에서도 로드됩니다.

**업데이트**

```
/plugin marketplace update agent-monitor
```

**제거**

```
/plugin uninstall agent-monitor-pane
```

### 패널에 보이는 것

위에서부터 순서대로 나옵니다. 높이가 일정한 섹션(Usage, Cost & time, Context)이 위에, 실행에 따라 길이가 바뀌는 실행 카드와 Activity가 아래에 옵니다. Usage 아래 섹션은 흐린 구분선(`── Cost & time ──`, `── Context ──`, `── This turn ──`, `── Activity ──`)으로 같은 성격끼리 묶입니다. Activity 구분선은 Tools나 Agents가 있을 때만 나옵니다.

| 섹션 | 내용 |
|---|---|
| Usage | 5시간·주간 사용률과 리셋까지 남은 시간(구독 계정) |
| Spend | 이 세션 비용과 과금 방식. 구독(`Subscription (pro) · API-price estimate, not charged`)인지 종량제(`Metered (API key) · billed per token`)인지 보여 주고, 예산을 정했으면 예산 막대(`45% of $5.00`)와 단계도 나옵니다 |
| Worked today | 오늘 에이전트가 실제로 작업한 시간. 여러 세션이 동시에 일한 시간은 한 번만 셉니다. 아래에 최근 7일 작업 시간 sparkline과 7일 합계 시간·비용(`7 days ▁▃▅█▂▁▄ 12h 40m · ≈$8.20`)이 나옵니다 |
| Context | 컨텍스트를 카테고리별 색 막대와 범례로 표시, compact 지점, 날씨 표시(☀ → ↯), 최근 턴 sparkline. **Handoff now** 버튼과 80% 자동 handoff(**Auto** 토글) |
| Prompt cache | 캐시 남은 시간(5m/1h), 적중률, 미스 횟수. 만료되면 다음 메시지에서 다시 캐시할 토큰 수 |
| 실행 카드 | 모델, 이번 실행 비용(구독이면 `≈`로 추정치 표시), 상태(API 오류로 끝나면 `Failed · rate limited`처럼 이유까지), 현재 단계와 타이머(승인을 물은 단계는 승인 후 그 도구가 끝날 때까지 `Asked for approval · …`. auto 모드처럼 사람에게 묻지 않는 모드에서는 표시하지 않음), 단계 막대, 최근 3단계, **Pause / Cancel**. 실패한 단계는 ✗와 함께 오류 첫 줄이 아래에 나옵니다 |
| Tools | 이 세션의 도구 호출 수와 실패 수, 시간을 가장 많이 쓴 도구 3개(`Bash 12× 41.2s (1✗)`), 최근 실패 3건과 그 이유. 서브에이전트의 도구 호출도 함께 셉니다 |
| Agents | 서브에이전트·백그라운드 셸·코드 리뷰를 한 줄씩 표시. 모델, 경과 시간, 도구 수, 현재 작업, switchboard 모델 선택과 비용, codex review findings. 서브에이전트는 자기 할 일 목록의 진행 막대(`2/4 · 지금 단계`), 대기(◐ waiting)·유휴(○ idle) 상태, 실패한 도구 수, 끝나면 결과 한 줄(`↳ …`)도 보여 줍니다. 서브에이전트가 띄운 서브에이전트는 부모 아래에 `└`로 들여 씁니다. 행을 누르면 받은 작업(`given:`), 토큰(입력·출력·캐시 읽기), 할 일 목록, 메시지나 출력, 결과 전체가 펼쳐집니다 |
| 아래 줄 | 왼쪽에 에이전트 진행율 바, 오른쪽에 설치된 패널 버전과 **Update** 버튼. 진행율은 에이전트의 할 일 목록에서 끝난 비율이고(`2/4 · 50%`), 목록이 없으면 작업 중에 블록이 좌우로 오갑니다. Update는 마켓플레이스에 새 버전이 있을 때만 눌리고(`v0.2.5 → v0.2.6`), 없으면 흐리게 꺼져 있습니다. 30분마다 다시 확인합니다 |

입력창 위에는 **git 브랜치 띠**(`agent-monitor ⎇ main · ● 3 changed · ↑2 ↓1`)가 나옵니다. 맨 앞은 저장소 이름으로, origin 주소의 마지막 부분이고 origin이 없으면 저장소 최상위 폴더 이름입니다.

브랜치 띠 오른쪽 끝에는 graphify 버튼이 있습니다. 세션 폴더에 그래프(`graphify-out/graph.json`)가 있는지에 따라 바뀝니다.

- **Graft Init** (그래프가 없을 때): 누르면 `graphify update .`로 세션 폴더의 코드 그래프를 처음 만듭니다. 끝나면 버튼이 **Graft Update**로 바뀝니다.
- **Graft Update** (그래프가 있을 때): 누르면 `graphify update`로 처음 만든 뒤 바뀐 코드 파일을 그래프에 다시 반영합니다.
- 둘 다 LLM을 쓰지 않아 비용이 없습니다. 끝나면 결과를 알림으로 보여 주고(`✓ Graft Init: Rebuilt: 72 nodes, 85 edges, 7 communities`), 실행 중에는 버튼 자리에 `Initializing…`이나 `Updating…`이 나옵니다.
- 코드만 그래프로 만듭니다. 문서, 논문, 이미지까지 넣으려면 Claude에게 `/graphify .`(처음)나 `/graphify --update`(이후)를 요청하세요.
- 그래프는 프로젝트의 `graphify-out/` 폴더에 생깁니다. 커밋하지 않으려면 프로젝트의 `.gitignore`에 `graphify-out/`을 넣으세요.
- 브랜치 이름이 길면 버튼이 다음 줄로 밀리지 않도록 이름 뒤쪽을 `...`으로 자릅니다.
- [graphify](https://github.com/Graphify-Labs/graphify) CLI가 필요합니다: `uv tool install graphifyy`

- `/monitor`: 닫은 패널을 다시 엽니다.
- **Pause**는 다음 도구 호출 직전에 Resume / Cancel을 묻습니다. **Cancel**은 실행 중인 턴을 바로 끊습니다.

### switchboard 설정 (선택)

`/config`에서 바꿀 수 있습니다.

| 옵션 | 기본값 | 설명 |
|---|---|---|
| Picker | `off` | `openai` 또는 `jev`로 바꾸면, 모델을 지정하지 않은 서브에이전트에 모델을 골라 줍니다. 외부로는 서브에이전트 종류와 짧은 이름만 보냅니다 |
| Mode | `auto` | `suggest`로 바꾸면 고른 모델을 표시만 하고 바꾸지는 않습니다 |
| Models / Style | `haiku-sonnet-opus` / `saver` | 고를 수 있는 모델 범위와 고르는 성향 |
| API 키 | 비어 있음 | OpenAI, TypeSafe, Vercel AI Gateway 키. 비워 두면 환경 변수를 씁니다 |

비용은 2026-09-25 기준 API 가격으로 계산한 추정치이고, 실제 요금제 청구액과는 다릅니다.

### 과금 방식과 예산 (선택)

`/config`에서 바꿀 수 있습니다.

| 옵션 | 기본값 | 설명 |
|---|---|---|
| Billing | `auto` | 세션을 시작할 때 `claude auth status`를 한 번 실행합니다. claude.ai 로그인은 구독이라 비용을 추정치로만 보여 주고, API 키나 Bedrock·Vertex·Foundry는 종량제로 봅니다. 구독인데 추가 사용량이 토큰 단위로 청구된다면 `metered`로 바꾸세요 |
| Budget (USD) | `0` (없음) | 세션 하나의 비용 예산(달러). 80%에서 알림, 90%에서 새 서브에이전트를 가장 싼 모델로, 100%에서 다음 도구 호출 전에 계속할지 묻습니다 |
| Enforce budget | 끔 | 끄면 알림만 보냅니다. 켜면 90% 이후 새 서브에이전트를 Models 범위의 가장 싼 모델(haiku 또는 sonnet)로 돌리고, 100%가 되면 도구를 쓰기 전에 **Continue / Stop**을 묻습니다. Stop은 지금 턴을 끊고, Continue를 누르면 이 세션에서는 다시 묻지 않습니다 |

예산은 이 세션의 `/cost` 합계로 잽니다. 구독 계정에서는 실제 청구액이 아니라 API 가격으로 계산한 값입니다.

### 개발

플러그인 소스는 [`pane/`](pane/)에 있습니다.

```bash
claude plugin validate pane
```

```bash
claude plugin test pane
```

설치하지 않고 이 폴더에서 바로 실행하려면:

```bash
claude --plugin-dir pane
```

context-bar, token-weather, cache-clock, agent-radar, switchboard, review-watch는 [hamzafer/claude-code-mods](https://github.com/hamzafer/claude-code-mods)의 mod를 패널에 맞게 합친 것입니다. `pane/hooks/route.ts`와 `pane/hooks/watch.ts`는 원본 파일을 그대로 가져왔습니다.

Tools 섹션, 과금 방식 구분, 예산 단계, 서브에이전트 트리와 받은 작업 표시, 승인 대기와 API 오류 표시, 7일 추세는 [flightdeckhq/flightdeck](https://github.com/flightdeckhq/flightdeck)(Apache-2.0)의 아이디어를 패널에 맞게 새로 구현한 것입니다(`pane/hooks/spend.ts`). 코드는 가져오지 않았습니다.

