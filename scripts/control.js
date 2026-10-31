#!/usr/bin/env node
// Usage: node control.js pause|resume|cancel [session_id]
const P = require('./lib/paths');

const [action, sidArg] = process.argv.slice(2);
if (!['pause', 'resume', 'cancel'].includes(action)) {
  console.error('Usage: node control.js pause|resume|cancel [session_id]');
  process.exit(1);
}
const sid = sidArg || (P.listSessions()[0] || {}).id;
if (!sid) {
  console.error('No recorded sessions yet.');
  process.exit(1);
}
if (action === 'resume') P.clearControl(sid);
else P.writeControl(sid, { action, t: Date.now() });
console.log(`${action} → session ${sid}`);
