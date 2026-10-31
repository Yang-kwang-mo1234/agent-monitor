import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'agent-monitor-pane',
  component: 'Pane',
  requestId: 'agent-monitor',
  props: {
    title: 'Agent Monitor',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

type State = { t: number; usd: number; aborted: string[]; pct?: number }

// /context's breakdown at `pct` of a 200k window: 20k system prompt, the rest messages.
const breakdown = (pct: number) => {
  const total = pct * 2000
  return {
    categories: [
      { name: 'System prompt', tokens: 20_000, kind: 'system', color: '', isDeferred: false },
      { name: 'Messages', tokens: Math.max(0, total - 20_000), kind: 'messages', color: '', isDeferred: false },
      { name: 'Free space', tokens: 200_000 - total, kind: 'free', color: '', isDeferred: false },
    ],
    totalTokens: total,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    percentage: pct,
    autoCompactThreshold: 167_000,
    isAutoCompactEnabled: true,
  }
}

const engine = (on: any, state: State) => {
  on('command.register', () => ({ value: { command: 'monitor' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'Claude Opus 5.5' }))
  on('session.usage', (_: unknown, e: any) => ({
    value: {
      startedAt: 0,
      context: {
        window: 200_000,
        tokens: (state.pct ?? 0) * 2000,
        percent: state.pct ?? 0,
        ...(e?.breakdown && state.pct !== undefined ? { breakdown: breakdown(state.pct) } : {}),
      },
      rateLimits: [],
      cost: { usd: state.usd },
    },
  }))
  const clock = mock.clock(on, { now: state.t })
  on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: any) => ({ text: e.answer }))
  on('turn.abort', (_: unknown, e: any) => {
    state.aborted.push(e.turnId)
    return { value: undefined }
  })
  return clock
}

test('a run shows its steps, cost and status', async ($, on) => {
  const state: State = { t: 1_000, usd: 0.012, aborted: [] as string[] }
  engine(on, state)
  on('tool.call', () => {
    state.usd = 0.048
    return { result: {} }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'ship v3.2.0', turnId: 'turn-1' })
  await $.tool.call({
    tool: 'Bash',
    command: 'npm run build',
    description: 'Building the preview',
  } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Running/ }))?.text).toBe('Running')
  expect((await ui.find({ type: 'Text', text: /\$0\./ }))?.text).toBe('$0.036')
  expect(
    (await ui.find({ type: 'Text', text: /Building the preview/ }))?.text,
  ).toBe('✓ Building the preview')
  expect((await ui.find({ type: 'Text', text: /^1\/1$/ }))?.text).toBe('1/1')
  await ui.unmount()

  await $.turn.complete({
    answer: 'done',
    durationMs: 2_000,
    isAborted: false,
    turnId: 'turn-1',
    reason: 'answer',
  })
  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await after.find({ type: 'Text', text: /^Finished$/ }))?.text).toBe(
    'Finished',
  )
  await after.unmount()
})

test('Cancel aborts the running turn and reports Cancelled', async ($, on) => {
  const state: State = { t: 1_000, usd: 0, aborted: [] as string[] }
  engine(on, state)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'long job', turnId: 'turn-2' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ plugin: 'agent-monitor-pane', key: 'cancel' })
  await ui.unmount()
  expect(state.aborted).toEqual(['turn-2'])

  await $.turn.complete({
    answer: '',
    durationMs: 10,
    isAborted: true,
    turnId: 'turn-2',
    reason: 'aborted',
  })
  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await after.find({ type: 'Text', text: /^Cancelled$/ }))?.text).toBe(
    'Cancelled',
  )
  await after.unmount()
})

