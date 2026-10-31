// Folds a session's event log into the state the card shows.
const path = require('path');
const P = require('./paths');

function compute(sid) {
  if (!sid) return { session: null, status: 'empty', steps: [], now: Date.now() };
  const events = P.readEvents(sid);
  const meta = P.readMeta(sid);
  const ctrl = P.readControl(sid);

  let startIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'run_start') { startIdx = i; break; }
  }
  const run = startIdx >= 0 ? events[startIdx] : null;
  const runEvents = startIdx >= 0 ? events.slice(startIdx + 1) : [];

  const steps = [];
  const byId = {};
  let status = run ? 'running' : 'idle';
  let endedAt = null;
  let paused = false;
  let notice = null;

  for (const e of runEvents) {
    if (endedAt) break; // ignore stragglers after the run ended (e.g. calls racing a cancel)
    switch (e.type) {
      case 'tool_start': {
        const s = { id: e.id, tool: e.tool, label: e.label, icon: e.icon, source: e.source, start: e.t, end: null, ok: null };
        steps.push(s);
        if (e.id) byId[e.id] = s;
        notice = null;
        break;
      }
      case 'tool_end': {
        let s = e.id && byId[e.id];
        if (!s) s = [...steps].reverse().find((x) => x.end == null && x.tool === e.tool);
        if (s && s.end == null) { s.end = e.t; s.ok = e.ok !== false; if (e.error) s.error = e.error; }
        break;
      }
      case 'paused': paused = true; break;
      case 'resumed': paused = false; break;
      case 'notice': notice = { message: e.message, t: e.t }; break;
      case 'run_end':
        if (!endedAt) { status = e.status || 'finished'; endedAt = e.t; }
        paused = false;
        break;
    }
  }

  if (endedAt) {
    for (const s of steps) if (s.end == null) { s.end = endedAt; s.ok = status === 'finished'; }
  } else if (run) {
    if (paused) status = 'paused';
    else if (ctrl.action === 'pause') status = 'pausing';
    else if (ctrl.action === 'cancel') status = 'cancelling';
    else if (notice && !steps.some((s) => s.end == null)) status = 'waiting';
  }

  const sessionCost = typeof meta.cost === 'number' ? meta.cost : null;
  let cost = sessionCost;
  if (sessionCost != null && run && typeof run.costAtStart === 'number') {
    cost = Math.max(0, sessionCost - run.costAtStart);
  }
  const cwd = meta.project || meta.cwd || (run && run.cwd) || (events[0] && events[0].cwd) || '';

  return {
    session: sid,
    model: meta.model || 'Claude',
    project: cwd ? path.basename(cwd) : '',
    prompt: run ? run.prompt : '',
    status,
    startedAt: run ? run.t : null,
    endedAt,
    steps,
    cost,
    sessionCost,
    notice: status === 'waiting' ? notice : null,
    now: Date.now(),
  };
}

function current(sid) {
  const s = compute(sid);
  const live = s.steps.find((x) => x.end == null);
  return { ...s, live };
}

module.exports = { compute, current };
