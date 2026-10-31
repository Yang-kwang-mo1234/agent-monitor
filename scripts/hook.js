#!/usr/bin/env node
// Claude Code hook: records the run, and honours Pause / Cancel before each tool call.
// It must never break Claude Code, so every path ends in exit 0.
const fs = require('fs');
const P = require('./lib/paths');
const { describe } = require('./lib/labels');

const MAX_PAUSE_MS = 55 * 60 * 1000;

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function preToolUse(sid, input) {
  let ctrl = P.readControl(sid);

  if (ctrl.action === 'pause') {
    P.append(sid, { type: 'paused' });
    const until = Date.now() + MAX_PAUSE_MS;
    while (Date.now() < until) {
      sleep(400);
      ctrl = P.readControl(sid);
      if (ctrl.action !== 'pause') break;
    }
    if (ctrl.action === 'pause') { P.clearControl(sid); ctrl = {}; }
    if (ctrl.action !== 'cancel') P.append(sid, { type: 'resumed' });
  }

  if (ctrl.action === 'cancel') {
    // Keep the cancel in place so parallel tool calls in the same batch are denied too.
    // UserPromptSubmit / Stop / SessionEnd clear it.
    if (!ctrl.done) {
      P.writeControl(sid, { ...ctrl, done: true });
      P.append(sid, { type: 'run_end', status: 'cancelled' });
    }
    emit({
      continue: false,
      stopReason: 'Cancelled from Agent Monitor',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'The user cancelled this run from Agent Monitor. Stop and wait for the next instruction.',
      },
    });
    return;
  }

  const d = describe(input.tool_name, input.tool_input);
  P.append(sid, {
    type: 'tool_start',
    id: input.tool_use_id || null,
    tool: input.tool_name,
    label: d.label,
    icon: d.icon,
    source: d.source,
  });
}

function main() {
  let input = {};
  try { input = JSON.parse(readStdin() || '{}'); } catch {}
  const event = input.hook_event_name || process.argv[2];
  const sid = input.session_id || 'unknown';

  switch (event) {
    case 'SessionStart':
      P.append(sid, { type: 'session_start', cwd: input.cwd, source: input.source });
      break;
    case 'UserPromptSubmit': {
      P.clearControl(sid);
      const meta = P.readMeta(sid);
      P.append(sid, {
        type: 'run_start',
        prompt: String(input.prompt || '').replace(/\s+/g, ' ').slice(0, 400),
        cwd: input.cwd,
        costAtStart: typeof meta.cost === 'number' ? meta.cost : null,
      });
      break;
    }
    case 'PreToolUse':
      preToolUse(sid, input);
      break;
    case 'PostToolUse':
      P.append(sid, { type: 'tool_end', id: input.tool_use_id || null, tool: input.tool_name, ok: true });
      break;
    case 'PostToolUseFailure':
      P.append(sid, {
        type: 'tool_end', id: input.tool_use_id || null, tool: input.tool_name, ok: false,
        error: String(input.error || '').slice(0, 300),
      });
      // Esc during a tool call ends the turn, and Stop does not fire after an interrupt.
      if (input.is_interrupt) {
        P.clearControl(sid);
        P.append(sid, { type: 'run_end', status: 'interrupted' });
      }
      break;
    case 'Notification':
      P.append(sid, { type: 'notice', message: String(input.message || '').slice(0, 300) });
      break;
    case 'Stop':
      P.clearControl(sid);
      P.append(sid, { type: 'run_end', status: 'finished' });
      break;
    case 'StopFailure': // the turn ended on an API error instead of Stop
      P.clearControl(sid);
      P.append(sid, { type: 'run_end', status: 'failed', error: String(input.error || '').slice(0, 100) });
      break;
    case 'SessionEnd':
      P.clearControl(sid);
      P.append(sid, { type: 'session_end', reason: input.reason });
      break;
  }
}

try { main(); } catch (e) {
  try { process.stderr.write('agent-monitor: ' + e.message + '\n'); } catch {}
}
process.exit(0);
