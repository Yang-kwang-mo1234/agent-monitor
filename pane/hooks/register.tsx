import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import type {
  AgentRow,
  Branch,
  CacheState,
  CacheTtl,
  Handoff,
  RateLimit,
  Reading,
  Route,
  Run,
  RunStatus,
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
}
// Change the tag when Run's fields change: it declines what an earlier
// version stored, which outlives a reload.
const run = atom({ plugin: 'agent-monitor-pane', key: 'run' } as const, IDLE, {
  shape: 'run-1',
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
  { shape: 'agents-1' },
)
const selected = atom(
  { plugin: 'agent-monitor-pane', key: 'selected' } as const,
  null as string | null,
  { shape: 'selected-1' },
)

const branch = atom(
  { plugin: 'agent-monitor-pane', key: 'branch' } as const,
  null as Branch | null,
  { shape: 'branch-1' },
)

// The mascot's step count: its place along the bottom row is a bounce over it.
const frame = atom({ plugin: 'agent-monitor-pane', key: 'frame' } as const, 0, {
  shape: 'frame-1',
})

const today = atom(
  { plugin: 'agent-monitor-pane', key: 'today' } as const,
  { date: '', all: [], mine: [], sessions: 0 } as Today,
  { shape: 'today-2' },
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
const LIMIT_ORDER = ['five_hour', 'seven_day', 'spend_limit']
const limitColor = (pct: number) =>
  pct >= 90 ? 'error' : pct >= 70 ? 'warning' : 'success'
const bar = (pct: number, cells: number) => {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * cells)
  return { filled: '█'.repeat(filled), empty: '░'.repeat(cells - filled) }
}
const resetsIn = (iso: string | undefined, t: number) => {
  const at = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(at)) return ''
  const m = Math.max(0, Math.round((at - t) / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m % 60}m` : `${m}m`
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

const isShown = (a: AgentRow, at: number) =>
  a.status === 'running' || (a.endedAt !== undefined && at - a.endedAt < SHOW_DONE_MS)
const agentIcon = (a: AgentRow) => (a.status === 'running' ? '●' : a.status === 'done' ? '✓' : '✗')
const agentColor = (a: AgentRow) => (a.status === 'running' ? 'yellow' : a.status === 'done' ? 'green' : 'red')
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

// The branch, ahead/behind and changed files, from one `git status`; null outside a repo.
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
    if (name) next = { name, ahead, behind, hasUpstream, changed }
  }
  const cur = await read($, branch)
  if (JSON.stringify(cur) !== JSON.stringify(next)) await update($, branch, () => next)
}

// --- today's work time ----------------------------------------------------

// Each session keeps its finished turns per local day as [start, end] spans under
// `worked:<date>:<session>`, and its running turn under `working:<session>`, in
// the cross-session store, so sessions side by side never write the same key.
// The total is the union of every session's spans: time two sessions worked at
// once counts once. A turn past midnight is split between the two days.
const WORKED = 'worked:'
const WORKING = 'working:'
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
  for (const key of await $.store.keys()) {
    if (key.startsWith(prefix)) {
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
  const next: Today = { date, all: merge(all.map(clip)), mine: merge(mine), sessions: workers.size }
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

// --- mascot ---------------------------------------------------------------

// The Claude mark walks the pane's bottom row while work runs: one cell per
// step, faster with more going on at once (the turn, its open tool call, each
// running subagent and background shell). It stands still when nothing runs.
// Three rows tall, so it reads at about three times a line of text.
const MASCOT = ['╲ │ ╱', '─ ✻ ─', '╱ │ ╲']
const MASCOT_WIDTH = 5
const SLOWEST_MS = 480
const FASTEST_MS = 120
let mascotTimer: Timer | undefined
let mascotMs = 0

// How much is running now: 0 when idle or paused.
async function workload($: EngineInterface) {
  const r = await read($, run)
  const busy = (await read($, agents)).filter(a => a.status === 'running').length
  if (r.status !== 'running' && busy === 0) return 0
  const turn = r.status === 'running' ? 1 : 0
  const step = r.status === 'running' && r.steps.some(x => x.endedAt === undefined) ? 1 : 0
  return turn + step + busy
}

// Starts, retunes or stops the walk to match the workload.
async function retuneMascot($: EngineInterface) {
  const load = await workload($)
  const ms = load === 0 ? 0 : Math.max(FASTEST_MS, Math.round(SLOWEST_MS / load))
  if (ms === mascotMs) return
  mascotTimer?.cancel()
  mascotTimer = undefined
  mascotMs = ms
  if (ms > 0) mascotTimer = $.clock.every(ms, () => void update($, frame, f => f + 1).catch(() => {}))
}

// Where `step` puts the mark on a row of `span` cells, walking there and back.
const bounce = (step: number, span: number) => {
  if (span <= 0) return 0
  const t = step % (span * 2)
  return t <= span ? t : span * 2 - t
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
    for (const t of agentTimers) t.cancel()
    agentTimers = [
      // Elapsed times tick while a row shows, and a finished row leaves after 30 s.
      $.clock.every(1000, () => {
        void (async () => {
          const at = await $.clock.now()
          if ((await read($, agents)).some(a => isShown(a, at - 3_000))) await update($, now, () => at)
          await retuneMascot($)
        })().catch(() => {})
      }),
      $.clock.every(5_000, () => void pollShells($).catch(() => {})),
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
    const pick: Pick = named
      ? { by: 'none', reason: 'named by the caller, kept' }
      : await credential($, settings)
          .then(c => decide($, e, c, settings))
          .catch(() => ({ by: 'none' as const, reason: 'picker failed, kept' }))
    const sure = pick.confidence === undefined || pick.confidence >= MIN_CONFIDENCE
    const apply =
      settings.mode === 'auto' && sure && !!pick.tier && asked !== undefined && pick.tier !== tierOf(asked)
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
    if (e.agentId !== undefined || e.text === '') return next(e)

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
    await retuneMascot($)
    await startWorking($, t).catch(() => {})

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const id = e.agentId
      const line = agentStep(e as unknown as Record<string, unknown>)
      await update($, agents, list =>
        list.map(a => (a.id === id ? { ...a, tools: a.tools + 1, last: line } : a)),
      )
      return next(e)
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
    const cost = (await $.session.usage()).cost?.usd
    await update($, run, r => ({
      ...r,
      cost: cost ?? r.cost,
      steps: r.steps.map(s => (s.id === step.id ? { ...s, endedAt, ok } : s)),
    }))

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const res = await next(e)
      const id = e.agentId
      const failed = e.reason === 'error' || e.reason === 'aborted'
      const at = await $.clock.now()
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
      return res
    }

    ticker?.cancel()
    ticker = undefined
    void retuneMascot($).catch(() => {})
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
    await refreshToday($).catch(() => {})
    await recordTurn($).catch(() => {})
    await refreshBranch($).catch(() => {})
    await refreshContext($).catch(() => {})
    await detectTtl($).catch(() => {})

    return next(e)
  })

  // The branch, drawn above the prompt box where it is hard to miss.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = await read($, branch)
    if (e.props.hasSurvey || !b) return next(e)
    const rest = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const sync = b.hasUpstream
      ? b.ahead || b.behind
        ? `↑${b.ahead} ↓${b.behind}`
        : 'up to date'
      : 'no upstream'
    const mine = (
      <Box key="agent-monitor-branch" flexDirection="row" gap={1}>
        <Text backgroundColor="#2f6feb" color="#ffffff" weight="bold">
          {` ⎇ ${b.name} `}
        </Text>
        <Text color={b.changed ? 'yellow' : 'green'}>
          {b.changed ? `● ${b.changed} changed` : '✓ clean'}
        </Text>
        <Text dimColor>{sync}</Text>
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
    const runningRows = rows.filter(a => a.status === 'running').length
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
      void update($, agents, all => all.filter(a => a.status === 'running'))
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
          {(shownRows.length > 0 ? shownRows : rows).slice(0, AGENT_ROWS).map(a => {
            const routeText = a.route ? move(a.route, settings.mode) : ''
            const facts = [
              a.review ? 'review' : a.kind === 'agent' ? 'sub' : 'sh',
              a.review && a.kind === 'shell' ? a.review.model : '',
              a.review?.findings ? findingsText(a.review.findings) : '',
              routeText,
              a.kind === 'agent' ? `${a.tools} tools` : '',
              a.kind === 'agent' && a.status !== 'running' ? usdShort(a.costUsd) : '',
              a.status !== 'done' ? a.last : '',
            ].filter(Boolean)
            return (
              <Box key={a.id} flexDirection="column">
                <Button key={`agent-${a.id}`} plain onPress={toggleRow(a.id)}>
                  <Text color={agentColor(a)} weight="semibold">{`${agentIcon(a)} ${a.description}`}</Text>
                  <Text dimColor>{`${a.model ? ` (${modelName(a.model)})` : ''}  ${agentElapsed(a, wall)}`}</Text>
                </Button>
                <Text dimColor>{`  ${facts.join(' · ')}`}</Text>
                {opened?.id === a.id && a.kind === 'shell' && (
                  <Box flexDirection="column">
                    <Text dimColor mono>{`  $ ${clean(a.detail ?? '')}`}</Text>
                    {(a.lines ?? []).length === 0 && <Text dimColor>{'  No output yet.'}</Text>}
                    {(a.lines ?? []).map(l => (
                      <Text mono>{`  ${l}`}</Text>
                    ))}
                  </Box>
                )}
                {opened?.id === a.id && a.kind === 'agent' && (
                  <Box flexDirection="column">
                    {a.route && <Text dimColor>{`  ${a.type} · ${a.route.reason}`}</Text>}
                    {openedMessages.length === 0 && <Text dimColor>{'  No messages yet.'}</Text>}
                    {openedMessages.map(m => (
                      <Text>
                        <Text color={m.role === 'assistant' ? 'cyan' : undefined} weight="semibold">
                          {m.role === 'assistant' ? '  agent: ' : '  task:  '}
                        </Text>
                        <Text>{clean(m.text).replace(/\s+/g, ' ').slice(0, 300) || '(tool calls)'}</Text>
                      </Text>
                    ))}
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
    const pad = ' '.repeat(bounce(await read($, frame), Math.max(0, width - MASCOT_WIDTH)))
    const mascot = (
      <Box key="mascot" flexDirection="column">
        {MASCOT.map(row => (
          <Text mono color="claude" weight="bold">
            {pad + row}
          </Text>
        ))}
      </Box>
    )
    // The body fills the pane's height, so the mark sits on its bottom rows.
    const bodyRows = e.props.scroll?.bodyRows ?? 0
    const page = (content: RenderChildren) => (
      <Box flexDirection="column" minHeight={bodyRows}>
        <Box flexDirection="column" gap={1} flexGrow={1}>
          {content}
        </Box>
        {mascot}
      </Box>
    )
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
      </Box>
    )
    const usage = (
      <Box flexDirection="column">
        <Text weight="medium">Usage</Text>
        {windows.length === 0 && (
          <Text dimColor>No reading yet (shown after a reply on a subscription).</Text>
        )}
        {windows.map(w => {
          const b = bar(w.percentUsed, limitCells)
          const reset = resetsIn(w.resetsAt, wall)
          return (
            <Box key={w.kind} flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between">
                <Text>{LIMIT_NAMES[w.kind] ?? w.kind}</Text>
                <Text mono color={limitColor(w.percentUsed)}>
                  {`${w.percentUsed}%`}
                </Text>
              </Box>
              <Box flexDirection="row" justifyContent="space-between">
                <Text mono>
                  <Text color={limitColor(w.percentUsed)}>{b.filled}</Text>
                  <Text dimColor>{b.empty}</Text>
                </Text>
                <Text dimColor>{reset && `resets in ${reset}`}</Text>
              </Box>
            </Box>
          )
        })}
      </Box>
    )

    if (r.status === 'idle') {
      return page(
        <>
          <Text weight="semibold">{model}</Text>
          <Text dimColor>Waiting for the next prompt.</Text>
          {agentsView}
          {contextView}
          {cacheView}
          {usage}
          {todayView}
        </>,
      )
    }

    return page(
      <>
        <Box flexDirection="row" justifyContent="space-between">
          <Text weight="semibold">{model}</Text>
          <Box flexDirection="row" gap={1}>
            <Text mono>{usd(r.cost - r.costAtStart)}</Text>
            <Text color={status.color} weight="medium">
              {r.isPauseRequested && r.status === 'running'
                ? 'Pausing…'
                : status.text}
            </Text>
          </Box>
        </Box>
        <Text dimColor>{r.prompt}</Text>

        <Box flexDirection="row" justifyContent="space-between">
          <Text weight="medium">
            {open
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
        {agentsView}
        {contextView}
        {cacheView}
        {usage}
        {todayView}
      </>,
    )
  })
}
