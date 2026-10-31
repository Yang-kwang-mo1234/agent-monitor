#!/usr/bin/env node
// Adds (or removes) the Agent Monitor hooks and status line in Claude Code settings.
//   node install.js              user-wide  (~/.claude/settings.json)
//   node install.js --project    this project (./.claude/settings.json)
//   node install.js --uninstall  remove (combine with --project if needed)
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const project = args.includes('--project');
const uninstall = args.includes('--uninstall');
const settingsPath = project
  ? path.join(process.cwd(), '.claude', 'settings.json')
  : path.join(os.homedir(), '.claude', 'settings.json');

const HOOK = path.join(__dirname, 'hook.js');
const STATUS = path.join(__dirname, 'statusline.js');
const hookCmd = `node ${JSON.stringify(HOOK)}`;
const isOurs = (cmd) => typeof cmd === 'string' && /agent-monitor/.test(cmd) && /(hook|statusline)\.js/.test(cmd);

let settings = {};
if (fs.existsSync(settingsPath)) {
  const text = fs.readFileSync(settingsPath, 'utf8');
  try { settings = text.trim() ? JSON.parse(text) : {}; } catch (e) {
    console.error(`Could not parse ${settingsPath}: ${e.message}\nFix the JSON and run again; nothing was changed.`);
    process.exit(1);
  }
  fs.writeFileSync(settingsPath + '.agent-monitor.bak', text);
}

// 1. Remove any earlier Agent Monitor hooks.
const hooks = settings.hooks || {};
for (const ev of Object.keys(hooks)) {
  if (!Array.isArray(hooks[ev])) continue;
  hooks[ev] = hooks[ev]
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h.command)) }))
    .filter((g) => g.hooks.length);
  if (!hooks[ev].length) delete hooks[ev];
}

// 2. Unwrap our status line, restoring the user's own one if we wrapped it.
let userStatus = settings.statusLine;
if (userStatus && isOurs(userStatus.command)) {
  const m = userStatus.command.match(/--wrap\s+"?([A-Za-z0-9+/=]+)"?/);
  userStatus = null;
  if (m) { try { userStatus = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')); } catch {} }
}

const notes = [];
if (uninstall) {
  if (userStatus) settings.statusLine = userStatus; else delete settings.statusLine;
} else {
  const add = (ev, entry) => { (hooks[ev] = hooks[ev] || []).push(entry); };
  const cmd = (timeout) => ({ type: 'command', command: hookCmd, timeout });
  add('PreToolUse', { matcher: '*', hooks: [cmd(3600)] }); // long timeout so Pause can hold
  add('PostToolUse', { matcher: '*', hooks: [cmd(10)] });
  add('PostToolUseFailure', { matcher: '*', hooks: [cmd(10)] });
  for (const ev of ['UserPromptSubmit', 'Stop', 'Notification', 'SessionStart', 'SessionEnd']) add(ev, { hooks: [cmd(10)] });

  let statusCmd = `node ${JSON.stringify(STATUS)}`;
  if (userStatus && userStatus.command) {
    const wrap = Buffer.from(JSON.stringify(userStatus)).toString('base64');
    statusCmd += ` --wrap ${wrap}`;
    notes.push('Your existing status line is kept: the monitor runs it and shows its output, and records cost on the side.');
  }
  settings.statusLine = { type: 'command', command: statusCmd, padding: (userStatus && userStatus.padding) || 0 };
}

if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

console.log(`${uninstall ? 'Removed Agent Monitor from' : 'Installed Agent Monitor into'} ${settingsPath}`);
if (fs.existsSync(settingsPath + '.agent-monitor.bak')) console.log(`Backup: ${settingsPath}.agent-monitor.bak`);
for (const n of notes) console.log(n);
if (!uninstall) console.log('Hooks apply to new Claude Code sessions. Dashboard: node ' + JSON.stringify(path.join(__dirname, 'server.js')));
