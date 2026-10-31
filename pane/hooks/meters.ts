// Pure helpers for the Context and Cache sections, no `$`. Ported from
// hamzafer/claude-code-mods: context-bar (stacked bar, legend, compact point),
// token-weather (forecast, sparkline, trend) and cache-clock (cache line).
import type { CacheState, CacheTtl, Reading, Slice } from '../types'

// --- context-bar ----------------------------------------------------------

// /context's theme gives several rows the same grey, so each used row gets its own color, in order.
const PALETTE = ['#7aa2f7', '#7dcfff', '#bb9af7', '#9ece6a', '#e0af68', '#f7768e', '#73daca', '#ff9e64', '#c0caf5']
const MESSAGES = '#d97757' // the row that grows, in the accent color
const FREE = '#808080'
const BUFFER = '#808080'
export const GLYPH = { used: '█', free: '─', buffer: '░' } as const
export const SPLIT = '   '

// The breakdown's threshold leaves out CLAUDE_AUTOCOMPACT_PCT_OVERRIDE; auto-compaction applies it
// as min(threshold, effective window * pct / 100) when 0 < pct <= 100.
const AUTOCOMPACT_BUFFER = 13_000
export function compactPoint(threshold: number, pctOverride?: number) {
  if (!(pctOverride !== undefined && pctOverride > 0 && pctOverride <= 100)) return threshold
  return Math.min(threshold, Math.floor((threshold + AUTOCOMPACT_BUFFER) * (pctOverride / 100)))
}

export function toReading(
  b: {
    categories: readonly { name: string; tokens: number; kind: string }[]
    totalTokens: number
    rawMaxTokens: number
    percentage: number
    autoCompactThreshold?: number
    isAutoCompactEnabled: boolean
  },
  pctOverride?: number,
): Reading {
  const slices: Slice[] = b.categories
    .filter(c => c.kind !== 'deferred' && c.tokens > 0)
    .map(c => ({
      name: c.name.toLowerCase(),
      tokens: c.tokens,
      color: '',
      kind: (c.kind === 'free' || c.kind === 'buffer' ? c.kind : 'used') as Slice['kind'],
    }))
  const order = { used: 0, free: 1, buffer: 2 }
  slices.sort((x, y) => order[x.kind] - order[y.kind]) // stable: used rows keep /context's order
  let next = 0
  for (const s of slices) {
    s.color =
      s.kind === 'free'
        ? FREE
        : s.kind === 'buffer'
          ? BUFFER
          : s.name === 'messages'
            ? MESSAGES
            : PALETTE[next++ % PALETTE.length]!
  }
  return {
    slices,
    total: b.totalTokens,
    window: b.rawMaxTokens,
    percent: b.percentage,
    compactsAt:
      b.isAutoCompactEnabled && b.autoCompactThreshold !== undefined
        ? compactPoint(b.autoCompactThreshold, pctOverride)
        : undefined,
  }
}

// The bar as runs of cells: each slice gets its share of `width`, a used one at least one cell.
export function cells(r: Reading, width: number) {
  const sizes = r.slices.map(s =>
    Math.max(s.kind === 'used' ? 1 : 0, Math.round((s.tokens / r.window) * width)),
  )
  // Rounding leaves the sum a few cells off: free space takes the difference first, then the largest slices.
  let diff = width - sizes.reduce((a, n) => a + n, 0)
  const isUsed = (i: number) => r.slices[i]!.kind === 'used'
  const order = r.slices
    .map((_, i) => i)
    .sort((a, b) => Number(isUsed(a)) - Number(isUsed(b)) || sizes[b]! - sizes[a]!)
  for (const i of order) {
    if (diff === 0) break
    const size = Math.max(isUsed(i) ? 1 : 0, sizes[i]! + diff)
    diff -= size - sizes[i]!
    sizes[i] = size
  }
  return r.slices
    .map((s, i) => ({ key: s.name, color: s.color, text: GLYPH[s.kind].repeat(sizes[i]!) }))
    .filter(c => c.text !== '')
}

// The legend, packed into lines no wider than `width`.
export function legend(r: Reading, width: number) {
  const lines: Slice[][] = [[]]
  let used = 0
  for (const s of r.slices) {
    const size =
      2 + s.name.length + 1 + tokens(s.tokens).length +
      (s.kind === 'used' ? 1 + share(s.tokens, r.window).length : 0)
    const line = lines.at(-1)!
    if (line.length > 0 && used + SPLIT.length + size > width) {
      lines.push([s])
      used = size
    } else {
      used += (line.length > 0 ? SPLIT.length : 0) + size
      line.push(s)
    }
  }
  return lines.filter(l => l.length > 0)
}

