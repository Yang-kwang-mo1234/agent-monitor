import { expect, test } from 'claude-code/testing'

import { NO_TOOLS, addCall, apiErrorText, asksPerson, billingOf, errorLine, levelOf, slowest } from '../hooks/spend'

const none = { isCloud: false, hasKey: false }

test('billing: a claude.ai login is a subscription, an API key or a cloud provider is metered', async () => {
  const pro = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro' })
  expect(billingOf('auto', pro, none)).toEqual({ mode: 'subscription', plan: 'pro', source: 'auth' })
  const key = JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' })
  expect(billingOf('auto', key, none).mode).toBe('metered')
  const bedrock = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' })
  expect(billingOf('auto', bedrock, none)).toEqual({ mode: 'metered', plan: 'bedrock', source: 'auth' })
  expect(billingOf('auto', pro, { isCloud: true, hasKey: false }).mode).toBe('metered')
})

test('billing: the setting wins, and without auth status the environment decides', async () => {
  expect(billingOf('metered', undefined, none)).toEqual({ mode: 'metered', source: 'setting' })
  expect(billingOf('auto', 'not json', { isCloud: false, hasKey: true }).mode).toBe('metered')
  expect(billingOf('auto', undefined, none)).toEqual({ mode: 'subscription', source: 'env' })
})

test('budget levels: warn at 80%, degrade at 90%, block at 100%, none without a budget', async () => {
  expect(levelOf(5, 0)).toBe('ok')
  expect(levelOf(0.79, 1)).toBe('ok')
  expect(levelOf(0.8, 1)).toBe('warn')
  expect(levelOf(0.9, 1)).toBe('degrade')
  expect(levelOf(1, 1)).toBe('block')
})

test('tool figures add up per tool, keep the failures, and sort by time', async () => {
  let log = addCall(NO_TOOLS, { tool: 'Read', ms: 100 })
  log = addCall(log, { tool: 'Bash', ms: 3000, failure: { label: 'Running tests', error: 'Exit code 1', at: 5, ms: 3000 } })
  log = addCall(log, { tool: 'mcp__github__get_issue', ms: 500 })
  expect(log.byTool.Bash).toEqual({ calls: 1, fails: 1, ms: 3000 })
  expect(log.byTool['github get_issue']?.calls).toBe(1)
  expect(log.failures).toEqual([{ tool: 'Bash', label: 'Running tests', error: 'Exit code 1', at: 5, ms: 3000 }])
  expect(slowest(log, 2).map(([k]) => k)).toEqual(['Bash', 'github get_issue'])
})

test('an error line is the deny reason or the first line of the error text', async () => {
  expect(errorLine({ deny: 'not allowed' })).toBe('denied: not allowed')
  expect(errorLine({ text: '\n  Exit code 2\nmore' })).toBe('Exit code 2')
  expect(errorLine({})).toBe('failed')
})

test('an ask counts as waiting on the person only when a person answers it', async () => {
  expect(asksPerson('ask', 'person', 'default')).toBe(true)
  expect(asksPerson('ask', 'person', undefined)).toBe(true)
  expect(asksPerson('ask', 'person', 'auto')).toBe(false)
  expect(asksPerson('ask', 'host', 'default')).toBe(false)
  expect(asksPerson('allow', 'person', 'default')).toBe(false)
})

test('API error kinds read as words', async () => {
  expect(apiErrorText('rate_limit')).toBe('rate limited')
  expect(apiErrorText('overloaded')).toBe('API overloaded')
  expect(apiErrorText('something_new')).toBe('something new')
})
