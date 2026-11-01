// Pure helpers for the Spend and Tools sections and the run card's signals, no `$`.
// Ideas from flightdeckhq/flightdeck: how the session is billed, a token budget with
// warn / degrade / block steps, a record of each tool's failures and time, approval
// waits and the kind of API error that ended a turn.
import type { Billing, BudgetLevel, ToolFailure, ToolLog } from '../types'

// --- billing --------------------------------------------------------------

export type BillingSetting = 'auto' | 'subscription' | 'metered'

// An environment switch such as CLAUDE_CODE_USE_BEDROCK reads as on: a cloud provider
// bills every token, whatever the login.
export const isSet = (v: string) => v !== '' && v !== '0' && v.toLowerCase() !== 'false'

// How the session is billed: the setting when it names one, else `claude auth status`'s
// JSON (a claude.ai login is a subscription, an API key or another provider is metered),
// else the environment (a key or auth token is metered, anything else a subscription).
export function billingOf(
  setting: BillingSetting,
  authStatus: string | undefined,
  env: { isCloud: boolean; hasKey: boolean },
): Billing {
  if (setting !== 'auto') return { mode: setting, source: 'setting' }
  if (env.isCloud) return { mode: 'metered', plan: 'cloud provider', source: 'env' }
  let auth: Record<string, unknown> | undefined
  try {
    const v: unknown = JSON.parse(authStatus ?? '')
    auth = v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
  } catch {
    auth = undefined
  }
  if (auth?.loggedIn === true) {
    const provider = typeof auth.apiProvider === 'string' ? auth.apiProvider : 'firstParty'
    if (provider !== 'firstParty') return { mode: 'metered', plan: provider, source: 'auth' }
    if (auth.authMethod === 'claude.ai') {
      const plan = typeof auth.subscriptionType === 'string' ? auth.subscriptionType : undefined
      return { mode: 'subscription', plan, source: 'auth' }
    }
    return { mode: 'metered', plan: 'API key', source: 'auth' }
  }
  return env.hasKey ? { mode: 'metered', plan: 'API key', source: 'env' } : { mode: 'subscription', source: 'env' }
}

export const billingText = (b: Billing) => {
  const plan = b.plan ? ` (${b.plan})` : ''
  if (b.mode === 'subscription') return `Subscription${plan} · API-price estimate, not charged`
  if (b.mode === 'metered') return `Metered${plan} · billed per token`
  return 'Billing unknown'
}

// --- budget ---------------------------------------------------------------

export const WARN_AT = 0.8
export const DEGRADE_AT = 0.9
export const BLOCK_AT = 1

const RANK: Record<BudgetLevel, number> = { ok: 0, warn: 1, degrade: 2, block: 3 }
export const isAtLeast = (level: BudgetLevel, than: BudgetLevel) => RANK[level] >= RANK[than]

// Where `spent` stands against `limit`; always ok with no budget set.
export function levelOf(spent: number, limit: number): BudgetLevel {
  if (!(limit > 0)) return 'ok'
  const share = spent / limit
  return share >= BLOCK_AT ? 'block' : share >= DEGRADE_AT ? 'degrade' : share >= WARN_AT ? 'warn' : 'ok'
}

// --- tools ----------------------------------------------------------------

export const NO_TOOLS: ToolLog = { byTool: {}, failures: [] }
const FAILURES_KEPT = 20
const ERROR_MAX = 120

// The name a tool's figures go under: an MCP tool by its server and tool, without the prefix.
export const toolKey = (tool: string) => (tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' ') : tool)

// One line of why a call failed: the deny reason, else the first line of the error text.
export function errorLine(ran: { deny?: string; text?: string }) {
  const raw = ran.deny !== undefined ? `denied: ${ran.deny}` : (ran.text ?? '')
  const line = raw.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).find(Boolean) ?? 'failed'
  return line.length > ERROR_MAX ? `${line.slice(0, ERROR_MAX - 1)}…` : line
}

// Folds one finished call into the session's tool figures.
export function addCall(
  log: ToolLog,
  call: { tool: string; ms: number; failure?: Omit<ToolFailure, 'tool'> },
): ToolLog {
  const key = toolKey(call.tool)
  const had = log.byTool[key] ?? { calls: 0, fails: 0, ms: 0 }
  return {
    byTool: {
      ...log.byTool,
      [key]: { calls: had.calls + 1, fails: had.fails + (call.failure ? 1 : 0), ms: had.ms + Math.max(0, call.ms) },
    },
    failures: call.failure ? [...log.failures, { tool: key, ...call.failure }].slice(-FAILURES_KEPT) : log.failures,
  }
}

// The tools that took the most time, most first.
export const slowest = (log: ToolLog, n: number) =>
  Object.entries(log.byTool)
    .sort((a, b) => b[1].ms - a[1].ms)
    .slice(0, n)

// --- run signals ----------------------------------------------------------

// Modes in which nobody is asked: the classifier or the mode itself settles an ask.
const NO_PERSON_MODES = new Set(['auto', 'bypassPermissions', 'dontAsk'])

// True when a permission verdict puts the call to the person at the keyboard.
export const asksPerson = (decision: string, approver: string | undefined, mode: string | undefined) =>
  decision === 'ask' && approver === 'person' && !NO_PERSON_MODES.has(mode ?? '')

// Claude Code's word for the API error that ended a turn, as the run card says it.
const API_ERROR: Record<string, string> = {
  rate_limit: 'rate limited',
  overloaded: 'API overloaded',
  server_error: 'API server error',
  authentication_failed: 'login failed',
  oauth_org_not_allowed: 'organization not allowed',
  account_on_hold: 'account on hold',
  verification_required: 'verification required',
  billing_error: 'billing problem',
  invalid_request: 'invalid request',
  model_not_found: 'model not found',
  max_output_tokens: 'output limit reached',
  cloud_credential_error: 'cloud credentials',
}

export const apiErrorText = (kind: string) => API_ERROR[kind] ?? kind.replace(/_/g, ' ')