test('Pause asks before the next tool call, and Cancel there denies it', async ($, on) => {
  const state: State = { t: 1_000, usd: 0, aborted: [] as string[] }
  engine(on, state)
  on('tool.call', (_: unknown, e: any) =>
    e.tool === 'AskUserQuestion'
      ? {
          result: {
            questions: e.questions,
            answers: { [e.questions[0].question]: 'Cancel' },
          },
        }
      : { result: {} },
  )

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'job', turnId: 'turn-3' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ plugin: 'agent-monitor-pane', key: 'pause' })
  expect((await ui.find({ type: 'Text', text: /Pausing/ }))?.text).toBe('Pausing…')
  await ui.unmount()

  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(ran.deny).toBe('Cancelled from Agent Monitor.')
  expect(state.aborted).toEqual(['turn-3'])
})

test('the 5-hour and weekly windows show their pace and reset times', async ($, on) => {
  const state: State = { t: Date.parse('2026-10-31T10:00:00Z'), usd: 0, aborted: [] as string[] }
  engine(on, state)
  on('session.measure', (_: unknown, e: any) => ({ changed: e.changed }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({
    context: {} as any,
    rateLimits: [
      { kind: 'seven_day', percentUsed: 41, resetsAt: '2026-11-03T12:00:00Z' },
      { kind: 'five_hour', percentUsed: 92.5, resetsAt: '2026-10-31T12:14:00Z' },
    ],
    changed: ['rateLimits'],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const names = (await ui.findAll({ type: 'Text', text: /^(5-hour|Weekly)$/ })).map(
    n => n.text,
  )
  expect(names).toEqual(['5-hour', 'Weekly'])
  expect((await ui.find({ type: 'Text', text: /^92\.5%$/ }))?.text).toBe('92.5%')
  expect((await ui.find({ type: 'Text', text: /^↻2h/ }))?.text).toBe('↻2h14m')
  expect((await ui.find({ type: 'Text', text: /^↻3d/ }))?.text).toBe('↻3d2h')
  // 92.5% used with 55% of the 5-hour window gone is over pace; 41% with 56% of the week gone is under.
  const pace = (await ui.findAll({ type: 'Text', text: /^(▲초과|▼여유)$/ })).map(n => n.text)
  expect(pace).toEqual(['▲초과', '▼여유'])
  await ui.unmount()
})

const measureContext = (state: State, percent: number) => {
  state.pct = percent
  return measureOnly(percent)
}
const measureOnly = (percent: number) => ({
  context: { tokens: percent * 2000, window: 200_000, percent },
  rateLimits: [],
  changed: ['context' as const],
})

test('context at 80% sends one handoff prompt, and re-arms after it drops', async ($, on) => {
  const state: State = { t: 1_000, usd: 0, aborted: [] as string[] }
  engine(on, state)
  on('session.measure', (_: unknown, e: any) => ({ changed: e.changed }))
  const prompts: string[] = []
  on('prompt.submit', (_: unknown, e: any) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.toast', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure(measureContext(state, 62))
  expect(prompts.length).toBe(0)

  await $.session.measure(measureContext(state, 81))
  await $.session.measure(measureContext(state, 85))
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('81%')
  expect(prompts[0]).toContain('HANDOFF.md')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^Handoff requested/ }))?.text).toBe(
    'Handoff requested at 81%',
  )
  expect((await ui.find({ type: 'Text', text: /^170k of 200k/ }))?.text).toBe(
    '170k of 200k · compacts at 167k',
  )
  expect((await ui.find({ type: 'Text', text: /Storm/ }))?.text).toBe(
    '◆ Context  ☇ Storm',
  )
  expect((await ui.find({ type: 'Text', text: /messages 150k/ }))?.text).toBe(
    '■ messages 150k 75%   ─ free space 30k', // a 40-column pane wraps the legend

  )
  await ui.unmount()

  await $.session.measure(measureContext(state, 20))
  await $.session.measure(measureContext(state, 80))
  expect(prompts.length).toBe(2)
})

test('the Handoff button sends the prompt; Auto off stops the automatic one', async ($, on) => {
  const state: State = { t: 1_000, usd: 0, aborted: [] as string[] }
  engine(on, state)
  on('session.measure', (_: unknown, e: any) => ({ changed: e.changed }))
  const prompts: string[] = []
  on('prompt.submit', (_: unknown, e: any) => {
    prompts.push(e.text)
    return { text: e.text }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure(measureContext(state, 40))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ plugin: 'agent-monitor-pane', key: 'auto-handoff' })
  expect((await ui.find({ type: 'Text', text: /^Auto handoff/ }))?.text).toBe(
    'Auto handoff off',
  )
  await $.session.measure(measureContext(state, 90))
  expect(prompts.length).toBe(0)

  await ui.press({ plugin: 'agent-monitor-pane', key: 'handoff' })
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('90%')
  await ui.unmount()
})

test('a subagent shows with its model, steps and cost, and expands to its messages', async ($, on) => {
  const state: State = { t: 1_000, usd: 0, aborted: [] }
  engine(on, state)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('tool.call', () => ({ result: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.messages', () => ({
    value: [{ role: 'assistant', text: 'Found 3 call sites.' }] as any,
  }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'audit', turnId: 'turn-a' })
  await $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: 'find callers',
    description: 'Find callers',
    subagentType: 'Explore',
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  } as any)
  await $.tool.call({ tool: 'Grep', pattern: 'describe(', agentId: 'a1' } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Find callers/ }))?.text).toBe('● Find callers')
  expect((await ui.find({ type: 'Text', text: /Sonnet 5\.5/ }))?.text).toBe(' (Sonnet 5.5)  0s')
  expect((await ui.find({ type: 'Text', text: /1 tools/ }))?.text).toBe(
    '  sub · 1 tools · searching describe(',
  )
  await ui.unmount()

  await $.turn.complete({
    answer: 'done',
    durationMs: 10,
    isAborted: false,
    turnId: 'sub-1',
    agentId: 'a1',
    reason: 'answer',
    usage: {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      model: 'claude-sonnet-5-5',
    },
  } as any)

  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await after.find({ type: 'Text', text: /^spent/ }))?.text).toBe(
    'spent $2.00 · at asked models $2.00 · picker off',
  )
  await after.press({ plugin: 'agent-monitor-pane', key: 'agent-a1' })
  expect((await after.find({ type: 'Text', text: /Found 3 call sites/ }))?.text).toBe(
    '  agent: Found 3 call sites.',
  )
  await after.unmount()
})