export function tokens(n: number) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`
  return String(n)
}

export function share(n: number, window: number) {
  const p = (n / window) * 100
  if (p > 0 && p < 0.1) return '<0.1%'
  return `${p >= 10 ? Math.round(p) : +p.toFixed(1)}%`
}

// --- token-weather --------------------------------------------------------

export const HISTORY = 12
const BARS = '▁▂▃▄▅▆▇█'
const FORECAST = [
  { upTo: 25, icon: '☀', word: 'Clear', color: 'yellow' },
  { upTo: 50, icon: '☁', word: 'Cloudy', color: 'cyan' },
  { upTo: 75, icon: '☂', word: 'Showers', color: 'blue' },
  { upTo: 90, icon: '☇', word: 'Storm', color: 'magenta' },
  { upTo: Infinity, icon: '↯', word: 'Compact soon', color: 'red' },
] as const

export const forecast = (percent: number) =>
  FORECAST.find(b => percent < b.upTo) ?? FORECAST[4]

export function sparkline(history: readonly number[]) {
  const top = Math.max(...history, 1)
  return history.map(t => BARS[Math.floor((t / top) * (BARS.length - 1))]).join('')
}

export function trend(history: readonly number[]) {
  if (history.length < 2) return ''
  const delta = (history.at(-1) ?? 0) - (history.at(-2) ?? 0)
  if (delta === 0) return 'steady'
  return delta > 0 ? `▲ +${tokens(delta)} last turn` : `▼ ${tokens(-delta)} last turn`
}

// --- cache-clock ----------------------------------------------------------

export const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 } as const
const BAR_CELLS = 10
// Under this share of the lifetime left, the line turns yellow.
const WARN_SHARE = 0.2

export const NO_CACHE: CacheState = {
  read: 0,
  written: 0,
  uncached: 0,
  steps: 0,
  misses: 0,
  lastPrompt: 0,
}

// Folds one main-thread response's usage into the session's cache figures.
// A miss is a response after the first that read nothing from the cache.
export function addUsage(
  c: CacheState,
  u: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number },
  at: number,
): CacheState {
  return {
    ...c,
    lastRequestAt: at,
    read: c.read + u.cache_read_input_tokens,
    written: c.written + u.cache_creation_input_tokens,
    uncached: c.uncached + u.input_tokens,
    steps: c.steps + 1,
    misses: c.misses + (c.steps > 0 && u.cache_read_input_tokens === 0 ? 1 : 0),
    lastPrompt: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
  }
}

export type CacheLine = {
  isWarm: boolean
  head: string
  bar?: { filled: string; empty: string }
  color: string
  details: string[]
}

// What the cache section says at `now`; null before the first response.
export function cacheLine(c: CacheState, ttl: CacheTtl, now: number): CacheLine | null {
  if (c.lastRequestAt === undefined) return null
  const ttlMs = TTL_MS[ttl]
  const left = c.lastRequestAt + ttlMs - now
  const total = c.read + c.written + c.uncached
  const details: string[] = []
  if (left > 0) {
    if (total > 0) details.push(`hit ${Math.round((c.read / total) * 100)}%`)
    details.push(`misses ${c.misses}`)
    const filled = Math.max(0, Math.min(BAR_CELLS, Math.ceil((left / ttlMs) * BAR_CELLS)))
    return {
      isWarm: true,
      head: `● ${ttl} · ${countdown(left)} left`,
      bar: { filled: '█'.repeat(filled), empty: '░'.repeat(BAR_CELLS - filled) },
      color: left < ttlMs * WARN_SHARE ? 'yellow' : 'green',
      details,
    }
  }
  if (c.lastPrompt > 0) details.push(`next message re-caches ${tokens(c.lastPrompt)} tokens`)
  return { isWarm: false, head: '○ cold', color: 'red', details }
}

// 4:05 under ten minutes, whole minutes above.
function countdown(ms: number) {
  const s = Math.ceil(ms / 1000)
  return s >= 600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// When the cache line's text next changes: every second under ten minutes, else each minute.
export function nextChangeIn(c: CacheState, ttl: CacheTtl, now: number) {
  if (c.lastRequestAt === undefined) return undefined
  const left = c.lastRequestAt + TTL_MS[ttl] - now
  if (left <= 0) return undefined
  const step = left > 600_000 ? 60_000 : 1000
  return Math.min(left % step || step, left)
}

// The lifetime the latest main-thread response wrote to the cache with; null when it
// wrote nothing (a pure cache hit) or no response was found.
export function ttlFromTranscript(text: string): CacheTtl | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: any
    try {
      entry = JSON.parse(lines[i] ?? '')
    } catch {
      continue // blank, or cut by the tail
    }
    if (entry?.type !== 'assistant' || entry.isSidechain || !entry.message?.usage) continue
    const written = entry.message.usage.cache_creation
    if (Number(written?.ephemeral_1h_input_tokens) > 0) return '1h'
    if (Number(written?.ephemeral_5m_input_tokens) > 0) return '5m'
    return null
  }
  return null
}
