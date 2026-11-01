import { atom, read, update } from 'claude-code'
import type { AgentStatus, EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import type {
  AgentRow,
  Billing,
  Branch,
  Budget,
  CacheTtl,
  DayTotal,
  GraftUpdate,
  Handoff,
  PlanItem,
  RateLimit,
  Reading,
  Release,
  Route,
  Run,
  RunStatus,
  SelfUpdate,
  Span,
  Step,
  Today,
} from '../types'
import {
  GLYPH,
  HISTORY,
  NO_CACHE,
  SPLIT,
  addUsage,
  cacheLine,
  cells,
  forecast,
  legend,
  nextChangeIn,
  share,
  sparkline,
  tokens,
  toReading,
  trend,
  ttlFromTranscript,
} from './meters'
import {
  LADDERS,
  PICKER_NAME,
  PICK_URL,
  PRICES_AS_OF,
  addUsage as addRunUsage,
  costOf,
  parsePick,
  pickRequest,
  tierOf,
  usd as usdShort,
} from './route'
import type { Ladder, Style, Via } from './route'
import {
  OPEN_SH,
  TAILS_SH,
  baseName,
  blocks,
  clean,
  outputPathOf,
  parseOpen,
  program,
  shellLabel,
  tailLines,
} from './watch'
import {
  findingsOf,
  findingsText,
  isCodexReview,
  isReviewAgent,
  labelOf,
  modelOf,
  outputOf,
} from './review'
import {
  NO_TOOLS,
  addCall,
  apiErrorText,
  asksPerson,
  billingOf,
  billingText,
  errorLine,
  isAtLeast,
  isSet,
  levelOf,
  slowest,
} from './spend'
import type { BillingSetting } from './spend'

const PANE = 'agent-monitor'
const TITLE = 'Agent Monitor'

const IDLE: Run = {
  status: 'idle',
  prompt: '',
  startedAt: 0,
  costAtStart: 0,
  cost: 0,
  isPauseRequested: false,
  steps: [],
  plan: [],
}
// Change the tag when Run's fields change: it declines what an earlier
// version stored, which outlives a reload.
const run = atom({ plugin: 'agent-monitor-pane', key: 'run' } as const, IDLE, {
  shape: 'run-3',
})
const now = atom({ plugin: 'agent-monitor-pane', key: 'now' } as const, 0, {
  shape: 'now-1',
})
const limits = atom(
  { plugin: 'agent-monitor-pane', key: 'limits' } as const,
  [] as RateLimit[],
  { shape: 'limits-1' },
)
const reading = atom(
  { plugin: 'agent-monitor-pane', key: 'reading' } as const,
  null as Reading | null,
  { shape: 'reading-1' },
)
// Tokens in context after each main-thread turn, for token-weather's sparkline.
const history = atom(
  { plugin: 'agent-monitor-pane', key: 'history' } as const,
  [] as number[],
  { shape: 'history-1' },
)
const cache = atom(
  { plugin: 'agent-monitor-pane', key: 'cache' } as const,
  NO_CACHE,
  { shape: 'cache-1' },
)
// The cache lifetime the responses last wrote with; 5m until one shows 1h.
const ttl = atom(
  { plugin: 'agent-monitor-pane', key: 'ttl' } as const,
  '5m' as CacheTtl,
  { shape: 'ttl-1' },
)
const handoff = atom(
  { plugin: 'agent-monitor-pane', key: 'handoff' } as const,
  { isAuto: true } as Handoff,
  { shape: 'handoff-1' },
)

// agent-radar + switchboard: one row per subagent or background shell.
const agents = atom(
  { plugin: 'agent-monitor-pane', key: 'agents' } as const,
  [] as AgentRow[],
  { shape: 'agents-3' },
)
const selected = atom(
  { plugin: 'agent-monitor-pane', key: 'selected' } as const,
  null as string | null,
  { shape: 'selected-1' },
)

// How the session is billed, read once at session start.
const billing = atom(
  { plugin: 'agent-monitor-pane', key: 'billing' } as const,
  { mode: 'unknown', source: 'none' } as Billing,
  { shape: 'billing-1' },
)
const budget = atom(
  { plugin: 'agent-monitor-pane', key: 'budget' } as const,
  { level: 'ok', spent: 0, isOverridden: false } as Budget,
  { shape: 'budget-1' },
)
// Every tool call of the session, the main thread's and the subagents'.
const tools = atom(
  { plugin: 'agent-monitor-pane', key: 'tools' } as const,
  NO_TOOLS,
  { shape: 'tools-1' },
)

// The Update button's last run, kept so the result stays after a redraw.
const selfUpdate = atom(
  { plugin: 'agent-monitor-pane', key: 'selfUpdate' } as const,
  { status: 'idle' } as SelfUpdate,
  { shape: 'selfUpdate-1' },
)
// A login shell, so `claude` is found where the person's own PATH puts it.
const UPDATE_SH =
  'claude plugin marketplace update agent-monitor && claude plugin update agent-monitor-pane@agent-monitor'

// This pane's version and the marketplace's newest, so Update is live only
// when there is something to pull.
const release = atom(
  { plugin: 'agent-monitor-pane', key: 'release' } as const,
  {} as Release,
  { shape: 'release-1' },
)
// The marketplace's own clone, fetched with the person's git credentials, so
// a private repository reads as well as a public one.
const LATEST_SH =
  'm=~/.claude/plugins/marketplaces/agent-monitor && git -C "$m" fetch -q origin main && git -C "$m" show FETCH_HEAD:pane/.claude-plugin/plugin.json'
const RELEASE_CHECK_MS = 30 * 60_000

const versionOf = (json: string) => {
  try {
    const v: unknown = JSON.parse(json).version
    return typeof v === 'string' ? v : undefined
  } catch {
    return undefined
  }
}

// True when `a` is a newer dotted version than `b`.
const isNewer = (a: string, b: string) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

async function checkRelease($: EngineInterface) {
  const installed = versionOf(
    await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`).catch(() => ''),
  )
  const res = await $.process
    .run(['/bin/zsh', '-lc', LATEST_SH], { timeoutMs: 60_000 })
    .catch(() => undefined)
  const latest = res?.exitCode === 0 ? versionOf(res.stdout) : undefined
  const cur = await read($, release)
  const next: Release = { installed, latest: latest ?? cur.latest }
  if (JSON.stringify(cur) !== JSON.stringify(next)) await update($, release, () => next)
}

const canUpdate = (r: Release, su: SelfUpdate) =>
  su.status !== 'running' &&
  su.status !== 'done' &&
  r.installed !== undefined &&
  r.latest !== undefined &&
  isNewer(r.latest, r.installed)

async function updatePane($: EngineInterface) {
  if (!canUpdate(await read($, release), await read($, selfUpdate))) return
  await update($, selfUpdate, (): SelfUpdate => ({ status: 'running' }))
  const res = await $.process
    .run(['/bin/zsh', '-lc', UPDATE_SH], { timeoutMs: 180_000 })
    .catch((err: unknown) => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  const lastLine = (text: string) =>
    text.split('\n').map(l => l.trim()).filter(Boolean).at(-1) ?? ''
  await update($, selfUpdate, (): SelfUpdate =>
    res.exitCode === 0
      ? { status: 'done', message: lastLine(res.stdout) }
      : { status: 'failed', message: lastLine(res.stderr) || lastLine(res.stdout) },
  )
}

const branch = atom(
  { plugin: 'agent-monitor-pane', key: 'branch' } as const,
  null as Branch | null,
  { shape: 'branch-2' },
)

const today = atom(
  { plugin: 'agent-monitor-pane', key: 'today' } as const,
  { date: '', all: [], mine: [], sessions: 0, week: [], todayUsd: 0 } as Today,
  { shape: 'today-3' },
)

// Auto handoff fires once the context window reaches HANDOFF_AT, and arms
// again only after the fill drops under REARM_AT.
const HANDOFF_AT = 80
const REARM_AT = 50

const handoffPrompt = (percent: number | undefined) =>
  [
    `The context window is at ${percent ?? '?'}%. Hand off this work now.`,
    'Finish or safely stop the current step, then write or update HANDOFF.md with:',
    'the goal, what is done, what is left (as next steps), key decisions and why,',
    'and anything unverified.',
    'If a tool for moving the task into a new session is available',
    '(such as hand_off_to_session), use it with the remaining plan.',
    'Otherwise tell the user to continue in a new session from HANDOFF.md.',
  ].join(' ')

async function requestHandoff($: EngineInterface, percent: number | undefined) {
  const t = await $.clock.now()
  await update($, handoff, (h): Handoff => ({
    ...h,
    requestedAt: t,
    requestedPercent: percent,
  }))
  // Not awaited: the prompt waits for the session to go idle, and a hook
  // holding it would hold the measurement or press that asked.
  void $.prompt.submit({ text: handoffPrompt(percent) }).catch(() => {})
}

// context-bar: /context's breakdown, estimated locally (no token-count calls).
async function refreshContext($: EngineInterface) {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const b = usage.context.breakdown
  if (!b || !(b.rawMaxTokens > 0)) return
  const pct = await $.env.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE').catch(() => undefined)
  await update($, reading, () => toReading(b, pct ? parseFloat(pct) : undefined))
}

// token-weather: one point of the sparkline per main-thread turn.
async function recordTurn($: EngineInterface) {
  const { context } = await $.session.usage()
  if (!context.window) return
  const used = context.tokens ?? 0
  await update($, history, h => [...h, used].slice(-HISTORY))
}

// --- cache countdown ------------------------------------------------------

// The countdown's redraw timer, one at a time; a reload starts it over.
let cacheTick: Timer | undefined

// Redraws the pane when the cache line's text next changes, until it reads cold.
async function armCache($: EngineInterface) {
  cacheTick?.cancel()
  cacheTick = undefined
  const wait = nextChangeIn(await read($, cache), await read($, ttl), await $.clock.now())
  if (wait === undefined) return
  cacheTick = $.clock.after(wait, () => {
    $.ui.invalidate('ui.render')
    void armCache($).catch(() => {})
  })
}

// The end of this session's transcript, where the last response is; '' when
// it cannot be found or read. <config>/projects/<root, dashed>/<session>.jsonl
const TAIL_BYTES = 1024 * 1024
async function readTail($: EngineInterface) {
  try {
    const home = await $.env.get('HOME')
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home ? `${home}/.claude` : undefined)
    if (!configDir) return ''
    const project = (await $.session.root()).replace(/[^a-zA-Z0-9]/g, '-')
    const path = `${configDir}/projects/${project}/${await $.session.id()}.jsonl`
    const { size } = await $.fs.stat(path)
    if (size <= TAIL_BYTES) return await $.fs.read(path)
    const { exitCode, stdout } = await $.process.run(['tail', '-c', String(TAIL_BYTES), path])
    return exitCode === 0 ? stdout : ''
  } catch {
    return ''
  }
}

// Keeps the lifetime the last response wrote with, here and for the next session.
async function detectTtl($: EngineInterface) {
  const found = ttlFromTranscript(await readTail($))
  if (found === null || found === (await read($, ttl))) return
  await update($, ttl, () => found)
  await $.store.set('ttl', found).catch(() => {})
  await armCache($)
}

// The main loop's permission mode as of the last prompt.
let permissionMode: string | undefined


// --- spend and budget -----------------------------------------------------

async function detectBilling($: EngineInterface, setting: BillingSetting) {
  const got = (v: Promise<string | undefined>) => v.then(x => (x ?? '').trim()).catch(() => '')
  const cloud = await Promise.all([
    got($.env.get('CLAUDE_CODE_USE_BEDROCK')),
    got($.env.get('CLAUDE_CODE_USE_VERTEX')),
    got($.env.get('CLAUDE_CODE_USE_FOUNDRY')),
  ])
  const isCloud = cloud.some(isSet)
  const hasKey = (await got($.env.get('ANTHROPIC_API_KEY'))) !== '' || (await got($.env.get('ANTHROPIC_AUTH_TOKEN'))) !== ''
  // A login shell, so `claude` is found where the person's own PATH puts it.
  const res =
    setting === 'auto' && !isCloud
      ? await $.process.run(['/bin/zsh', '-lc', 'claude auth status'], { timeoutMs: 15_000 }).catch(() => undefined)
      : undefined
  const next = billingOf(setting, res?.exitCode === 0 ? res.stdout : undefined, { isCloud, hasKey })
  const cur = await read($, billing)
  if (JSON.stringify(cur) !== JSON.stringify(next)) await update($, billing, () => next)
}

const LEVEL_TOAST = {
  warn: (spent: string, limit: string) => `Budget 80%: ${spent} of ${limit} spent.`,
  degrade: (spent: string, limit: string, enforce: boolean) =>
    enforce ? `Budget 90% (${spent} of ${limit}): new subagents run on the cheapest model.` : `Budget 90%: ${spent} of ${limit} spent.`,
  block: (spent: string, limit: string, enforce: boolean) =>
    enforce ? `Budget ${limit} reached: the next tool call asks first.` : `Budget ${limit} reached: ${spent} spent.`,
} as const

// The session's cost against the budget; a toast each time it climbs a step.
async function refreshBudget($: EngineInterface, limit: number, enforce: boolean) {
  const spent = (await $.session.usage()).cost?.usd
  if (spent === undefined) return
  const cur = await read($, budget)
  const level = levelOf(spent, limit)
  if (level === cur.level && Math.abs(spent - cur.spent) < 0.0005) return
  await update($, budget, (b): Budget => ({ ...b, level, spent }))
  if (level !== 'ok' && !isAtLeast(cur.level, level)) {
    $.ui.toast(LEVEL_TOAST[level](usdShort(spent), usdShort(limit), enforce))
  }
}

// One question at a time, however many calls wait on it.
let budgetAsk: Promise<boolean> | undefined

// True when the call may run: under the budget, past it by the person's Continue,
// or not enforced. Without anyone to ask, it stops.
async function budgetGate($: EngineInterface, limit: number, enforce: boolean) {
  if (!enforce) return true
  const b = await read($, budget)
  if (b.level !== 'block' || b.isOverridden) return true
  budgetAsk ??= (async () => {
    const answer = await $.ui
      .ask(`Agent Monitor: the ${usdShort(limit)} budget is spent (${usdShort(b.spent)}). Keep going?`, {
        header: 'Budget',
        options: ['Continue', 'Stop'],
      })
      .catch(() => 'Stop')
    const go = answer === 'Continue'
    if (go) await update($, budget, (x): Budget => ({ ...x, isOverridden: true }))
    return go
  })().finally(() => {
    budgetAsk = undefined
  })
  return budgetAsk
}

const BUDGET_DENY = 'Stopped by Agent Monitor: the session budget is spent.'

// --- labels ---------------------------

const BRANDS: Record<string, string> = {
  github: 'GitHub',
  notion: 'Notion',
  slack: 'Slack',
  linear: 'Linear',
  figma: 'Figma',
  vercel: 'Vercel',
  sentry: 'Sentry',
  atlassian: 'Jira',
  jira: 'Jira',
}

const base = (p: unknown) =>
  p ? String(p).split(/[\\/]/).filter(Boolean).pop() ?? '' : ''
const trim = (s: unknown, n = 60) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}
const humanize = (s: string) => {
  const t = s
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase()
  return t.charAt(0).toUpperCase() + t.slice(1)
}
const host = (u: unknown) => {
  try {
    return new URL(String(u)).host.replace(/^www\./, '')
  } catch {
    return trim(u, 30)
  }
}

function describe(tool: string, input: Record<string, unknown>) {
  if (tool.startsWith('mcp__')) {
    const [, server = '', ...rest] = tool.split('__')
    const hit = Object.keys(BRANDS).find(k => server.toLowerCase().includes(k))
    const name = (hit && BRANDS[hit]) || humanize(server.replace(/^claude[_-]?ai[_-]?/i, '')) || 'MCP'
    return { label: humanize(rest.join(' ')) || name, source: name }
  }
  switch (tool) {
    case 'Bash': {
      const cmd = String(input.command ?? '')
      const gh = /^\s*gh\s/.test(cmd)
      return {
        label: trim(input.description || cmd) || 'Running a command',
        source: gh ? 'GitHub' : 'Terminal',
      }
    }
    case 'Read':
      return { label: 'Reading ' + (base(input.file_path) || 'a file'), source: 'Files' }
    case 'Write':
      return { label: 'Writing ' + (base(input.file_path) || 'a file'), source: 'Files' }
    case 'Edit':
    case 'MultiEdit':
      return { label: 'Editing ' + (base(input.file_path) || 'a file'), source: 'Files' }
    case 'NotebookEdit':
      return { label: 'Editing ' + (base(input.notebook_path) || 'a notebook'), source: 'Files' }
    case 'Grep':
      return { label: `Searching for “${trim(input.pattern, 32)}”`, source: 'Search' }
    case 'Glob':
      return { label: 'Finding ' + trim(input.pattern, 40), source: 'Search' }
    case 'WebFetch':
      return { label: 'Reading ' + host(input.url), source: 'Web' }
    case 'WebSearch':
      return { label: `Searching the web for “${trim(input.query, 36)}”`, source: 'Web' }
    case 'Task':
    case 'Agent':
      return { label: trim(input.description) || 'Running a subagent', source: 'Subagent' }
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return { label: 'Updating the plan', source: 'Plan' }
    case 'Skill':
      return { label: `Using the ${input.skill ?? 'a'} skill`, source: 'Skill' }
    default:
      return { label: humanize(tool), source: tool }
  }
}

// --- progress ---------------------------------------------------------------

const PLAN_STATUSES = ['pending', 'in_progress', 'completed'] as const
const planStatus = (v: unknown): PlanItem['status'] =>
  PLAN_STATUSES.find(x => x === v) ?? 'pending'
const toItems = (list: unknown, text: string): PlanItem[] | undefined =>
  Array.isArray(list)
    ? list.map((x: Record<string, unknown>, i) => ({
        id: String(i + 1),
        content: String(x?.[text] ?? ''),
        status: planStatus(x?.status),
      }))
    : undefined

// The task list after a call to one of the plan tools; undefined for any other tool.
function nextPlan(tool: string, input: Record<string, unknown>, plan: PlanItem[]): PlanItem[] | undefined {
  if (tool === 'TodoWrite') return toItems(input.todos, 'content')
  if (tool === 'TaskCreate') {
    return [...plan, { id: String(plan.length + 1), content: String(input.subject ?? ''), status: 'pending' }]
  }
  if (tool === 'TaskUpdate') {
    const id = String(input.taskId ?? '')
    if (input.status === 'deleted') return plan.filter(p => p.id !== id)
    return plan.map(p => (p.id === id && input.status ? { ...p, status: planStatus(input.status) } : p))
  }
  if (!tool.endsWith('__update_plan')) return undefined
  const items = toItems(input.items, 'content')
  if (items) return items
  let next = plan
  if (input.advance === true) {
    const at = next.findIndex(p => p.status === 'in_progress')
    next = next.map((p, i) => (i === at ? { ...p, status: 'completed' } : p))
    const to = next.findIndex((p, i) => i > at && p.status === 'pending')
    next = next.map((p, i) => (i === to ? { ...p, status: 'in_progress' } : p))
  }
  const done = Array.isArray(input.done) ? input.done.map(Number) : []
  const start = Number(input.start)
  return next.map((p, i) =>
    done.includes(i + 1)
      ? { ...p, status: 'completed' }
      : i + 1 === start
        ? { ...p, status: 'in_progress' }
        : p,
  )
}

// The bottom-row bar: the share of the task list done, the open item pulsing each tick.
// Without a list, a block sweeps back and forth while the turn runs.
function progress(r: Run, t: number, cells: number) {
  const n = r.plan.length
  const isLive = r.status === 'running' || r.status === 'paused'
  const beat = Math.floor(t / 1000)
  if (n === 0) {
    if (!isLive) return { text: '█'.repeat(cells), label: r.status === 'finished' ? '100%' : '' }
    const span = 3
    const lap = (cells - span) * 2
    const at = lap > 0 ? beat % lap : 0
    const from = at <= cells - span ? at : lap - at
    return {
      text: '░'.repeat(from) + '█'.repeat(span) + '░'.repeat(Math.max(0, cells - from - span)),
      label: `${r.steps.length} steps`,
    }
  }
  const done = r.plan.filter(p => p.status === 'completed').length
  const half = r.plan.some(p => p.status === 'in_progress') ? 0.5 : 0
  const share = Math.min(1, (done + (isLive ? half : 0)) / n)
  const filled = Math.floor(share * cells)
  const isPulse = isLive && half > 0 && filled < cells
  return {
    text:
      '█'.repeat(filled) +
      (isPulse ? (beat % 2 === 0 ? '▓' : '▒') : '') +
      '░'.repeat(Math.max(0, cells - filled - (isPulse ? 1 : 0))),
    label: `${done}/${n} · ${Math.round(share * 100)}%`,
  }
}

// --- formatting -----------------------------------------------------------

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const secs = (ms: number) =>
  ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : clock(ms)
const usd = (n: number) => `$${Math.max(0, n).toFixed(3)}`

const LIMIT_NAMES: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  spend_limit: 'Spend limit',
}
// How long each window lasts, for the pace mark; a spend limit has none.
const LIMIT_SPAN_MS: Record<string, number> = {
  five_hour: 5 * 3_600_000,
  seven_day: 7 * 86_400_000,
}
const LIMIT_ORDER = ['five_hour', 'seven_day', 'spend_limit']
const limitColor = (pct: number) =>
  pct >= 90 ? 'error' : pct >= 70 ? 'warning' : 'success'
// The share of the window gone by, 0 to 1; undefined without a reset time or a known length.
const elapsed = (w: RateLimit, t: number) => {
  const span = LIMIT_SPAN_MS[w.kind]
  const at = w.resetsAt ? Date.parse(w.resetsAt) : NaN
  if (span === undefined || Number.isNaN(at)) return undefined
  return Math.min(1, Math.max(0, 1 - (at - t) / span))
}
// The bar as runs: used cells, the pace mark (where usage would be at an even rate), free cells.
const bar = (pct: number, pace: number | undefined, cells: number) => {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * cells)
  const mark = pace === undefined ? -1 : Math.min(cells - 1, Math.floor(pace * cells))
  const runs: { kind: 'used' | 'mark' | 'free'; text: string; isUsed: boolean }[] = []
  for (let i = 0; i < cells; i++) {
    const kind = i === mark ? 'mark' : i < filled ? 'used' : 'free'
    const last = runs.at(-1)
    if (last && last.kind === kind) last.text += kind === 'used' ? '█' : '░'
    else runs.push({ kind, text: kind === 'mark' ? '┃' : kind === 'used' ? '█' : '░', isUsed: i < filled })
  }
  return runs
}
const resetsIn = (iso: string | undefined, t: number) => {
  const at = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(at)) return ''
  const m = Math.max(0, Math.round((at - t) / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return d > 0 ? `${d}d${h}h` : h > 0 ? `${h}h${m % 60}m` : `${m}m`
}
const percentColor = (level: number) =>
  level >= 0.9 ? 'red' : level >= 0.7 ? 'yellow' : 'green'

const cells0 = (width: number) => Math.max(8, Math.min(24, width - 22))

const toLimits = (list: readonly RateLimit[]): RateLimit[] =>
  list
    .map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt }))
    .sort((a, b) => {
      const ia = LIMIT_ORDER.indexOf(a.kind)
      const ib = LIMIT_ORDER.indexOf(b.kind)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    })

const STATUS: Record<RunStatus, { text: string; color: string }> = {
  idle: { text: 'Idle', color: 'inactive' },
  running: { text: 'Running', color: 'suggestion' },
  paused: { text: 'Paused', color: 'warning' },
  finished: { text: 'Finished', color: 'success' },
  cancelled: { text: 'Cancelled', color: 'warning' },
  interrupted: { text: 'Interrupted', color: 'warning' },
  failed: { text: 'Failed', color: 'error' },
}

// --- agents (agent-radar + switchboard) -----------------------------------

const SHOW_DONE_MS = 30_000 // a finished row stays in the list this long
const AGENT_ROWS = 6
const AGENT_LIMIT = 40
const PICK_TIMEOUT_MS = 4_000 // the spawn waits this long for the picker at most
const MIN_CONFIDENCE = 0.5 // below this, a pick is shown but not applied
const MISSES_TO_FINISH = 2 // polls that find a shell's output file closed before it counts as over
const UNSEEN_MIN_MS = 15_000
const LSOF_RETRY_MS = 60_000
const MODEL_MAX = 24

type Settings = {
  mode: 'auto' | 'suggest'
  picker: 'off' | 'jev' | 'openai'
  ladder: Ladder
  style: Style
  respectNamed: boolean
  jev: string
  gateway: string
  openai: string
  zeroRetention: boolean
  billing: BillingSetting
  budgetUsd: number
  budgetEnforce: boolean
}
type Pick = { tier?: Route['picked']; by: Route['by']; confidence?: number; reason: string; pickerUsd?: number }
type Credential = { via: Via; key: string } | null

// The picker the settings chose, with its key: a key set in /config wins over the
// environment. A key alone never turns a picker on.
async function credential($: EngineInterface, s: Settings): Promise<Credential> {
  if (s.picker === 'openai') {
    const key = s.openai || ((await $.env.get('OPENAI_API_KEY').catch(() => undefined)) ?? '').trim()
    return key ? { via: 'openai', key } : null
  }
  if (s.picker !== 'jev') return null
  if (s.jev) return { via: 'typesafe', key: s.jev }
  if (s.gateway) return { via: 'gateway', key: s.gateway }
  const typesafe = ((await $.env.get('TYPESAFE_API_KEY').catch(() => undefined)) ?? '').trim()
  if (typesafe) return { via: 'typesafe', key: typesafe }
  const gateway = ((await $.env.get('AI_GATEWAY_API_KEY').catch(() => undefined)) ?? '').trim()
  return gateway ? { via: 'gateway', key: gateway } : null
}

// The picker when there is one and it answers in time; otherwise no pick. Only the
// subagent's type and short label go out, never its task text.
async function decide(
  $: EngineInterface,
  e: { subagentType: string; description: string },
  c: Credential,
  s: Settings,
): Promise<Pick> {
  if (!c) return { by: 'none', reason: s.picker === 'off' ? 'no picker' : `no ${s.picker === 'openai' ? 'OpenAI' : 'Jev'} key` }
  const name = PICKER_NAME[c.via]
  const timeout = $.clock.sleep(PICK_TIMEOUT_MS).then(() => null)
  const asked = $.http
    .fetch(PICK_URL[c.via], {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(pickRequest(e, c.via, { ladder: s.ladder, style: s.style, zeroRetention: s.zeroRetention })),
    })
    .then(res => (res.ok ? parsePick(res.text, c.via, LADDERS[s.ladder]) : null))
    .catch(() => null)
  const got = await Promise.race([asked, timeout])
  if (!got) return { by: 'none', reason: `${name} did not answer` }
  return {
    tier: got.tier,
    by: c.via === 'openai' ? 'openai' : 'jev',
    confidence: got.confidence,
    reason: `${name} picked ${got.tier}`,
    pickerUsd: got.costUsd,
  }
}

// The model the spawn would run on without a switch, when it can be known.
function baseline(e: { model?: string; parentModel: string; subagentType: string }) {
  if (e.model && e.model !== 'inherit') return e.model
  if (e.model === 'inherit' || e.subagentType === 'general-purpose') return e.parentModel
  return undefined
}

// "opus → sonnet", "sonnet (kept)", "opus · try sonnet"; '' with no pick.
function move(rt: Route, mode: Settings['mode']) {
  const from = rt.asked === undefined ? 'own model' : (tierOf(rt.asked) ?? rt.asked)
  if (!rt.picked) return ''
  if (rt.asked === undefined) return `own model · try ${rt.picked}`
  if (rt.applied) return `${from} → ${rt.picked}`
  if (tierOf(rt.asked) === rt.picked) return `${rt.picked} (kept)`
  return mode === 'suggest' ? `${from} · try ${rt.picked}` : `${from} (kept)`
}

// `claude-sonnet-5-5` -> `Sonnet 5.5`; anything else as it came, cut short.
function modelName(id: string): string {
  const parts = id.toLowerCase().replace(/\[.*\]$/, '').split(/[-.:@_/]/)
  const family = parts.find(p => ['fable', 'opus', 'sonnet', 'haiku'].includes(p))
  if (!family) {
    const last = id.split('/').at(-1) ?? id
    return last.length > MODEL_MAX ? `${last.slice(0, MODEL_MAX - 1)}…` : last
  }
  const from = Math.max(0, parts.indexOf('claude'))
  const start = parts.findIndex((p, i) => i >= from && /^\d{1,2}$/.test(p))
  const version: string[] = []
  for (let i = start; i >= 0 && i < parts.length && version.length < 2 && /^\d{1,2}$/.test(parts[i]!); i++) version.push(parts[i]!)
  const name = family[0]!.toUpperCase() + family.slice(1)
  return version.length ? `${name} ${version.join('.')}` : name
}

// What a subagent is doing, from one tool call. A Bash call names its program only.
function agentStep(e: Record<string, unknown>): string {
  const tool = String(e.tool)
  const s = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')
  const file = (p: string) => p.split('/').slice(-2).join('/')
  let line: string
  if (tool === 'Bash') line = `running ${s('description') || program(s('command'))}`
  else if (tool === 'Edit' || tool === 'Write') line = `editing ${file(s('file_path'))}`
  else if (tool === 'Read') line = `reading ${file(s('file_path'))}`
  else if (tool === 'Grep' || tool === 'Glob') line = `searching ${s('pattern').slice(0, 30)}`
  else if (tool.startsWith('mcp__')) line = `using ${tool.split('__').slice(1).join(' ')}`
  else line = `using ${tool}`
  return clean(line).replace(/\s+/g, ' ')
}

// Running, held, or between turns: not over yet.
const isLiveAgent = (a: AgentRow) => a.status === 'running' || a.status === 'waiting' || a.status === 'idle'
const isShown = (a: AgentRow, at: number) =>
  isLiveAgent(a) || (a.endedAt !== undefined && at - a.endedAt < SHOW_DONE_MS)
const AGENT_LOOK: Record<AgentRow['status'], { icon: string; color: string }> = {
  running: { icon: '●', color: 'yellow' },
  waiting: { icon: '◐', color: 'cyan' },
  idle: { icon: '○', color: 'inactive' },
  done: { icon: '✓', color: 'green' },
  failed: { icon: '✗', color: 'red' },
}
const agentIcon = (a: AgentRow) => AGENT_LOOK[a.status].icon
const agentColor = (a: AgentRow) => AGENT_LOOK[a.status].color

const RESULT_MAX = 4000
const TASK_MAX = 600
const oneLine = (s: string, n: number) => trim(clean(s), n)

// A subagent's own task list as a short bar, `2/4`, and the item it is on; undefined without one.
function agentPlan(a: AgentRow, cells: number) {
  const plan = a.plan ?? []
  if (plan.length === 0) return undefined
  const done = plan.filter(p => p.status === 'completed').length
  const filled = Math.round((done / plan.length) * cells)
  const current = plan.find(p => p.status === 'in_progress')?.content
  return {
    bar: '█'.repeat(filled) + '░'.repeat(cells - filled),
    label: `${done}/${plan.length}`,
    current: current ? oneLine(current, 48) : '',
  }
}

// Rows in tree order, each subagent under the one that spawned it, with its depth.
function agentTree(rows: readonly AgentRow[]) {
  const ids = new Set(rows.map(a => a.id))
  const kids = new Map<string, AgentRow[]>()
  for (const a of rows) {
    if (a.parentId && ids.has(a.parentId)) kids.set(a.parentId, [...(kids.get(a.parentId) ?? []), a])
  }
  const out: { row: AgentRow; depth: number }[] = []
  const walk = (a: AgentRow, depth: number) => {
    out.push({ row: a, depth })
    for (const k of kids.get(a.id) ?? []) walk(k, depth + 1)
  }
  for (const a of rows) if (!a.parentId || !ids.has(a.parentId)) walk(a, 0)
  return out
}

const usageText = (u: AgentRow['usage']) =>
  u
    ? `in ${tokens(u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)} · out ${tokens(u.output_tokens)} · cache read ${tokens(u.cache_read_input_tokens)}`
    : ''

// The engine's word for where a loop stands, as a row shows it; ended loops are
// left to their turn.complete.
const LIST_STATUS: Partial<Record<AgentStatus, AgentRow['status']>> = {
  pending: 'running',
  running: 'running',
  waiting: 'waiting',
  idle: 'idle',
}

// Moves each live subagent row between running, waiting and idle by the engine's list.
async function syncAgents($: EngineInterface) {
  const rows = await read($, agents)
  if (!rows.some(a => a.kind === 'agent' && isLiveAgent(a))) return
  const list = await $.agent.list().catch(() => undefined)
  if (!list) return
  const stand = new Map(list.map(x => [x.id, LIST_STATUS[x.status]]))
  const moved = (a: AgentRow) => {
    const s = a.kind === 'agent' && isLiveAgent(a) ? stand.get(a.id) : undefined
    return s !== undefined && s !== a.status ? s : undefined
  }
  if (!rows.some(a => moved(a) !== undefined)) return
  await update($, agents, all =>
    all.map((a): AgentRow => {
      const s = moved(a)
      return s ? { ...a, status: s } : a
    }),
  )
}
const agentElapsed = (a: AgentRow, at: number) => {
  const s = Math.max(0, Math.round(((a.endedAt ?? at) - a.startedAt) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

let isPolling = false // a slow lsof must not let two polls overlap
let lsofBin: string | null | undefined
let lsofRetryAt = 0
let hasProc: boolean | undefined

// Background shells: a row until their output file is no longer open.
async function pollShells($: EngineInterface) {
  if (isPolling) return
  isPolling = true
  try {
    const shells = (await read($, agents)).filter(a => a.kind === 'shell' && a.status === 'running' && a.out)
    if (shells.length === 0) return
    const open = await openFiles($, shells.map(a => a.out!))
    const tailOf = new Map<string, string>()
    const t = await $.process
      .run(['sh', '-c', TAILS_SH, 'sh', ...new Set(shells.map(a => a.out!))], { timeoutMs: 8_000 })
      .catch(() => null)
    if (t && t.exitCode === 0) for (const b of blocks(t.stdout)) tailOf.set(b.path, b.body)
    const at = await $.clock.now()
    const finished: string[] = []
    await update($, agents, all =>
      all.map((a): AgentRow => {
        if (a.kind !== 'shell' || a.status !== 'running' || !a.out) return a
        const lines = tailOf.has(a.out) ? tailLines(tailOf.get(a.out)!) : a.lines
        const last = lines?.at(-1) ?? a.last
        if (!open) return { ...a, lines, last }
        if (open.has(baseName(a.out))) return { ...a, lines, last, seen: true, misses: 0 }
        const misses = (a.misses ?? 0) + 1
        if (misses >= MISSES_TO_FINISH && (a.seen || at - a.startedAt >= UNSEEN_MIN_MS)) {
          finished.push(a.id)
          return { ...a, lines, last: last === 'running' ? 'finished' : last, misses, status: 'done', endedAt: at }
        }
        return { ...a, lines, last, misses }
      }),
    )
    for (const id of finished) {
      const one = (await read($, agents)).find(a => a.id === id)
      if (one?.review) await toastReview($, one, false)
      else if (one) $.ui.toast(`✓ ${one.description} done (${agentElapsed(one, at)})`)
    }
  } finally {
    isPolling = false
  }
}

// Which of these files some process holds open: lsof, else Linux's /proc; undefined
// when neither can say, so nothing is guessed done.
async function openFiles($: EngineInterface, files: string[]): Promise<Set<string> | undefined> {
  if (lsofBin === null && (await $.clock.now()) < lsofRetryAt) return procOpen($)
  for (const bin of lsofBin ? [lsofBin] : ['/usr/sbin/lsof', 'lsof']) {
    const res = await $.process.run([bin, '-Fn', '--', ...files], { timeoutMs: 8_000 }).catch(() => null)
    if (!res) continue
    lsofBin = bin
    return res.exitCode === 0 || res.exitCode === 1 ? parseOpen(res.stdout) : undefined
  }
  lsofBin = null
  lsofRetryAt = (await $.clock.now()) + LSOF_RETRY_MS
  return procOpen($)
}

async function procOpen($: EngineInterface): Promise<Set<string> | undefined> {
  if (hasProc === false) return undefined
  const res = await $.process.run(['sh', '-c', OPEN_SH], { timeoutMs: 8_000 }).catch(() => null)
  if (res?.exitCode === 2) hasProc = false
  return res && res.exitCode === 0 ? parseOpen(res.stdout) : undefined
}

// --- reviews (review-watch) -----------------------------------------------

// The model from ~/.codex/config.toml, for a review run without one on its command line.
async function codexConfigModel($: EngineInterface) {
  const res = await $.process
    .run(['sh', '-c', 'grep -E "^model *=" "$HOME/.codex/config.toml" | head -n 1'], { timeoutMs: 3_000 })
    .catch(() => null)
  return (res && /=\s*["']?([\w.:-]+)/.exec(res.stdout)?.[1]) || 'default'
}

// Codex's findings from the end of its output; undefined when the output says neither.
async function reviewFindings($: EngineInterface, file: string | undefined) {
  if (!file) return undefined
  const res = await $.process.run(['tail', '-c', '40000', '--', file], { timeoutMs: 5_000 }).catch(() => null)
  return res && res.exitCode === 0 ? findingsOf(res.stdout) : undefined
}

// Ends a codex review row once: its findings, then one toast.
async function finishReview($: EngineInterface, id: string, failed: boolean) {
  const at = await $.clock.now()
  let ended: AgentRow | undefined
  await update($, agents, list =>
    list.map(a =>
      a.id === id && a.status === 'running'
        ? (ended = { ...a, status: failed ? 'failed' : 'done', endedAt: at, last: failed ? 'stopped' : 'finished' })
        : a,
    ),
  )
  if (!ended?.review) return
  await toastReview($, ended, failed)
}

async function toastReview($: EngineInterface, row: AgentRow, failed: boolean) {
  const rv = row.review!
  const findings = failed ? undefined : await reviewFindings($, rv.out ?? row.out)
  if (findings) {
    await update($, agents, list =>
      list.map(a => (a.id === row.id && a.review ? { ...a, review: { ...a.review, findings } } : a)),
    )
  }
  const extra = findings ? ` · ${findingsText(findings)}` : ''
  $.ui.toast(
    `${failed ? '✗' : '✓'} codex review (${rv.model}) ${failed ? 'stopped' : 'done'} · ${agentElapsed(row, await $.clock.now())}${extra}`,
  )
}

// --- git branch band ------------------------------------------------------

const graftUpdate = atom(
  { plugin: 'agent-monitor-pane', key: 'graftUpdate' } as const,
  { status: 'idle' } as GraftUpdate,
  { shape: 'graftUpdate-1' },
)

// Whether the session's folder has a graphify graph yet: Init before, Update after.
const hasGraph = atom(
  { plugin: 'agent-monitor-pane', key: 'hasGraph' } as const,
  false,
  { shape: 'hasGraph-1' },
)

const GRAFT_LABEL = { init: 'Graft Init', update: 'Graft Update' } as const
const GRAFT_RUNNING = { init: 'Initializing…', update: 'Updating…' } as const

async function graphExists($: EngineInterface, cwd: string) {
  return $.fs.exists(`${cwd}/graphify-out/graph.json`).catch(() => false)
}

async function refreshGraph($: EngineInterface) {
  const yes = await graphExists($, await $.session.cwd())
  if ((await read($, hasGraph)) !== yes) await update($, hasGraph, () => yes)
}

// Without a graph, builds the code graph of the session's folder (`graphify update .`);
// with one, re-extracts the code changed since the last build. No LLM either way.
async function runGraft($: EngineInterface) {
  if ((await read($, graftUpdate)).status === 'running') return
  const cwd = await $.session.cwd()
  const mode = (await graphExists($, cwd)) ? 'update' : 'init'
  await update($, graftUpdate, (): GraftUpdate => ({ status: 'running', mode }))
  // A login shell, so `graphify` is found on the person's own PATH.
  const res = await $.process
    .run(['/bin/zsh', '-lc', mode === 'init' ? 'graphify update .' : 'graphify update'], {
      cwd,
      timeoutMs: 600_000,
    })
    .catch((err: unknown) => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  const lines = (text: string) => text.split('\n').map(l => l.trim()).filter(Boolean)
  const out = lines(res.stdout).filter(l => !l.startsWith('Tip:'))
  // graphify's own summary: "Rebuilt: N nodes, ..." or "No code-graph topology changes ...".
  const summary = out
    .filter(l => l.startsWith('[graphify watch]') && !l.includes('updated in'))
    .at(-1)
    ?.replace('[graphify watch] ', '')
  const next: GraftUpdate =
    res.exitCode === 0
      ? { status: 'done', mode, message: summary ?? out.at(-1) }
      : { status: 'failed', mode, message: lines(res.stderr).at(-1) ?? out.at(-1) }
  await update($, graftUpdate, () => next)
  await refreshGraph($).catch(() => {})
  $.ui.toast(
    next.status === 'done'
      ? `✓ ${GRAFT_LABEL[mode]}: ${next.message ?? 'graph updated'}`
      : `${GRAFT_LABEL[mode]} failed${next.message ? `: ${next.message}` : ''}`,
  )
}

// Cuts text to `max` cells, ending in "..." when it had to cut.
const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, Math.max(1, max - 3))}...`

// The repository's name: the last part of origin's URL, else the top folder's name.
async function repoName($: EngineInterface) {
  const git = (args: string[]) =>
    $.process
      .run(['git', ...args], { timeoutMs: 3_000 })
      .then(r => (r.exitCode === 0 ? r.stdout.trim() : ''))
      .catch(() => '')
  const [url, top] = await Promise.all([git(['remote', 'get-url', 'origin']), git(['rev-parse', '--show-toplevel'])])
  const tail = (s: string) => s.replace(/\/+$/, '').split(/[/:]/).pop() ?? ''
  return tail(url).replace(/\.git$/, '') || tail(top)
}

// The repository, branch, ahead/behind and changed files; null outside a repo.
async function refreshBranch($: EngineInterface) {
  const res = await $.process
    .run(['git', 'status', '--porcelain=v2', '--branch'], { timeoutMs: 3_000 })
    .catch(() => null)
  let next: Branch | null = null
  if (res && res.exitCode === 0) {
    let name = ''
    let oid = ''
    let ahead = 0
    let behind = 0
    let hasUpstream = false
    let changed = 0
    for (const line of res.stdout.split('\n')) {
      if (line.startsWith('# branch.head ')) name = line.slice(14).trim()
      else if (line.startsWith('# branch.oid ')) oid = line.slice(13).trim()
      else if (line.startsWith('# branch.upstream ')) hasUpstream = true
      else if (line.startsWith('# branch.ab ')) {
        const m = /\+(\d+) -(\d+)/.exec(line)
        if (m) {
          ahead = Number(m[1])
          behind = Number(m[2])
        }
      } else if (line && !line.startsWith('#')) changed++
    }
    if (name === '(detached)') name = `detached ${oid.slice(0, 7)}`
    if (name) next = { repo: await repoName($), name, ahead, behind, hasUpstream, changed }
  }
  const cur = await read($, branch)
  if (JSON.stringify(cur) !== JSON.stringify(next)) await update($, branch, () => next)
  if (next) await refreshGraph($).catch(() => {})
}

// --- today's work time ----------------------------------------------------

// Each session keeps its finished turns per local day as [start, end] spans under
// `worked:<date>:<session>`, and its running turn under `working:<session>`, in
// the cross-session store, so sessions side by side never write the same key.
// The total is the union of every session's spans: time two sessions worked at
// once counts once. A turn past midnight is split between the two days.
const WORKED = 'worked:'
const WORKING = 'working:'
const SPENT = 'spent:' // spent:<date>:<session>, the USD of that session's turns finished that day
const WEEK_DAYS = 7
const KEEP_DAYS = 30
const BEAT_MS = 15_000 // a running turn's heartbeat, so a crashed session's stops counting
const STALE_MS = 3 * BEAT_MS

const localDate = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// [start, end) cut at each local midnight.
function byDay(start: number, end: number) {
  const pieces: { date: string; span: Span }[] = []
  let at = start
  while (at < end) {
    const d = new Date(at)
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
    const stop = Math.min(end, midnight)
    pieces.push({ date: localDate(at), span: [at, stop] })
    at = stop
  }
  return pieces
}

// Sorted, with overlapping and touching spans joined.
function merge(spans: readonly Span[]): Span[] {
  const out: Span[] = []
  for (const [a, b] of [...spans].filter(([x, y]) => y > x).sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1)
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

const total = (spans: readonly Span[]) => merge(spans).reduce((n, [a, b]) => n + (b - a), 0)

const isSpans = (v: unknown): v is Span[] =>
  Array.isArray(v) && v.every(x => Array.isArray(x) && typeof x[0] === 'number' && typeof x[1] === 'number')

// Marks this session's turn as running, for the other sessions to count live.
async function startWorking($: EngineInterface, since: number) {
  await $.store.set(`${WORKING}${await $.session.id()}`, { since, beat: since })
}

async function beatWorking($: EngineInterface) {
  const key = `${WORKING}${await $.session.id()}`
  const w = (await $.store.get(key).catch(() => undefined)) as { since?: number } | undefined
  if (typeof w?.since === 'number') await $.store.set(key, { since: w.since, beat: await $.clock.now() })
}

// Keeps a finished turn's spans and clears the running mark.
async function addWorked($: EngineInterface, start: number, end: number) {
  const sid = await $.session.id()
  for (const { date, span } of byDay(start, end)) {
    const key = `${WORKED}${date}:${sid}`
    const had = await $.store.get(key).catch(() => undefined)
    await $.store.set(key, merge([...(isSpans(had) ? had : []), span]))
  }
  await $.store.delete(`${WORKING}${sid}`).catch(() => {})
}

// Adds a finished turn's cost to the day it ended on.
async function addSpent($: EngineInterface, end: number, usd: number) {
  if (!(usd > 0)) return
  const key = `${SPENT}${localDate(end)}:${await $.session.id()}`
  const had = await $.store.get(key).catch(() => undefined)
  await $.store.set(key, (typeof had === 'number' ? had : 0) + usd)
}

// Today's spans from every session: finished turns, and the turns other sessions
// are running now (up to their last heartbeat).
async function refreshToday($: EngineInterface) {
  const at = await $.clock.now()
  const date = localDate(at)
  const d = new Date(at)
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const clip = ([a, b]: Span): Span => [Math.max(a, dayStart), Math.min(b, at)]
  const sid = await $.session.id()
  const prefix = `${WORKED}${date}:`
  const all: Span[] = []
  let mine: Span[] = []
  const workers = new Set<string>()
  // The six days before today, for the trend.
  const days = Array.from({ length: WEEK_DAYS - 1 }, (_, i) => {
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (WEEK_DAYS - 1 - i))
    return localDate(day.getTime())
  })
  const past = new Map(days.map(x => [x, { spans: [] as Span[], usd: 0 }]))
  let todayUsd = 0
  for (const key of await $.store.keys()) {
    if (key.startsWith(SPENT)) {
      const day = key.slice(SPENT.length, SPENT.length + 10)
      const v = await $.store.get(key).catch(() => undefined)
      if (typeof v !== 'number') continue
      if (day === date) todayUsd += v
      else if (past.has(day)) past.get(day)!.usd += v
    } else if (key.startsWith(WORKED) && past.has(key.slice(WORKED.length, WORKED.length + 10))) {
      const spans = await $.store.get(key).catch(() => undefined)
      if (isSpans(spans)) past.get(key.slice(WORKED.length, WORKED.length + 10))!.spans.push(...spans)
    } else if (key.startsWith(prefix)) {
      const spans = await $.store.get(key).catch(() => undefined)
      if (!isSpans(spans) || spans.length === 0) continue
      const owner = key.slice(prefix.length)
      workers.add(owner)
      all.push(...spans)
      if (owner === sid) mine = spans
    } else if (key.startsWith(WORKING) && key !== `${WORKING}${sid}`) {
      const w = (await $.store.get(key).catch(() => undefined)) as { since?: number; beat?: number } | undefined
      if (typeof w?.since !== 'number' || typeof w.beat !== 'number') continue
      // A session that stopped without finishing counts up to its last heartbeat.
      all.push(clip([w.since, at - w.beat > STALE_MS ? w.beat : at]))
      workers.add(key.slice(WORKING.length))
    }
  }
  const week: DayTotal[] = days.map(x => ({ date: x, ms: total(past.get(x)!.spans), usd: past.get(x)!.usd }))
  const next: Today = { date, all: merge(all.map(clip)), mine: merge(mine), sessions: workers.size, week, todayUsd }
  const cur = await read($, today)
  if (JSON.stringify(cur) !== JSON.stringify(next)) await update($, today, () => next)
}

// Drops days older than a month, the old per-day totals, and running marks left
// by sessions that stopped, so the store stays small.
async function pruneWorked($: EngineInterface) {
  const at = await $.clock.now()
  const cutoff = localDate(at - KEEP_DAYS * 86_400_000)
  for (const key of await $.store.keys()) {
    if (key.startsWith(WORKED)) {
      const v = await $.store.get(key).catch(() => undefined)
      if (key.slice(WORKED.length, WORKED.length + 10) < cutoff || !isSpans(v)) {
        await $.store.delete(key).catch(() => {})
      }
    } else if (key.startsWith(SPENT)) {
      const v = await $.store.get(key).catch(() => undefined)
      if (key.slice(SPENT.length, SPENT.length + 10) < cutoff || typeof v !== 'number') {
        await $.store.delete(key).catch(() => {})
      }
    } else if (key.startsWith(WORKING)) {
      const w = (await $.store.get(key).catch(() => undefined)) as { beat?: number } | undefined
      if (typeof w?.beat !== 'number' || at - w.beat > 86_400_000) await $.store.delete(key).catch(() => {})
    }
  }
}

const hoursMinutes = (ms: number) => {
  const m = Math.floor(ms / 60_000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

// --- hooks ----------------------------------------------------------------

// Set when Cancel aborts the turn, so turn.complete reports Cancelled rather
// than Interrupted.
let isCancelling = false

async function cancel($: EngineInterface) {
  const r = await read($, run)
  if (r.turnId === undefined) return
  isCancelling = true
  await $.turn.abort({ turnId: r.turnId }).catch(() => {})
}

export const register: Register = (on, options) => {
  // The module's own variables: a reload starts them over.
  let ticker: { cancel: () => void } | undefined
  let agentTimers: Timer[] = []
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const settings: Settings = {
    mode: options.mode === 'suggest' ? 'suggest' : 'auto',
    picker: options.picker === 'jev' || options.picker === 'openai' ? options.picker : 'off',
    ladder: options.models === 'sonnet-opus-fable' ? 'sonnet-opus-fable' : 'haiku-sonnet-opus',
    style: options.style === 'quality' ? 'quality' : 'saver',
    respectNamed: options.respectNamed !== false,
    jev: text(options.jevApiKey),
    gateway: text(options.gatewayApiKey),
    openai: text(options.openaiApiKey),
    zeroRetention: options.gatewayZeroRetention === true,
    billing: options.billing === 'subscription' || options.billing === 'metered' ? options.billing : 'auto',
    budgetUsd: typeof options.budgetUsd === 'number' && options.budgetUsd > 0 ? options.budgetUsd : 0,
    budgetEnforce: options.budgetEnforce === true,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'monitor',
      description: 'Open the Agent Monitor pane',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    const usage = await $.session.usage()
    await update($, limits, () => toLimits(usage.rateLimits))
    const known = await $.store.get('ttl').catch(() => undefined)
    if (known === '5m' || known === '1h') await update($, ttl, () => known)
    await refreshContext($).catch(() => {})
    await armCache($).catch(() => {})
    void checkRelease($).catch(() => {})
    void detectBilling($, settings.billing).catch(() => {})
    await refreshBudget($, settings.budgetUsd, settings.budgetEnforce).catch(() => {})
    for (const t of agentTimers) t.cancel()
    agentTimers = [
      // Elapsed times tick while a row shows, and a finished row leaves after 30 s.
      // A subagent's waiting or idle follows the engine's list.
      $.clock.every(1000, () => {
        void (async () => {
          await syncAgents($).catch(() => {})
          const at = await $.clock.now()
          if ((await read($, agents)).some(a => isShown(a, at - 3_000))) await update($, now, () => at)
        })().catch(() => {})
      }),
      $.clock.every(5_000, () => void pollShells($).catch(() => {})),
      $.clock.every(RELEASE_CHECK_MS, () => void checkRelease($).catch(() => {})),
      // A branch switched in a terminal shows within a few seconds.
      $.clock.every(5_000, () => void refreshBranch($).catch(() => {})),
      // Other sessions' turns, and a new day at midnight.
      $.clock.every(BEAT_MS, () => {
        void (async () => {
          const st = (await read($, run)).status
          if (st === 'running' || st === 'paused') await beatWorking($)
          await refreshToday($)
        })().catch(() => {})
      }),
    ]
    await pruneWorked($).catch(() => {})
    await refreshToday($).catch(() => {})
    await refreshBranch($).catch(() => {})

    return next(e)
  })

  // switchboard picks a model for a spawn that names none; agent-radar starts its row.
  on('agent.spawn', async ($, e, next) => {
    if (e.fork) return next(e) // a fork runs on its parent's model
    const asked = baseline(e)
    const named = settings.respectNamed && !!e.model && e.model !== 'inherit'
    // Past 90% of an enforced budget every new subagent runs on the cheapest model.
    const cheapest = LADDERS[settings.ladder][0]!
    const isDegraded =
      settings.budgetEnforce && isAtLeast((await read($, budget)).level, 'degrade') && tierOf(asked ?? '') !== cheapest
    const pick: Pick = isDegraded
      ? { tier: cheapest, by: 'none', reason: 'budget past 90%, cheapest model' }
      : named
        ? { by: 'none', reason: 'named by the caller, kept' }
        : await credential($, settings)
            .then(c => decide($, e, c, settings))
            .catch(() => ({ by: 'none' as const, reason: 'picker failed, kept' }))
    const sure = pick.confidence === undefined || pick.confidence >= MIN_CONFIDENCE
    const apply =
      isDegraded ||
      (settings.mode === 'auto' && sure && !!pick.tier && asked !== undefined && pick.tier !== tierOf(asked))
    const res = await next(apply ? { ...e, model: pick.tier } : e)
    if (res.deny !== undefined || !res.agentId) return res
    const id = res.agentId
    const row: AgentRow = {
      id,
      kind: 'agent',
      description: clean(e.description || e.subagentType),
      type: e.subagentType,
      status: 'running',
      startedAt: await $.clock.now(),
      tools: 0,
      last: 'starting',
      model: res.model,
      parentId: e.parentAgentId,
      task: trim(e.prompt, TASK_MAX),
      review: isReviewAgent(e.description ?? '')
        ? { model: e.model || res.model || 'inherit', label: e.description }
        : undefined,
      route: {
        asked,
        picked: pick.tier,
        by: pick.by,
        confidence: pick.confidence,
        reason: sure ? pick.reason : `${pick.reason}, too unsure to switch`,
        applied: apply,
        pickerUsd: pick.pickerUsd,
      },
    }
    await update($, agents, list => [row, ...list.filter(a => a.id !== id)].slice(0, AGENT_LIMIT))
    return res
  })

  // A background Bash command: a row until its output file is no longer open.
  // A codex review gets a row whether it runs in the foreground or the background.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const isReview = isCodexReview(e.command)
    const review = isReview
      ? {
          model: modelOf(e.command) ?? (await codexConfigModel($)),
          label: labelOf(e.command),
          out: outputOf(e.command, await $.session.cwd(), (await $.env.get('HOME').catch(() => undefined)) ?? ''),
        }
      : undefined
    const startedAt = await $.clock.now()
    const foregroundId = review && !e.run_in_background ? `codex-${startedAt}` : undefined
    if (foregroundId && review) {
      const row: AgentRow = {
        id: foregroundId,
        kind: 'shell',
        description: `codex review · ${review.label}`,
        type: 'codex review',
        status: 'running',
        startedAt,
        tools: 0,
        last: 'running',
        detail: 'codex review',
        review,
      }
      await update($, agents, list => [row, ...list].slice(0, AGENT_LIMIT))
    }

    const res = await next(e)
    const result = res.result as { backgroundTaskId?: string; backgroundOutputPath?: string } | undefined
    const isBackground = !res.deny && !res.isError && (e.run_in_background || !!result?.backgroundTaskId)
    if (foregroundId && !isBackground) {
      await finishReview($, foregroundId, Boolean(res.deny || res.isError))
      return res
    }
    if (!isBackground) return res
    const out = outputPathOf(res.text, result)
    if (!out) {
      if (foregroundId) await finishReview($, foregroundId, false) // no way to tell when it ends
      return res
    }
    const { label, detail } = shellLabel(e.command, e.description)
    const id = `sh:${baseName(out)}`
    const row: AgentRow = {
      id,
      kind: 'shell',
      description: review ? `codex review · ${review.label}` : label,
      type: review ? 'codex review' : 'shell',
      status: 'running',
      startedAt,
      tools: 0,
      last: 'running',
      detail,
      out,
      misses: 0,
      review,
    }
    await update($, agents, list =>
      [row, ...list.filter(a => a.id !== id && a.id !== foregroundId)].slice(0, AGENT_LIMIT),
    )
    return res
  })

  // The permission mode rides on each prompt's classic hook input.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (e.permission_mode) permissionMode = e.permission_mode
    return next(e)
  })

  // A main-thread call the check puts to the person: its step reads "asked for approval"
  // until it ends (approved and run, or refused).
  on('tool.check', async ($, e, next) => {
    const v = await next(e)
    const id = e.tool_use_id
    if (id !== undefined && e.agentId === undefined && asksPerson(v.decision, e.approver, permissionMode)) {
      const at = await $.clock.now()
      await update($, run, r =>
        r.steps.some(s => s.id === id && s.endedAt === undefined)
          ? { ...r, steps: r.steps.map(s => (s.id === id ? { ...s, askedAt: at } : s)) }
          : r,
      )
    }
    return v
  })

  // The kind of API error that ended the main thread's turn, for the run card.
  on('classic.StopFailure', async ($, e, next) => {
    if (e.agent_id === undefined) await update($, run, (r): Run => ({ ...r, apiError: e.error }))
    return next(e)
  })

  // A /compact empties the window without a turn ending.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && 'messages' in result) await refreshContext($).catch(() => {})
    return result
  })

  // A /clear leaves the old conversation, and its cache, behind.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      cacheTick?.cancel()
      cacheTick = undefined
      await update($, reading, () => null)
      await update($, history, () => [])
      await update($, cache, () => NO_CACHE)
    }
    return next(e)
  })

  // One model response. The cache's clock restarts when each one on the main
  // thread finishes, tool-loop responses inside a turn included.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (!e.agentId && result.stopReason !== null && result.usage) {
      const at = await $.clock.now()
      const usage = result.usage
      await update($, cache, c => addUsage(c, usage, at))
      await armCache($)
    }
    return result
  })

  // Pushed after each main-thread turn and whenever a window moves a point.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('cost')) await refreshBudget($, settings.budgetUsd, settings.budgetEnforce).catch(() => {})
    if (e.changed.includes('rateLimits')) {
      await update($, limits, () => toLimits(e.rateLimits))
    }
    if (e.changed.includes('context')) {
      const pct = e.context.percent
      await refreshContext($).catch(() => {})
      const h = await read($, handoff)
      if (pct !== undefined && h.requestedAt !== undefined && pct < REARM_AT) {
        await update($, handoff, (x): Handoff => ({ isAuto: x.isAuto }))
      } else if (
        pct !== undefined &&
        pct >= HANDOFF_AT &&
        h.isAuto &&
        h.requestedAt === undefined
      ) {
        await requestHandoff($, pct)
        $.ui.toast(`Context at ${pct}%: handoff requested.`)
      }
    }

    return next(e)
  })

  on('command.run', { command: 'monitor' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Agent Monitor pane opened.' }
  })

  on('turn.start', async ($, e, next) => {
    // A subagent woken by a message runs again under its row.
    if (e.agentId !== undefined) {
      const id = e.agentId
      if ((await read($, agents)).some(a => a.id === id && a.status !== 'running')) {
        await update($, agents, list =>
          list.map((a): AgentRow => (a.id === id ? { ...a, status: 'running', endedAt: undefined } : a)),
        )
      }
      return next(e)
    }
    if (e.text === '') return next(e)

    const t = await $.clock.now()
    const cost = (await $.session.usage()).cost?.usd ?? 0
    isCancelling = false
    await update($, run, (): Run => ({
      ...IDLE,
      status: 'running',
      prompt: trim(e.text, 120),
      turnId: e.turnId,
      startedAt: t,
      costAtStart: cost,
      cost,
    }))
    await update($, now, () => t)
    ticker?.cancel()
    ticker = $.clock.every(1000, () => {
      void $.clock.now().then(t2 => update($, now, () => t2))
    })
    await startWorking($, t).catch(() => {})

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const id = e.agentId
      const input = e as unknown as Record<string, unknown>
      const line = agentStep(input)
      if (!(await budgetGate($, settings.budgetUsd, settings.budgetEnforce))) return { deny: BUDGET_DENY }
      await update($, agents, list =>
        list.map(a => (a.id === id ? { ...a, tools: a.tools + 1, last: line } : a)),
      )
      const began = await $.clock.now()
      const ran = await next(e)
      const at = await $.clock.now()
      const failed = ran.deny !== undefined || ran.isError === true
      await update($, tools, log =>
        addCall(log, {
          tool: e.tool,
          ms: at - began,
          failure: failed ? { label: line, error: errorLine(ran), at, ms: at - began } : undefined,
        }),
      )
      if (failed) {
        await update($, agents, list => list.map(a => (a.id === id ? { ...a, fails: (a.fails ?? 0) + 1 } : a)))
      }
      // Its own task list, kept on its row like the main run's.
      if (ran.deny === undefined && ran.isError !== true && nextPlan(e.tool, input, []) !== undefined) {
        await update($, agents, list =>
          list.map(a => (a.id === id ? { ...a, plan: nextPlan(e.tool, input, a.plan ?? []) ?? a.plan } : a)),
        )
      }
      return ran
    }

    const current = await read($, run)
    if (current.isPauseRequested) {
      await update($, run, (r): Run => ({ ...r, status: 'paused' }))
      const answer = await $.ui
        .ask('Agent Monitor: paused before the next step. Continue?', {
          header: 'Paused',
          options: ['Resume', 'Cancel'],
        })
        .catch(() => 'Resume')
      await update($, run, (r): Run => ({
        ...r,
        status: 'running',
        isPauseRequested: false,
      }))
      if (answer === 'Cancel') {
        await cancel($)
        return { deny: 'Cancelled from Agent Monitor.' }
      }
    }
    if (!(await budgetGate($, settings.budgetUsd, settings.budgetEnforce))) {
      await cancel($)
      return { deny: BUDGET_DENY }
    }

    const { label, source } = describe(
      e.tool,
      e as unknown as Record<string, unknown>,
    )
    const step: Step = {
      id: e.tool_use_id,
      label,
      source,
      startedAt: await $.clock.now(),
    }
    await update($, run, r => ({ ...r, steps: [...r.steps, step].slice(-200) }))

    const ran = await next(e)

    const endedAt = await $.clock.now()
    const ok = ran.deny === undefined && ran.isError !== true
    const error = ok ? undefined : errorLine(ran)
    const cost = (await $.session.usage()).cost?.usd
    const ms = endedAt - step.startedAt
    await update($, tools, log =>
      addCall(log, { tool: e.tool, ms, failure: error ? { label, error, at: endedAt, ms } : undefined }),
    )
    await update($, run, r => ({
      ...r,
      cost: cost ?? r.cost,
      steps: r.steps.map(s => (s.id === step.id ? { ...s, endedAt, ok, error } : s)),
      plan: (ok && nextPlan(e.tool, e as unknown as Record<string, unknown>, r.plan)) || r.plan,
    }))
    await refreshBudget($, settings.budgetUsd, settings.budgetEnforce).catch(() => {})

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const res = await next(e)
      const id = e.agentId
      const failed = e.reason === 'error' || e.reason === 'aborted'
      const at = await $.clock.now()
      const answer = clean(res.text || e.answer || '').trim().slice(0, RESULT_MAX)
      const list = await update($, agents, all =>
        all.map((a): AgentRow => {
          if (a.id !== id) return a
          const turnUsage = res.usage ?? e.usage
          const usage = turnUsage ? addRunUsage(a.usage, turnUsage) : a.usage
          const rt = a.route
          const model = turnUsage?.model ?? a.model ?? (rt?.applied ? rt.picked : rt?.asked) ?? ''
          return {
            ...a,
            status: failed ? 'failed' : 'done',
            endedAt: at,
            last: failed ? `stopped: ${e.reason}` : 'finished',
            result: answer || a.result,
            model,
            usage,
            costUsd: usage ? costOf(model, usage) : a.costUsd,
            askedUsd: !usage
              ? a.askedUsd
              : rt?.applied && rt.asked
                ? costOf(rt.asked, usage)
                : costOf(model, usage),
          }
        }),
      )
      const one = list.find(a => a.id === id)
      if (one) {
        $.ui.toast(
          `${failed ? '✗' : '✓'} ${one.description} ${failed ? 'failed' : 'done'} (${agentElapsed(one, at)} · ${one.tools} tools)`,
        )
      }
      await refreshBudget($, settings.budgetUsd, settings.budgetEnforce).catch(() => {})
      return res
    }

    ticker?.cancel()
    ticker = undefined
    const endedAt = await $.clock.now()
    const cost = (await $.session.usage()).cost?.usd
    const status: RunStatus = isCancelling
      ? 'cancelled'
      : e.reason === 'aborted'
        ? 'interrupted'
        : e.reason === 'answer'
          ? 'finished'
          : 'failed'
    await update($, run, r =>
      r.turnId !== e.turnId
        ? r
        : {
            ...r,
            status,
            endedAt,
            cost: cost ?? r.cost,
            isPauseRequested: false,
            steps: r.steps.map(s =>
              s.endedAt === undefined ? { ...s, endedAt, ok: false } : s,
            ),
          },
    )
    await update($, now, () => endedAt)
    await addWorked($, endedAt - e.durationMs, endedAt).catch(() => {})
    const ran = await read($, run)
    if (ran.turnId === e.turnId) await addSpent($, endedAt, ran.cost - ran.costAtStart).catch(() => {})
    await refreshToday($).catch(() => {})
    await recordTurn($).catch(() => {})
    await refreshBranch($).catch(() => {})
    await refreshContext($).catch(() => {})
    await detectTtl($).catch(() => {})
    await refreshBudget($, settings.budgetUsd, settings.budgetEnforce).catch(() => {})

    return next(e)
  })

  // The branch, drawn above the prompt box where it is hard to miss, with
  // Graft Init (no graph yet) or Graft Update at its right end.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = await read($, branch)
    if (e.props.hasSurvey || !b) return next(e)
    const rest = await next(e)
    const gu = await read($, graftUpdate)
    const mode = (await read($, hasGraph)) ? 'update' : 'init'
    const { Box, Text, Button } = $.ui.resolve(e)
    const sync = b.hasUpstream
      ? b.ahead || b.behind
        ? `↑${b.ahead} ↓${b.behind}`
        : 'up to date'
      : 'no upstream'
    const state = b.changed ? `● ${b.changed} changed` : '✓ clean'
    const isRunning = gu.status === 'running'
    // The button keeps its place on this row: a long branch name is cut instead.
    // The terminal draws a primary Button as `[ label ]`.
    const running = GRAFT_RUNNING[gu.mode ?? mode]
    const buttonCells = isRunning ? running.length : GRAFT_LABEL[mode].length + 4
    const fixed =
      (b.repo !== '' ? b.repo.length + 1 : 0) + 4 + 1 + state.length + 1 + sync.length + 1 + buttonCells
    const name = clip(b.name, Math.max(4, e.props.bodyColumns - fixed))
    const mine = (
      <Box key="agent-monitor-branch" flexDirection="row" justifyContent="space-between" gap={1}>
        <Box flexDirection="row" gap={1} flexShrink={1}>
          {b.repo !== '' && <Text weight="bold" wrap="truncate-end">{b.repo}</Text>}
          <Text backgroundColor="#2f6feb" color="#ffffff" weight="bold" wrap="truncate-end">
            {` ⎇ ${name} `}
          </Text>
          <Text color={b.changed ? 'yellow' : 'green'} wrap="truncate-end">{state}</Text>
          <Text dimColor wrap="truncate-end">{sync}</Text>
        </Box>
        {isRunning ? (
          <Text dimColor>{running}</Text>
        ) : (
          <Button key={`graft-${mode}`} variant="primary" onPress={() => void runGraft($)}>
            {GRAFT_LABEL[mode]}
          </Button>
        )}
      </Box>
    )
    return (
      <Box flexDirection="column">
        {rest}
        {mine}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const r = await read($, run)
    const t = await read($, now)
    const model = await $.session.model()
    const isLive = r.status === 'running' || r.status === 'paused'
    const end = r.endedAt ?? t
    const status = STATUS[r.status]
    const open = r.steps.find(s => s.endedAt === undefined)
    const done = r.steps.filter(s => s.endedAt !== undefined)
    const recent = done.slice(-3).reverse()
    const width = Math.max(10, (e.props.bodyColumns ?? 40) - 2)
    const segs = r.steps.slice(-width)

    const togglePause = () =>
      void update($, run, x => ({ ...x, isPauseRequested: !x.isPauseRequested }))
    const cancelNow = () => void cancel($)

    const bill = await read($, billing)
    const rd = await read($, reading)
    const turns = await read($, history)
    const ho = await read($, handoff)
    const wall = await $.clock.now()
    const toggleAuto = () =>
      void update($, handoff, (x): Handoff => ({ ...x, isAuto: !x.isAuto }))
    const handoffNow = () => void requestHandoff($, rd?.percent)
    const weather = rd ? forecast(rd.percent) : undefined
    const level = rd ? (rd.compactsAt ? rd.total / rd.compactsAt : rd.total / rd.window) : 0
    const contextView = (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            <Text color="#d97757">{'◆ '}</Text>
            <Text weight="medium">Context</Text>
            {weather && (
              <Text color={weather.color}>{`  ${weather.icon} ${weather.word}`}</Text>
            )}
          </Text>
          {rd && (
            <Text mono weight="bold" color={percentColor(level)}>
              {`${rd.percent}%`}
            </Text>
          )}
        </Box>
        {!rd && <Text dimColor>No reading yet.</Text>}
        {rd && (
          <Text dimColor>
            {`${tokens(rd.total)} of ${tokens(rd.window)}${rd.compactsAt ? ` · compacts at ${tokens(rd.compactsAt)}` : ''}`}
          </Text>
        )}
        {rd && (
          <Text mono>
            {cells(rd, width).map(c => (
              <Text color={c.color}>{c.text}</Text>
            ))}
          </Text>
        )}
        {rd &&
          legend(rd, width).map(line => (
            <Text>
              {line.map((sl, i) => (
                <Text>
                  {i > 0 && <Text>{SPLIT}</Text>}
                  <Text color={sl.color}>
                    {sl.kind === 'used' ? '■ ' : `${GLYPH[sl.kind]} `}
                  </Text>
                  <Text dimColor={sl.kind !== 'used'}>{`${sl.name} `}</Text>
                  <Text weight={sl.kind === 'used' ? 'bold' : 'regular'}>
                    {tokens(sl.tokens)}
                  </Text>
                  {sl.kind === 'used' && (
                    <Text dimColor>{` ${share(sl.tokens, rd.window)}`}</Text>
                  )}
                </Text>
              ))}
            </Text>
          ))}
        {turns.length > 0 && (
          <Text>
            <Text dimColor>{'last turns '}</Text>
            <Text color={weather?.color}>{sparkline(turns)}</Text>
            <Text dimColor>{turns.length > 1 ? ` ${trend(turns)}` : ''}</Text>
          </Text>
        )}
        <Text dimColor>
          {ho.requestedAt !== undefined
            ? `Handoff requested at ${ho.requestedPercent ?? '?'}%`
            : ho.isAuto
              ? `Auto handoff at ${HANDOFF_AT}%`
              : 'Auto handoff off'}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button key="handoff" onPress={handoffNow}>
            Handoff now
          </Button>
          <Button key="auto-handoff" onPress={toggleAuto}>
            {ho.isAuto ? 'Auto: On' : 'Auto: Off'}
          </Button>
        </Box>
      </Box>
    )

    const line = cacheLine(await read($, cache), await read($, ttl), wall)
    const cacheView = (
      <Box flexDirection="column">
        <Text weight="medium">Prompt cache</Text>
        {!line && <Text dimColor>Starts after the first reply.</Text>}
        {line && (
          <Text>
            <Text color={line.color}>{line.head}</Text>
            {line.bar && (
              <Text mono>
                {'  '}
                <Text color={line.color}>{line.bar.filled}</Text>
                <Text dimColor>{line.bar.empty}</Text>
              </Text>
            )}
          </Text>
        )}
        {line && line.details.length > 0 && (
          <Text dimColor>{line.details.join(' · ')}</Text>
        )}
      </Box>
    )

    const rows = await read($, agents)
    const pick = await read($, selected)
    const shownRows = rows.filter(a => isShown(a, wall))
    const runningRows = rows.filter(isLiveAgent).length
    const spent = rows.reduce((n, a) => n + (a.costUsd ?? 0) + (a.route?.pickerUsd ?? 0), 0)
    const askedTotal = rows.reduce((n, a) => n + (a.askedUsd ?? 0), 0)
    const switched = rows.filter(a => a.route?.applied).length
    const opened = rows.find(a => a.id === pick)
    const openedMessages =
      opened && opened.kind === 'agent'
        ? await $.session
            .messages({ agentId: opened.id })
            .then(found => ('deny' in found ? [] : found.slice(-4)))
            .catch(() => [])
        : []
    const toggleRow = (id: string) => () =>
      void update($, selected, cur => (cur === id ? null : id))
    const clearFinished = () =>
      void update($, agents, all => all.filter(isLiveAgent))
    const agentsView =
      rows.length === 0 ? null : (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text weight="medium">Agents</Text>
            <Text dimColor>{`${runningRows} running · ${rows.length - runningRows} finished`}</Text>
          </Box>
          <Text dimColor>
            {`spent ${usdShort(spent)} · at asked models ${usdShort(askedTotal)}${switched ? ` · ${switched} switched` : ''} · picker ${settings.picker}`}
          </Text>
          {agentTree((shownRows.length > 0 ? shownRows : rows).slice(0, AGENT_ROWS)).map(({ row: a, depth }) => {
            const pad = '  '.repeat(depth)
            const routeText = a.route ? move(a.route, settings.mode) : ''
            const facts = [
              a.review ? 'review' : a.kind === 'agent' ? 'sub' : 'sh',
              a.review && a.kind === 'shell' ? a.review.model : '',
              a.review?.findings ? findingsText(a.review.findings) : '',
              routeText,
              a.kind === 'agent' ? `${a.tools} tools` : '',
              a.fails ? `${a.fails} failed` : '',
              a.kind === 'agent' && (a.status === 'done' || a.status === 'failed') ? usdShort(a.costUsd) : '',
              a.status === 'waiting' || a.status === 'idle' ? a.status : '',
              a.status !== 'done' ? a.last : '',
            ].filter(Boolean)
            const pl = agentPlan(a, Math.max(6, Math.min(12, width - 30)))
            const isOpen = opened?.id === a.id
            // Its report, unless the last message shown already says it.
            const said = (m: { role: string; text: string }) =>
              !!a.result && m.role === 'assistant' && oneLine(m.text, 300) === oneLine(a.result, 300)
            return (
              <Box key={a.id} flexDirection="column">
                <Button key={`agent-${a.id}`} plain onPress={toggleRow(a.id)}>
                  <Text color={agentColor(a)} weight="semibold">{`${pad}${depth > 0 ? '└ ' : ''}${agentIcon(a)} ${a.description}`}</Text>
                  <Text dimColor>{`${a.model ? ` (${modelName(a.model)})` : ''}  ${agentElapsed(a, wall)}`}</Text>
                </Button>
                <Text dimColor>{`${pad}  ${facts.join(' · ')}`}</Text>
                {pl && (
                  <Text mono>
                    {`${pad}  `}
                    <Text color={agentColor(a)}>{pl.bar}</Text>
                    <Text dimColor>{` ${pl.label}${pl.current ? ` · ${pl.current}` : ''}`}</Text>
                  </Text>
                )}
                {a.result && !isOpen && <Text dimColor>{`${pad}  ↳ ${oneLine(a.result, Math.max(20, width - 4 - pad.length))}`}</Text>}
                {isOpen && a.kind === 'shell' && (
                  <Box flexDirection="column">
                    <Text dimColor mono>{`  $ ${clean(a.detail ?? '')}`}</Text>
                    {(a.lines ?? []).length === 0 && <Text dimColor>{'  No output yet.'}</Text>}
                    {(a.lines ?? []).map(l => (
                      <Text mono>{`  ${l}`}</Text>
                    ))}
                  </Box>
                )}
                {isOpen && a.kind === 'agent' && (
                  <Box flexDirection="column">
                    {a.route && <Text dimColor>{`  ${a.type} · ${a.route.reason}`}</Text>}
                    {a.task && (
                      <Text>
                        <Text weight="semibold">{'  given: '}</Text>
                        <Text dimColor>{clean(a.task)}</Text>
                      </Text>
                    )}
                    {a.usage && <Text dimColor>{`  ${usageText(a.usage)}`}</Text>}
                    {openedMessages.length === 0 && !a.result && <Text dimColor>{'  No messages yet.'}</Text>}
                    {(a.plan ?? []).map(p => (
                      <Text dimColor={p.status === 'completed'}>
                        {`  ${p.status === 'completed' ? '✓' : p.status === 'in_progress' ? '▸' : '·'} ${oneLine(p.content, 80)}`}
                      </Text>
                    ))}
                    {openedMessages.filter(m => !said(m)).map(m => (
                      <Text>
                        <Text color={m.role === 'assistant' ? 'cyan' : undefined} weight="semibold">
                          {m.role === 'assistant' ? '  agent: ' : '  task:  '}
                        </Text>
                        <Text>{clean(m.text).replace(/\s+/g, ' ').slice(0, 300) || '(tool calls)'}</Text>
                      </Text>
                    ))}
                    {a.result && (
                      <Text>
                        <Text color={agentColor(a)} weight="semibold">{'  result: '}</Text>
                        <Text>{a.result}</Text>
                      </Text>
                    )}
                  </Box>
                )}
              </Box>
            )
          })}
          {rows.length > AGENT_ROWS && <Text dimColor>{`+${rows.length - AGENT_ROWS} more`}</Text>}
          <Box flexDirection="row" gap={1}>
            <Button key="clear-agents" onPress={clearFinished}>
              Clear finished
            </Button>
          </Box>
          <Text dimColor>{`Costs: API price estimates as of ${PRICES_AS_OF}, not plan charges.`}</Text>
        </Box>
      )

    const windows = await read($, limits)
    const bodyRows = e.props.scroll?.bodyRows ?? 0
    const limitCells = cells0(width)
    const day = await read($, today)
    // This session's running turn, live, clipped to today.
    const live: Span[] =
      r.status === 'running' || r.status === 'paused'
        ? byDay(r.startedAt, Math.max(r.startedAt, t))
            .filter(p => p.date === day.date)
            .map(p => p.span)
        : []
    const workedMs = total([...day.all, ...live])
    const mineMs = total([...day.mine, ...live])
    const others = day.sessions - (day.mine.length > 0 ? 1 : 0)
    // The six days before today, then today, live.
    const weekMs = [...day.week.map(x => x.ms), workedMs]
    const weekUsd = day.week.reduce((n, x) => n + x.usd, 0) + day.todayUsd + (isLive ? r.cost - r.costAtStart : 0)
    const su = await read($, selfUpdate)
    const rel = await read($, release)
    // The agent's progress at the bottom left; hidden before the first turn.
    const bottom = r.status === 'idle' ? undefined : progress(r, t, Math.max(6, Math.min(16, width - 34)))
    // Button takes no disabled state: with nothing to pull, a dim label stands in.
    const updateView = (
      <Box flexDirection="column">
        {su.status === 'done' && (
          <Box flexDirection="row" justifyContent="flex-end">
            <Text color="success">{`${su.message ? `${su.message} · ` : ''}Open a new session to apply.`}</Text>
          </Box>
        )}
        {su.status === 'failed' && (
          <Box flexDirection="row" justifyContent="flex-end">
            <Text color="error">{`Update failed${su.message ? `: ${su.message}` : ''}`}</Text>
          </Box>
        )}
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          {bottom ? (
            <Text mono>
              <Text color={status.color}>{bottom.text}</Text>
              {bottom.label !== '' && <Text dimColor>{` ${bottom.label}`}</Text>}
            </Text>
          ) : (
            <Text>{''}</Text>
          )}
          <Box flexDirection="row" gap={1}>
            <Text mono dimColor>
              {rel.installed ? `v${rel.installed}` : ''}
              {canUpdate(rel, su) && rel.latest ? ` → v${rel.latest}` : ''}
            </Text>
            {canUpdate(rel, su) ? (
              <Button key="self-update" variant="primary" onPress={() => void updatePane($)}>
                Update
              </Button>
            ) : (
              <Text dimColor>{su.status === 'running' ? 'Updating…' : 'Update'}</Text>
            )}
          </Box>
        </Box>
      </Box>
    )
    // The body fills the pane's height, so the progress bar sits at its bottom left and the version and Update at its bottom right.
    const page = (content: RenderChildren) => (
      <Box flexDirection="column" minHeight={bodyRows}>
        <Box flexDirection="column" gap={1} flexGrow={1}>
          {content}
        </Box>
        {updateView}
      </Box>
    )
    const todayView = (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text weight="medium">Worked today</Text>
          <Text mono weight="bold">
            {hoursMinutes(workedMs)}
          </Text>
        </Box>
        <Text dimColor>
          {`this session ${hoursMinutes(mineMs)}${others > 0 ? ` · ${others} other session${others === 1 ? '' : 's'}, overlap counted once` : ''}`}
        </Text>
        {weekMs.some(ms => ms > 0) && (
          <Text>
            <Text dimColor>{'7 days '}</Text>
            <Text color="cyan">{sparkline(weekMs)}</Text>
            <Text dimColor>
              {` ${hoursMinutes(weekMs.reduce((n, ms) => n + ms, 0))} · ${bill.mode === 'subscription' ? '≈' : ''}${usdShort(weekUsd)}`}
            </Text>
          </Text>
        )}
      </Box>
    )
    const usage = (
      <Box flexDirection="column">
        <Text weight="medium">Usage</Text>
        {windows.length === 0 && (
          <Text dimColor>No reading yet (shown after a reply on a subscription).</Text>
        )}
        {windows.map(w => {
          const pace = elapsed(w, wall)
          const color = limitColor(w.percentUsed)
          const reset = resetsIn(w.resetsAt, wall)
          // Under the even-rate line there is room to spare; over it, the window runs out early.
          const isAhead = pace !== undefined && w.percentUsed > pace * 100
          return (
            <Box key={w.kind} flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between">
                <Text>{LIMIT_NAMES[w.kind] ?? w.kind}</Text>
                <Box flexDirection="row" gap={1}>
                  <Text mono color={color}>
                    {`${w.percentUsed}%`}
                  </Text>
                  {pace !== undefined && (
                    <Text color={isAhead ? 'error' : 'success'}>{isAhead ? '▲초과' : '▼여유'}</Text>
                  )}
                  {reset !== '' && <Text mono dimColor>{`↻${reset}`}</Text>}
                </Box>
              </Box>
              <Text mono>
                {bar(w.percentUsed, pace, limitCells).map(run =>
                  run.kind === 'mark' ? (
                    <Text color="text" weight="bold" backgroundColor={run.isUsed ? color : undefined}>
                      {run.text}
                    </Text>
                  ) : run.kind === 'used' ? (
                    <Text color={color}>{run.text}</Text>
                  ) : (
                    <Text dimColor>{run.text}</Text>
                  ),
                )}
              </Text>
            </Box>
          )
        })}
      </Box>
    )

    const bud = await read($, budget)
    const limit = settings.budgetUsd
    const budShare = limit > 0 ? bud.spent / limit : 0
    const budColor = bud.level === 'block' ? 'error' : bud.level === 'ok' ? 'success' : 'warning'
    const budCells = Math.round(Math.min(1, budShare) * limitCells)
    const spendView = (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text weight="medium">Spend</Text>
          <Text mono weight="bold">
            {`${bill.mode === 'subscription' ? '≈' : ''}${usd(bud.spent)}`}
          </Text>
        </Box>
        <Text dimColor>{billingText(bill)}</Text>
        {limit > 0 && (
          <Box flexDirection="row" justifyContent="space-between">
            <Text mono>
              <Text color={budColor}>{'█'.repeat(budCells)}</Text>
              <Text dimColor>{'░'.repeat(limitCells - budCells)}</Text>
            </Text>
            <Text mono color={budColor}>{`${Math.round(budShare * 100)}% of ${usdShort(limit)}`}</Text>
          </Box>
        )}
        {limit > 0 && (
          <Text dimColor>
            {settings.budgetEnforce
              ? bud.isOverridden
                ? 'Enforced · kept going past the budget'
                : 'Enforced · cheapest subagents at 90% · asks at 100%'
              : 'Warn only · turn on Enforce budget in /config'}
          </Text>
        )}
      </Box>
    )

    const log = await read($, tools)
    const calls = Object.values(log.byTool).reduce((n, x) => n + x.calls, 0)
    const fails = Object.values(log.byTool).reduce((n, x) => n + x.fails, 0)
    const top = slowest(log, 3)
    const toolsView =
      calls === 0 ? null : (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text weight="medium">Tools</Text>
            <Text dimColor>
              {`${calls} calls · `}
              <Text color={fails ? 'error' : 'success'}>{`${fails} failed`}</Text>
            </Text>
          </Box>
          <Text dimColor>
            {top.map(([name, x]) => `${oneLine(name, 18)} ${x.calls}× ${secs(x.ms)}${x.fails ? ` (${x.fails}✗)` : ''}`).join(' · ')}
          </Text>
          {log.failures
            .slice(-3)
            .reverse()
            .map(f => (
              <Text key={`fail-${f.at}-${f.tool}`}>
                <Text color="error">{`✗ ${oneLine(f.label, 32)}`}</Text>
                <Text dimColor>{` ${oneLine(f.error, Math.max(16, width - 36))}`}</Text>
              </Text>
            ))}
        </Box>
      )

    // A dim `── Name ───` rule that opens each group of related sections.
    const divider = (name: string) => (
      <Text key={`group-${name}`} dimColor wrap="truncate-end">
        {`── ${name} ${'─'.repeat(Math.max(2, width - name.length - 4))}`}
      </Text>
    )
    // Cost & time, Activity and Context follow the turn, in that order.
    const groups = (
      <Box flexDirection="column" gap={1}>
        {divider('Cost & time')}
        {spendView}
        {todayView}
        {(toolsView || agentsView) && divider('Activity')}
        {toolsView}
        {agentsView}
        {divider('Context')}
        {contextView}
        {cacheView}
      </Box>
    )

    if (r.status === 'idle') {
      return page(
        <Box flexDirection="column" gap={1}>
          {usage}
          {divider('This turn')}
          <Text weight="semibold">{model}</Text>
          <Text dimColor>Waiting for the next prompt.</Text>
          {groups}
        </Box>,
      )
    }

    return page(
      <Box flexDirection="column" gap={1}>
        {usage}
        {divider('This turn')}
        <Box flexDirection="row" justifyContent="space-between">
          <Text weight="semibold">{model}</Text>
          <Box flexDirection="row" gap={1}>
            <Text mono>{`${bill.mode === 'subscription' ? '≈' : ''}${usd(r.cost - r.costAtStart)}`}</Text>
            <Text color={status.color} weight="medium">
              {r.isPauseRequested && r.status === 'running'
                ? 'Pausing…'
                : r.status === 'failed' && r.apiError
                  ? `${status.text} · ${apiErrorText(r.apiError)}`
                  : status.text}
            </Text>
          </Box>
        </Box>
        <Text dimColor>{r.prompt}</Text>

        <Box flexDirection="row" justifyContent="space-between">
          <Text weight="medium">
            {open?.askedAt !== undefined
              ? `Asked for approval · ${open.label}`
              : open
              ? open.label
              : isLive
                ? 'Thinking…'
                : `${status.text} in ${clock(end - r.startedAt)}`}
          </Text>
          <Text mono dimColor>
            {clock((open ? t - open.startedAt : end - r.startedAt))}
          </Text>
        </Box>

        <Box flexDirection="row">
          {segs.length === 0 && <Text dimColor>No steps yet.</Text>}
          {segs.map(s => (
            <Text
              key={s.id}
              color={
                s.endedAt === undefined
                  ? 'suggestion'
                  : s.ok
                    ? 'success'
                    : 'error'
              }
              hover={{ scope: s.id, inverse: true }}
            >
              {s.endedAt === undefined ? '▰' : '■'}
            </Text>
          ))}
        </Box>

        <Box flexDirection="column">
          {recent.map((s, i) => (
            <Box key={s.id} flexDirection="row" justifyContent="space-between">
              <Text
                dimColor={i > 0}
                color={s.ok ? undefined : 'error'}
                hover={{ scope: s.id, inverse: true }}
              >
                {s.ok ? '✓' : '✗'} {s.label}
              </Text>
              <Text mono dimColor>
                {secs((s.endedAt ?? t) - s.startedAt)}
              </Text>
            </Box>
          ))}
          {recent.filter(s => s.error).slice(0, 1).map(s => (
            <Text key={`${s.id}-error`} color="error" dimColor>{`  ${oneLine(s.error ?? '', Math.max(20, width - 2))}`}</Text>
          ))}
        </Box>

        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" gap={1}>
            {isLive && (
              <Button key="pause" onPress={togglePause}>
                {r.isPauseRequested ? 'Resume' : 'Pause'}
              </Button>
            )}
            {isLive && <Button key="cancel" onPress={cancelNow}>Cancel</Button>}
          </Box>
          <Text dimColor mono>
            {done.length}/{r.steps.length}
          </Text>
        </Box>
        {groups}
      </Box>,
    )
  })
}