test('a background Bash command gets a shell row', async ($, on) => {
  const state: State = { t: 1_000, usd: 0, aborted: [] }
  engine(on, state)
  on('tool.call', () => ({
    result: { backgroundTaskId: 'b1', backgroundOutputPath: '/tmp/x/tasks/b1.output' },
  }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'serve', turnId: 'turn-s' })
  await $.tool.call({
    tool: 'Bash',
    command: 'npm run dev',
    description: 'Start the dev server',
    run_in_background: true,
  } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The run's own step reads ✓ once the command is launched; the shell row runs on.
  expect((await ui.find({ type: 'Text', text: /^● Start the dev server/ }))?.text).toBe(
    '● Start the dev server',
  )
  expect((await ui.find({ type: 'Text', text: /^  sh/ }))?.text).toBe('  sh · running')
  await ui.unmount()
})

test('a foreground codex review shows its model, then its findings', async ($, on) => {
  const state: State = { t: 1_000, usd: 0, aborted: [] }
  engine(on, state)
  on('tool.call', () => ({ result: {} }))
  const toasts: string[] = []
  on('ui.toast', (_: unknown, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.cwd', () => ({ value: '/repo' }))
  on('env.get', () => ({ value: '/home/me' }))
  on('process.run', (_: unknown, e: any) => {
    const argv: string[] = e.argv
    if (argv[0] === 'tail') {
      return { value: { exitCode: 0, stdout: 'Full review comments:\n- [P1] null deref\n- [P2] typo\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'review', turnId: 'turn-r' })
  await $.tool.call({
    tool: 'Bash',
    command: 'codex review --base main -m gpt-6 > review.txt',
  } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^✓ codex review · / }))?.text).toBe(
    '✓ codex review · changes vs main',
  )
  expect((await ui.find({ type: 'Text', text: /^  review/ }))?.text).toBe(
    '  review · gpt-6 · 2 findings (P1, P2)',
  )
  await ui.unmount()
  expect(toasts.at(-1)).toContain('codex review (gpt-6) done')
  expect(toasts.at(-1)).toContain('2 findings (P1, P2)')
})

test('the branch band shows the branch, changes and sync above the prompt', async ($, on) => {
  const state: State = { t: 1_000, usd: 0, aborted: [] }
  engine(on, state)
  on('process.run', (_: unknown, e: any) =>
    e.argv[0] === 'git'
      ? {
          value: {
            exitCode: 0,
            stdout: [
              '# branch.oid 19a9f6e0000',
              '# branch.head feature/pane',
              '# branch.upstream origin/feature/pane',
              '# branch.ab +2 -1',
              '1 .M N... 100644 100644 100644 a b README.md',
              '? notes.txt',
            ].join('\n'),
            stderr: '',
            isStdoutTruncated: false,
            isStderrTruncated: false,
          },
        }
      : { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } },
  )

  // The engine's own row above the prompt, beneath the plugin.
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({
    plugin: 'agent-monitor-pane',
    component: 'AbovePrompt',
    surface: 'desktop',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80 },
  } as any)
  expect((await band.find({ type: 'Text', text: /⎇/ }))?.text).toBe(' ⎇ feature/pane ')
  expect((await band.find({ type: 'Text', text: /changed/ }))?.text).toBe('● 2 changed')
  expect((await band.find({ type: 'Text', text: /↑/ }))?.text).toBe('↑2 ↓1')
  expect((await band.find({ type: 'Text', text: /engine row/ }))?.text).toBe('engine row')
  await band.unmount()
})

test('no mark walks the bottom row while work runs', async ($, on) => {
  const state: State = { t: 1_000, usd: 0, aborted: [] }
  const clock = engine(on, state)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'work', turnId: 'turn-m' })
  await clock.advance(2_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.findAll({ type: 'Text', text: /✻/ })).toHaveLength(0)
  await ui.unmount()
})

const ymd = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

test('worked today is the union of every session: time worked at once counts once', async ($, on) => {
  const noon = new Date(2026, 9, 31, 12, 0, 0).getTime()
  const min = 60_000
  const state: State = { t: noon, usd: 0, aborted: [] }
  const clock = engine(on, state)
  on('session.id', () => ({ value: 'me' }))
  // The cross-session store, in memory, so the test can read what was kept.
  const store = new Map<string, unknown>([
    // another session worked 11:30-12:10 (its last 10 minutes overlap ours below)
    [`worked:${ymd(noon)}:other`, [[noon - 30 * min, noon + 10 * min]]],
    ['worked:2026-08-01:old', [[0, 1]]], // past the month kept: pruned
    [`worked:${ymd(noon)}:legacy`, 1_800_000], // an earlier version's total: pruned
  ])
  on('store.get', (_: unknown, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_: unknown, e: any) => (store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  const worked = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const total = (await ui.find({ type: 'Text', text: /^\d+(h \d\dm|m)$/ }))?.text
    const split = (await ui.find({ type: 'Text', text: /^this session/ }))?.text
    await ui.unmount()
    return [total, split]
  }

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(store.has('worked:2026-08-01:old')).toBe(false)
  expect(store.has(`worked:${ymd(noon)}:legacy`)).toBe(false)
  // 11:30-12:00 so far (the other session's span is clipped to now)
  expect(await worked()).toEqual(['30m', 'this session 0m · 1 other session, overlap counted once'])

  // We work 12:00-12:45; the other session's 12:00-12:10 lies inside it.
  await $.turn.start({ text: 'work', turnId: 'turn-w' })
  expect(store.get('working:me')).toEqual({ since: noon, beat: noon })
  for (let m = 0; m < 45; m++) await clock.advance(min) // a minute at a time: the timers tick inside
  expect(await worked()).toEqual(['1h 15m', 'this session 45m · 1 other session, overlap counted once'])

  await $.turn.complete({ answer: '', durationMs: 45 * min, isAborted: false, turnId: 'turn-w', reason: 'answer' })
  expect(store.get(`worked:${ymd(noon)}:me`)).toEqual([[noon, noon + 45 * min]])
  expect(store.has('working:me')).toBe(false)
  // 11:30-12:45 in all: 75 minutes, not 40 + 45 = 85
  expect(await worked()).toEqual(['1h 15m', 'this session 45m · 1 other session, overlap counted once'])
})

test('another session running now counts live, and up to its last heartbeat once it stops', async ($, on) => {
  const noon = new Date(2026, 9, 31, 12, 0, 0).getTime()
  const state: State = { t: noon, usd: 0, aborted: [] }
  const clock = engine(on, state)
  on('session.id', () => ({ value: 'me' }))
  const store = new Map<string, unknown>([['working:other', { since: noon - 20 * 60_000, beat: noon }]])
  on('store.get', (_: unknown, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_: unknown, e: any) => (store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  const total = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const text = (await ui.find({ type: 'Text', text: /^\d+(h \d\dm|m)$/ }))?.text
    await ui.unmount()
    return text
  }

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(await total()).toBe('20m')
  await clock.advance(5 * 60_000) // no heartbeat for 5 minutes: that session stopped at noon
  expect(await total()).toBe('20m')
})

// The installed plugin.json says `installed`; the marketplace's says `latest`,
// returned as the git read's result for a `process.run` hook to give back.
const releases = (on: any, installed: string, latest: string) => {
  on('fs.read', (_: unknown, e: any) =>
    e.path.endsWith('.claude-plugin/plugin.json') ? { value: JSON.stringify({ version: installed }) } : undefined,
  )
  return (argv: readonly string[]) =>
    argv[2]?.includes('FETCH_HEAD:pane/.claude-plugin/plugin.json')
      ? { exitCode: 0, stdout: JSON.stringify({ version: latest }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      : undefined
}

test('Update stays off with the newest pane installed', async ($, on) => {
  const state: State = { t: 1_000, usd: 0, aborted: [] }
  engine(on, state)
  const latest = releases(on, '0.2.2', '0.2.2')
  on('process.run', (_: unknown, e: any) => {
    const res = latest(e.argv)
    return { value: res ?? { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^v0\.2/ }))?.text).toBe('v0.2.2')
  expect(await ui.find({ type: 'Button', key: 'self-update' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: 'Update' }))?.text).toBe('Update')
  await ui.unmount()
})

test('Update pulls the latest pane and says a new session applies it', async ($, on) => {
  const state: State = { t: 1_000, usd: 0, aborted: [] }
  engine(on, state)
  const ran: string[][] = []
  const latest = releases(on, '0.2.0', '0.2.1')
  on('process.run', (_: unknown, e: any) => {
    ran.push(e.argv)
    const res = latest(e.argv)
    if (res) return { value: res }
    const isUpdate = e.argv[0] === '/bin/zsh'
    return {
      value: {
        exitCode: isUpdate ? 0 : 1,
        stdout: isUpdate ? '✔ Plugin "agent-monitor-pane" updated from 0.2.0 to 0.2.1\n' : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^v0\.2\.0/ }))?.text).toBe('v0.2.0 → v0.2.1')
  await ui.press({ plugin: 'agent-monitor-pane', key: 'self-update' })

  const update = ran.find(a => a[0] === '/bin/zsh' && a[2]?.includes('plugin update'))
  expect(update?.[2]).toContain('claude plugin marketplace update agent-monitor')
  expect(update?.[2]).toContain('claude plugin update agent-monitor-pane@agent-monitor')
  expect((await ui.find({ type: 'Text', text: /new session/ }))?.text).toBe(
    '✔ Plugin "agent-monitor-pane" updated from 0.2.0 to 0.2.1 · Open a new session to apply.',
  )
  await ui.unmount()
})
