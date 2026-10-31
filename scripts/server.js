#!/usr/bin/env node
// Local dashboard: http://localhost:4777 (AGENT_MONITOR_PORT to change). Live over SSE.
const fs = require('fs');
const http = require('http');
const path = require('path');
const P = require('./lib/paths');
const { compute } = require('./lib/state');

const PORT = Number(process.env.AGENT_MONITOR_PORT) || 4777;
const HTML = path.join(__dirname, 'dashboard.html');
const clients = new Set();

const latest = () => (P.listSessions()[0] || {}).id || null;
const sig = (sid) => sid ? [sid, P.mtime(P.logFile(sid)), P.mtime(P.controlFile(sid)), P.mtime(P.metaFile(sid))].join(':') : 'none';

function sessions() {
  return P.listSessions().slice(0, 25).map(({ id, mtime }) => {
    const s = compute(id);
    return { id, mtime, model: s.model, project: s.project, prompt: s.prompt, status: s.status };
  });
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams.get('session');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return fs.createReadStream(HTML).pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/api/sessions') return json(res, 200, sessions());
  if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, compute(q || latest()));
  if (req.method === 'GET' && url.pathname === '/api/log') {
    const sid = q || latest();
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(sid && fs.existsSync(P.logFile(sid)) ? fs.readFileSync(P.logFile(sid)) : '');
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 1500\n\n');
    const c = { res, session: q || null, sig: null };
    clients.add(c);
    req.on('close', () => clients.delete(c));
    return push(c);
  }
  if (req.method === 'POST' && url.pathname === '/api/control') {
    // Requiring JSON forces a CORS preflight, so other websites can't press the buttons.
    if (!/application\/json/.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'json only' });
    const { session, action } = await readBody(req);
    const sid = session || latest();
    if (!sid || !['pause', 'resume', 'cancel'].includes(action)) return json(res, 400, { error: 'bad request' });
    if (action === 'resume') P.clearControl(sid); else P.writeControl(sid, { action, t: Date.now() });
    for (const c of clients) c.sig = null;
    return json(res, 200, { ok: true, session: sid, action });
  }
  res.writeHead(404); res.end('not found');
});

function push(c) {
  const sid = c.session || latest();
  const s = sig(sid);
  if (s === c.sig) return;
  c.sig = s;
  c.res.write(`event: state\ndata: ${JSON.stringify(compute(sid))}\n\n`);
}

setInterval(() => { for (const c of clients) { try { push(c); } catch {} } }, 300);
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 15000);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} is busy — the dashboard is probably already running at http://localhost:${PORT}`);
    process.exit(0);
  }
  throw e;
});
P.ensure();
server.listen(PORT, '127.0.0.1', () => console.log(`Agent Monitor → http://localhost:${PORT}`));
