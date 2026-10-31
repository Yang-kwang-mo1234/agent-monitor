# Agent Monitor

Claude Code가 지금 무엇을 하고 있는지 채팅 옆 패널에 보여주는 플러그인(`agent-monitor-pane`)입니다. 입력창 위에는 git 브랜치 띠도 나옵니다.

## 빠른 설치 (다른 PC)

1. 저장소가 비공개이므로 GitHub 인증을 먼저 해 둡니다(SSH 키가 있으면 생략).

   ```bash
   gh auth login
   ```

   ```bash
   gh auth setup-git
   ```

2. 터미널에서 Claude Code를 열고, 프롬프트에 다음을 입력해 설치합니다.

   ```
   /plugin install agent-monitor-pane --marketplace Yang-kwang-mo1234/agent-monitor
   ```

3. `Add marketplace?`에 `y`를 입력하고, 설치 범위는 **user**를 고릅니다. 다음 세션부터 옆 패널이 자동으로 열립니다.

자세한 내용은 아래 [옆 패널 플러그인](#옆-패널-플러그인-agent-monitor-pane)을 보세요.

---

## 옆 패널 플러그인 (agent-monitor-pane)

### 다른 PC에 설치하기

**필요한 것**
- Claude Code 2.1.275 이상
- 이 저장소를 읽을 수 있는 GitHub 계정과, 그 PC의 github.com git 인증
  - 저장소가 비공개라서 설치할 때 인증을 묻지 않고 그냥 실패합니다. SSH 키를 등록하거나 다음을 먼저 실행해 두세요.

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
3. switchboard 옵션 화면은 기본값 그대로 두면 됩니다. 기본값은 모델을 바꾸지 않고 비용만 기록합니다.
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

위에서부터 순서대로 나옵니다.

| 섹션 | 내용 |
|---|---|
| 실행 카드 | 모델, 이번 실행 비용, 상태, 현재 단계와 타이머, 단계 막대, 최근 3단계, **Pause / Cancel** |
| Agents | 서브에이전트·백그라운드 셸·코드 리뷰를 한 줄씩 표시. 모델, 경과 시간, 도구 수, 현재 작업, switchboard 모델 선택과 비용, codex review findings. 행을 누르면 메시지나 출력이 펼쳐집니다 |
| Context | 컨텍스트를 카테고리별 색 막대와 범례로 표시, compact 지점, 날씨 표시(☀ → ↯), 최근 턴 sparkline. **Handoff now** 버튼과 80% 자동 handoff(**Auto** 토글) |
| Prompt cache | 캐시 남은 시간(5m/1h), 적중률, 미스 횟수. 만료되면 다음 메시지에서 다시 캐시할 토큰 수 |
| Usage | 5시간·주간 사용률과 리셋까지 남은 시간(구독 계정) |
| Worked today | 오늘 에이전트가 실제로 작업한 시간. 여러 세션이 동시에 일한 시간은 한 번만 셉니다 |
| 오른쪽 아래 | 설치된 패널 버전과 **Update** 버튼. 마켓플레이스에 새 버전이 있을 때만 눌리고(`v0.2.3 → v0.2.4`), 없으면 흐리게 꺼져 있습니다. 30분마다 다시 확인합니다 |

입력창 위에는 **git 브랜치 띠**(`⎇ main · ● 3 changed · ↑2 ↓1`)가 나옵니다.

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

