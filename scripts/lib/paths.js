// Shared file locations and tiny read/write helpers. No dependencies.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.AGENT_MONITOR_DIR || path.join(os.homedir(), '.claude', 'agent-monitor');
const SESSIONS = path.join(ROOT, 'sessions');

function ensure() {
  fs.mkdirSync(SESSIONS, { recursive: true });
}

const safe = (sid) => String(sid || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
const logFile = (sid) => path.join(SESSIONS, safe(sid) + '.jsonl');
const controlFile = (sid) => path.join(SESSIONS, safe(sid) + '.control.json');
const metaFile = (sid) => path.join(SESSIONS, safe(sid) + '.meta.json');

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function writeJSON(file, data) {
  ensure();
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

const readControl = (sid) => readJSON(controlFile(sid));
const writeControl = (sid, data) => writeJSON(controlFile(sid), data);
function clearControl(sid) {
  try { fs.unlinkSync(controlFile(sid)); } catch {}
}

const readMeta = (sid) => readJSON(metaFile(sid));
function writeMeta(sid, patch) {
  const prev = readMeta(sid);
  const next = { ...prev, ...patch };
  // Only touch the file when something visible changed, so watchers stay quiet.
  const changed = Object.keys(patch).some((k) => k !== 'updated' && prev[k] !== patch[k]);
  if (changed) writeJSON(metaFile(sid), next);
}

function append(sid, obj) {
  ensure();
  fs.appendFileSync(logFile(sid), JSON.stringify({ t: Date.now(), ...obj }) + '\n');
}

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function listSessions() {
  ensure();
  return fs.readdirSync(SESSIONS)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ id: f.slice(0, -6), mtime: mtime(path.join(SESSIONS, f)) }))
    .sort((a, b) => b.mtime - a.mtime);
}

function readEvents(sid) {
  let text = '';
  try { text = fs.readFileSync(logFile(sid), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

module.exports = {
  ROOT, SESSIONS, ensure, logFile, controlFile, metaFile, mtime,
  readControl, writeControl, clearControl, readMeta, writeMeta,
  append, listSessions, readEvents,
};
