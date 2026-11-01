export type Step = {
  id: string
  label: string
  source: string
  startedAt: number
  endedAt?: number
  ok?: boolean
}

// One item of the agent's own task list (TodoWrite, TaskCreate/Update, the app's plan).
export type PlanItem = {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type RunStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'finished'
  | 'cancelled'
  | 'interrupted'
  | 'failed'

export type Run = {
  status: RunStatus
  prompt: string
  turnId?: string
  startedAt: number
  endedAt?: number
  costAtStart: number
  cost: number
  isPauseRequested: boolean
  steps: Step[]
  plan: PlanItem[]
}

export type RateLimit = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

// context-bar: the window by category, as /context breaks it down.
export type Slice = {
  name: string
  tokens: number
  color: string
  kind: 'used' | 'free' | 'buffer'
}

export type Reading = {
  slices: Slice[]
  total: number
  window: number
  percent: number
  compactsAt?: number
}

export type CacheTtl = '5m' | '1h'

// cache-clock: the prompt cache, folded from each main-thread response.
export type CacheState = {
  lastRequestAt?: number
  read: number
  written: number
  uncached: number
  steps: number
  misses: number
  lastPrompt: number
}

export type Handoff = {
  isAuto: boolean
  // Set when a handoff prompt was sent; cleared once the context drops back
  // under the re-arm level (after a compaction or /clear).
  requestedAt?: number
  requestedPercent?: number
}

// switchboard
export type Tier = 'haiku' | 'sonnet' | 'opus' | 'fable'

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// What switchboard did with one spawn.
export type Route = {
  asked?: string // what it would run on without a switch; undefined when its own agent definition decides
  picked?: Tier
  by: 'jev' | 'openai' | 'none'
  confidence?: number
  reason: string
  applied: boolean
  pickerUsd?: number
}

// agent-radar + switchboard: one row per subagent or background shell.
export type AgentRow = {
  id: string // a subagent's id, or sh:<output file>
  kind: 'agent' | 'shell'
  description: string
  type: string
  // waiting: held on its own background work or an approval; idle: between turns, until a message wakes it.
  status: 'running' | 'waiting' | 'idle' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  tools: number
  last: string
  model?: string
  route?: Route
  usage?: Usage
  costUsd?: number
  askedUsd?: number
  detail?: string // shell: the description or program, never the whole command line
  out?: string // shell: its output file
  seen?: boolean
  misses?: number
  lines?: string[]
  review?: ReviewInfo // review-watch: a codex review command or a review subagent
  plan?: PlanItem[] // a subagent's own task list, from its TodoWrite or Task calls
  result?: string // a subagent's final answer, cut short
}

export type ReviewInfo = {
  model: string
  label: string
  findings?: string[] // Codex's [P1]/[P2] items once it ends; undefined when unknown
  out?: string // where Codex's stdout went (`> file`), when not Claude Code's own output file
}

// The branch band above the prompt.
export type Branch = {
  repo: string // the repository: origin's name, else the top folder's
  name: string // the branch, or `detached <sha>`
  ahead: number
  behind: number
  hasUpstream: boolean
  changed: number
}

// Time an agent was actually working today: the turns of every session, as
// [start, end] spans, so time two sessions worked at once counts once.
export type Span = [number, number]

export type Today = {
  date: string // local YYYY-MM-DD
  all: Span[] // every session's finished turns and other sessions' running ones, merged
  mine: Span[] // this session's finished turns, merged
  sessions: number // sessions that worked today
}

// This pane's version and the marketplace's newest; either is absent until read.
export type Release = {
  installed?: string
  latest?: string
}

// The Update button: pulls the latest pane from its marketplace.
export type SelfUpdate = {
  status: 'idle' | 'running' | 'done' | 'failed'
  message?: string
}

// The Graft Update button: `graphify update` for the files changed since the last build.
export type GraftUpdate = {
  status: 'idle' | 'running' | 'done' | 'failed'
  message?: string
}

declare module 'claude-code' {
  interface PluginState {
    'agent-monitor-pane': {
      run: Shaped<Run>
      now: Shaped<number>
      limits: Shaped<RateLimit[]>
      reading: Shaped<Reading | null>
      history: Shaped<number[]>
      cache: Shaped<CacheState>
      ttl: Shaped<CacheTtl>
      handoff: Shaped<Handoff>
      agents: Shaped<AgentRow[]>
      selected: Shaped<string | null>
      branch: Shaped<Branch | null>
      release: Shaped<Release>
      today: Shaped<Today>
      selfUpdate: Shaped<SelfUpdate>
      graftUpdate: Shaped<GraftUpdate>
    }
  }
}
