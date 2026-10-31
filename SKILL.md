---
name: agent-monitor
description: Install or open the Agent Monitor — a live card showing what Claude Code is doing right now (current step, step timeline, timer, run cost) with Pause / Resume / Cancel controls. Use when the user asks to monitor, watch, pause or cancel the running agent, or types /agent-monitor.
disable-model-invocation: true
---

# Agent Monitor

A live monitor for Claude Code runs. Everything lives in this skill folder:

| Part | File | What it does |
|---|---|---|
| Hooks | `scripts/hook.js` | Records each prompt, tool call (start / end / fail), notification and stop into `~/.claude/agent-monitor/sessions/<session>.jsonl`. Before every tool call it honours Pause and Cancel. |
| Status line | `scripts/statusline.js` | Records model and session cost for the card, and prints a one-line summary. If the user already had a status line, it runs theirs and shows that output instead. |
| Dashboard | `scripts/server.js` + `scripts/dashboard.html` | Local page at `http://localhost:4777` (127.0.0.1 only) with the monitor card, live over SSE. |
| Installer | `scripts/install.js` | Adds the hooks and status line to settings.json (backup at `settings.json.agent-monitor.bak`), or removes them and restores the user's status line. |
| Control CLI | `scripts/control.js` | Pause / resume / cancel from a shell. |

Plain Node.js 18+, no dependencies.

## When the user invokes this skill

Work out the skill directory (the folder containing this SKILL.md) and call it `$SKILL`.

1. **Check Node**: `node --version`. If missing or below 18, stop and say Node 18+ is needed.
2. **Install** (safe to re-run; it replaces its own earlier entries and leaves the user's other hooks alone):
   - User-wide (default): `node "$SKILL/scripts/install.js"`
   - This project only, if the user asks: `node "$SKILL/scripts/install.js" --project`
3. **Start the dashboard** in the background: `node "$SKILL/scripts/server.js"` (set `AGENT_MONITOR_PORT` to change port 4777). If it reports the port is busy, the dashboard is already running — don't start another.
4. Tell the user, briefly:
   - Open `http://localhost:4777`.
   - Hooks take effect in the **next** Claude Code session.
   - **Pause** holds the agent before its next tool call; **Cancel** stops the run before its next tool call.
   - The ⌄⌃ button collapses the card into a pill; hover a segment or icon to see that step.

## Other requests

- **Uninstall**: `node "$SKILL/scripts/install.js" --uninstall` (add `--project` if installed per project). Keep the recorded logs unless the user asks to delete `~/.claude/agent-monitor`.
- **Pause / resume / cancel from chat**: `node "$SKILL/scripts/control.js" pause|resume|cancel [session_id]` (defaults to the most recent session). Note: pausing the session you are running in will hold your own next tool call — only do that if the user means it.
- **Show the log**: read the newest `.jsonl` in `~/.claude/agent-monitor/sessions/`, or open *Log ↗* on the card.

## Customising step labels

`scripts/lib/labels.js` maps each tool call to a label, icon and source. Bash uses its `description` ("Building the preview"), file tools use the file name, MCP tools use the server name — GitHub, Notion, Slack and Linear get their own icons. Add servers to `BRANDS` or change the wording there.

## Limits worth knowing

- Cost is Claude Code's client-side estimate (`cost.total_cost_usd`); it updates after each assistant message. The card shows the cost of the current run (session cost minus cost at prompt time).
- Pause and Cancel act **between** tool calls; a command already running finishes first.
- Pause holds for at most 55 minutes, then resumes on its own (the PreToolUse hook timeout is 60 minutes).
