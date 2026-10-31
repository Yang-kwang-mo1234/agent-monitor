#!/usr/bin/env node
// Claude Code status line. Records model + cost for the dashboard, then prints a line.
// If the user had their own status line, the installer passes it as --wrap <base64>,
// and we run it and print its output instead of ours.
const fs = require('fs');
const { spawnSync } = require('child_process');
const P = require('./lib/paths');
const { current } = require('./lib/state');

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch {}
let d = {};
try { d = JSON.parse(raw || '{}'); } catch {}

const sid = d.session_id;
try {
  if (sid) {
    P.writeMeta(sid, {
      cost: d.cost && typeof d.cost.total_cost_usd === 'number' ? d.cost.total_cost_usd : null,
      model: (d.model && d.model.display_name) || null,
      cwd: (d.workspace && d.workspace.current_dir) || d.cwd || null,
      project: (d.workspace && d.workspace.project_dir) || null,
      updated: Date.now(),
    });
  }
} catch {}

function wrapped() {
  const i = process.argv.indexOf('--wrap');
  if (i < 0 || !process.argv[i + 1]) return null;
  try { return JSON.parse(Buffer.from(process.argv[i + 1], 'base64').toString('utf8')); } catch { return null; }
}

const prev = wrapped();
if (prev && prev.command) {
  const r = spawnSync(prev.command, { input: raw, shell: true, encoding: 'utf8', timeout: 5000 });
  process.stdout.write(r.stdout || '');
  process.exit(0);
}

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const accent = (s) => `\x1b[38;5;173m${s}\x1b[0m`;
const parts = [accent('✻ ') + ((d.model && d.model.display_name) || 'Claude')];
try {
  if (sid) {
    const s = current(sid);
    if (s.status === 'paused' || s.status === 'pausing') parts.push('⏸ paused');
    else if (s.live) parts.push(s.live.label);
    const done = s.steps.filter((x) => x.end != null).length;
    if (s.steps.length) parts.push(dim(`${done}/${s.steps.length}`));
  }
} catch {}
const cost = d.cost && d.cost.total_cost_usd;
if (typeof cost === 'number') parts.push(dim('$' + cost.toFixed(3)));
process.stdout.write(parts.join(dim(' · ')));
