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

test('a run shows its steps, cost and status', { options: { billing: 'metered' } }, async ($, on) => {
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
  expect((await ui.findAll({ type: 'Text', text: /\$0\./ })).map(n => n.text)).toContain('$0.036')
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

test('Usage sits at the top of the pane, above the model, idle and while running', async ($, on) => {
  const state: State = { t: Date.parse('2026-10-31T10:00:00Z'), usd: 0, aborted: [] as string[] }
  engine(on, state)
  on('session.measure', (_: unknown, e: any) => ({ changed: e.changed }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({
    context: {} as any,
    rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: '2026-10-31T12:00:00Z' }],
    changed: ['rateLimits'],
  })
  const order = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const texts = (await ui.findAll({ type: 'Text', text: /^(5-hour|Claude Opus 5\.5)$/ })).map(
      n => n.text,
    )
    await ui.unmount()
    return texts.filter((s, i) => texts.indexOf(s) === i)
  }

  expect(await order()).toEqual(['5-hour', 'Claude Opus 5.5'])

  await $.turn.start({ text: 'ship it', turnId: 'turn-1' })
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'Listing files' } as any)
  expect(await order()).toEqual(['5-hour', 'Claude Opus 5.5'])
})

test('Fixed-height groups sit above the turn, Activity below it, each behind a divider', async ($, on) => {
  const state: State = { t: Date.parse('2026-10-31T10:00:00Z'), usd: 0, aborted: [] as string[] }
  engine(on, state)
  on('session.measure', (_: unknown, e: any) => ({ changed: e.changed }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const order = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const texts = (
      await ui.findAll({ type: 'Text', text: /^(── \S.*|Claude Opus 5\.5|Spend|Worked today|Context)$/ })
    ).map(n => n.text.replace(/ ─+$/, ''))
    await ui.unmount()
    return texts.filter((s, i) => texts.indexOf(s) === i)
  }

  const expected = ['── Cost & time', 'Spend', 'Worked today', '── Context', 'Context', '── This turn', 'Claude Opus 5.5']
  expect(await order()).toEqual(expected)

  await $.turn.start({ text: 'ship it', turnId: 'turn-1' })
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'Listing files' } as any)
  expect(await order()).toEqual([...expected, '── Activity'])
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

test('a subagent row shows its task list, waiting, and its result', async ($, on) => {
  const state: State = { t: 1_000, usd: 0, aborted: [] }
  const clock = engine(on, state)
  let stand = 'running'
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a2' }))
  on('agent.list', () => ({
    value: [{ id: 'a2', description: 'Audit hooks', type: 'general-purpose', status: stand }] as any,
  }))
  on('tool.call', () => ({ result: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'audit the hooks' }] as any }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'audit', turnId: 'turn-b' })
  await $.agent.spawn({
    tool_use_id: 'tu2',
    prompt: 'audit the hooks',
    description: 'Audit hooks',
    subagentType: 'general-purpose',
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  } as any)
  await $.tool.call({
    tool: 'TodoWrite',
    agentId: 'a2',
    todos: [
      { content: 'Read register.tsx', status: 'completed' },
      { content: 'Check the tests', status: 'in_progress' },
      { content: 'Write the report', status: 'pending' },
    ],
  } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /1\/3/ }))?.text).toBe('  ███░░░░░ 1/3 · Check the tests')
  await ui.unmount()

  stand = 'waiting'
  await clock.advance(1_000)
  const held = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await held.find({ type: 'Text', text: /Audit hooks/ }))?.text).toBe('◐ Audit hooks')
  expect((await held.find({ type: 'Text', text: /waiting/ }))?.text).toContain('waiting')
  await held.unmount()

  await $.turn.complete({
    answer: 'All hooks pass.\nOne nit in tests.',
    durationMs: 10,
    isAborted: false,
    turnId: 'sub-2',
    agentId: 'a2',
    reason: 'answer',
  } as any)

  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await after.find({ type: 'Text', text: /↳/ }))?.text).toBe('  ↳ All hooks pass. One nit in tests.')
  await after.press({ plugin: 'agent-monitor-pane', key: 'agent-a2' })
  expect((await after.find({ type: 'Text', text: /^All hooks pass/ }))?.text).toBe('All hooks pass.\nOne nit in tests.')
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

test('the branch band shows the repository, branch, changes and sync above the prompt', async ($, on) => {
  const state: State = { t: 1_000, usd: 0, aborted: [] }
  engine(on, state)
  const out = (stdout: string) => ({
    value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  on('process.run', (_: unknown, e: any) =>
    e.argv[1] === 'remote'
      ? out('git@github.com:someone/agent-monitor.git\n')
      : e.argv[1] === 'rev-parse'
        ? out('/repo\n')
        : e.argv[0] === 'git'
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
  expect((await band.find({ type: 'Text', text: 'agent-monitor' }))?.text).toBe('agent-monitor')
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

test('the bottom bar follows the task list, and sweeps while a turn has none', async ($, on) => {
  const state: State = { t: 1_000, usd: 0, aborted: [] }
  const clock = engine(on, state)
  on('tool.call', () => ({ result: {} }))
  const bar = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const text = (await ui.find({ type: 'Text', text: /^[█▓▒░]+$/ }))?.text
    const label = (await ui.find({ type: 'Text', text: /^ (\d+ steps|\d+\/\d+ · \d+%)$/ }))?.text
    await ui.unmount()
    return { text, label }
  }

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'work', turnId: 'turn-p' })
  const first = await bar()
  expect(first.label).toBe(' 0 steps')
  await clock.advance(1_000)
  expect((await bar()).text).not.toBe(first.text)

  const items = ['a', 'b', 'c', 'd'].map((content, i) => ({ content, status: i === 0 ? 'in_progress' : 'pending' }))
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items } as any)
  expect((await bar()).label).toBe(' 0/4 · 13%')
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true } as any)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', done: [2] } as any)
  expect((await bar()).label).toBe(' 2/4 · 50%')
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'x', status: 'completed' }, { content: 'y', status: 'in_progress' }] } as any)
  expect((await bar()).label).toBe(' 1/2 · 75%')
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

// git answers for the branch band: `name` on origin someone/agent-monitor, clean.
const gitFor = (name: string) => (argv: readonly string[]) => {
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  if (argv[0] !== 'git') return undefined
  if (argv[1] === 'remote') return ok('git@github.com:someone/agent-monitor.git\n')
  if (argv[1] === 'rev-parse') return ok('/repo\n')
  return ok(['# branch.oid 19a9f6e0000', `# branch.head ${name}`, '# branch.upstream origin/x', '# branch.ab +0 -0'].join('\n'))
}

const BAND = (bodyColumns: number) =>
  ({
    plugin: 'agent-monitor-pane',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns },
  }) as any

test('a long branch name is cut with ... so the Graft button stays on the branch row', async ($, on) => {
  const state: State = { t: 1_000, usd: 0, aborted: [] }
  engine(on, state)
  // The engine's own row above the prompt, beneath the plugin.
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
  const long = 'feature/a-very-long-branch-name-that-would-push-the-button-down'
  const git = gitFor(long)
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', () => ({ value: true }))
  on('process.run', (_: unknown, e: any) => ({
    value: git(e.argv) ?? { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount(BAND(70))
  const pill = (await band.find({ type: 'Text', text: /⎇/ }))?.text ?? ''
  expect(pill.endsWith('... ')).toBe(true)
  expect(pill.length).toBeLessThan(long.length)
  // repo + pill + state + sync + `[ Graft Update ]`, one cell between each, fits the row.
  const row = ['agent-monitor', pill, '✓ clean', 'up to date', '[ Graft Update ]'].join(' ')
  expect(row.length).toBeLessThanOrEqual(70)
  expect(await band.find({ type: 'Button', key: 'graft-update' })).toBeTruthy()

  await band.unmount()
})

test('a short branch name is drawn whole, and Graft Init shows before any graph', async ($, on) => {
  const state: State = { t: 1_000, usd: 0, aborted: [] }
  engine(on, state)
  // The engine's own row above the prompt, beneath the plugin.
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
  const git = gitFor('main')
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', () => ({ value: false }))
  on('process.run', (_: unknown, e: any) => ({
    value: git(e.argv) ?? { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount(BAND(70))
  expect((await band.find({ type: 'Text', text: /⎇/ }))?.text).toBe(' ⎇ main ')
  expect(await band.find({ type: 'Button', key: 'graft-init' })).toBeTruthy()
  expect(await band.find({ type: 'Button', key: 'graft-update' })).toBeFalsy()
  await band.unmount()
})

test('Graft Update runs graphify update in the session folder and says what changed', async ($, on) => {
  const state: State = { t: 1_000, usd: 0, aborted: [] }
  engine(on, state)
  // The engine's own row above the prompt, beneath the plugin.
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
  const ran: { argv: string[]; cwd?: string }[] = []
  const toasts: string[] = []
  const git = gitFor('main')
  on('session.cwd', () => ({ value: '/repo' }))
  on('ui.toast', (_: unknown, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', (_: unknown, e: any) => ({ value: e.path === '/repo/graphify-out/graph.json' }))
  on('process.run', (_: unknown, e: any) => {
    ran.push({ argv: e.argv, cwd: e.init?.cwd })
    const isGraft = e.argv[0] === '/bin/zsh' && e.argv[2] === 'graphify update'
    return {
      value: isGraft
        ? {
            exitCode: 0,
            stdout: 'Re-extracting code files in . (no LLM needed)...\n[graphify watch] Rebuilt: 72 nodes, 85 edges, 7 communities\n[graphify watch] graph.json, graph.html and GRAPH_REPORT.md updated in graphify-out\nCode graph updated. For doc/paper/image changes run /graphify --update in your AI assistant.\nTip: set GEMINI_API_KEY\n',
            stderr: '',
            isStdoutTruncated: false,
            isStderrTruncated: false,
          }
        : (git(e.argv) ?? { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }),
    }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount(BAND(100))
  await band.press({ plugin: 'agent-monitor-pane', key: 'graft-update' })

  const graft = ran.find(r => r.argv[2] === 'graphify update')
  expect(graft?.argv).toEqual(['/bin/zsh', '-lc', 'graphify update'])
  expect(graft?.cwd).toBe('/repo')
  expect(toasts.at(-1)).toBe('✓ Graft Update: Rebuilt: 72 nodes, 85 edges, 7 communities')
  expect(await band.find({ type: 'Button', key: 'graft-update' })).toBeTruthy()
  await band.unmount()
})

test('Graft Init builds the first graph with graphify update . and then turns into Graft Update', async ($, on) => {
  const state: State = { t: 1_000, usd: 0, aborted: [] }
  engine(on, state)
  // The engine's own row above the prompt, beneath the plugin.
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
  const ran: { argv: string[]; cwd?: string }[] = []
  const toasts: string[] = []
  const git = gitFor('main')
  let built = false
  on('session.cwd', () => ({ value: '/repo' }))
  on('ui.toast', (_: unknown, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', (_: unknown, e: any) => ({ value: built && e.path === '/repo/graphify-out/graph.json' }))
  on('process.run', (_: unknown, e: any) => {
    ran.push({ argv: e.argv, cwd: e.init?.cwd })
    const isGraft = e.argv[0] === '/bin/zsh' && e.argv[2]?.startsWith('graphify update')
    if (isGraft) built = true
    return {
      value: isGraft
        ? {
            exitCode: 0,
            stdout: 'Re-extracting code files in . (no LLM needed)...\n[graphify watch] Rebuilt: 72 nodes, 85 edges, 7 communities\nCode graph updated.\n',
            stderr: '',
            isStdoutTruncated: false,
            isStderrTruncated: false,
          }
        : (git(e.argv) ?? { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }),
    }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount(BAND(100))
  expect((await band.find({ type: 'Button', key: 'graft-init' }))?.text).toBe('Graft Init')
  await band.press({ plugin: 'agent-monitor-pane', key: 'graft-init' })

  const init = ran.find(r => r.argv[2]?.startsWith('graphify update'))
  expect(init?.argv).toEqual(['/bin/zsh', '-lc', 'graphify update .'])
  expect(init?.cwd).toBe('/repo')
  expect(toasts.at(-1)).toBe('✓ Graft Init: Rebuilt: 72 nodes, 85 edges, 7 communities')
  expect(await band.find({ type: 'Button', key: 'graft-update' })).toBeTruthy()
  expect(await band.find({ type: 'Button', key: 'graft-init' })).toBeFalsy()
  await band.unmount()
})

const spawn = (agentId: string, extra: Record<string, unknown> = {}) =>
  ({
    tool_use_id: `tu-${agentId}`,
    prompt: `task for ${agentId}`,
    description: `Agent ${agentId}`,
    subagentType: 'general-purpose',
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
    ...extra,
  }) as any

test('a failed tool call shows its error under the step and in Tools', async ($, on) => {
  const state: State = { t: 1_000, usd: 0, aborted: [] }
  engine(on, state)
  on('tool.call', (_: unknown, e: any) =>
    e.command === 'npm test' ? { result: {}, isError: true, text: '\nExit code 1\n2 tests failed' } : { result: {} },
  )

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'test it', turnId: 'turn-t' })
  await $.tool.call({ tool: 'Read', file_path: '/a/b.ts' } as any)
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Running tests' } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^✗ Running tests$/ }))?.text).toBe('✗ Running tests')
  expect((await ui.find({ type: 'Text', text: /^ {2}Exit code 1$/ }))?.text).toBe('  Exit code 1')
  expect((await ui.find({ type: 'Text', text: /^2 calls/ }))?.text).toBe('2 calls · 1 failed')
  expect((await ui.find({ type: 'Text', text: /Bash 1× .*\(1✗\)/ }))).toBeDefined()
  await ui.unmount()
})

test('billing from the setting: a subscription marks costs as estimates', { options: { billing: 'subscription' } }, async ($, on) => {
  const state: State = { t: 1_000, usd: 0.5, aborted: [] }
  engine(on, state)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^Subscription/ }))?.text).toBe(
    'Subscription · API-price estimate, not charged',
  )
  expect((await ui.find({ type: 'Text', text: /^≈\$0\.500$/ }))?.text).toBe('≈$0.500')
  await ui.unmount()
})

test(
  'an enforced budget warns, then runs new subagents on the cheapest model, then asks before a step',
  { options: { billing: 'metered', budgetUsd: 1, budgetEnforce: true } },
  async ($, on) => {
    const state: State = { t: 1_000, usd: 0.5, aborted: [] }
    engine(on, state)
    const toasts: string[] = []
    on('ui.toast', (_: unknown, e: any) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    const spawned: (string | undefined)[] = []
    on('agent.spawn', (_: unknown, e: any) => {
      spawned.push(e.model)
      return { model: e.model ?? 'claude-opus-5-5', agentId: `a${spawned.length}` }
    })
    let answer = 'Stop'
    const asked: string[] = []
    on('tool.call', (_: unknown, e: any) => {
      if (e.tool !== 'AskUserQuestion') return { result: {} }
      asked.push(e.questions[0].question)
      return { result: { questions: e.questions, answers: { [e.questions[0].question]: answer } } }
    })

    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await $.turn.start({ text: 'work', turnId: 'turn-g' })

    state.usd = 0.85
    await $.tool.call({ tool: 'Read', file_path: '/x' } as any)
    expect(toasts.at(-1)).toBe('Budget 80%: $0.85 of $1.00 spent.')

    state.usd = 0.95
    await $.tool.call({ tool: 'Read', file_path: '/y' } as any)
    expect(toasts.at(-1)).toContain('Budget 90%')
    await $.agent.spawn(spawn('1'))
    expect(spawned).toEqual(['haiku'])

    state.usd = 1.02
    await $.tool.call({ tool: 'Read', file_path: '/z' } as any)
    expect(toasts.at(-1)).toBe('Budget $1.00 reached: the next tool call asks first.')
    const stopped = await $.tool.call({ tool: 'Read', file_path: '/w' } as any)
    expect(stopped.deny).toBe('Stopped by Agent Monitor: the session budget is spent.')
    expect(state.aborted).toEqual(['turn-g'])

    answer = 'Continue'
    const went = await $.tool.call({ tool: 'Read', file_path: '/v' } as any)
    expect(went.deny).toBeUndefined()
    await $.tool.call({ tool: 'Read', file_path: '/u' } as any)
    expect(asked.length).toBe(2) // once Stop, once Continue, then no more

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.find({ type: 'Text', text: /% of \$1\.00$/ }))?.text).toBe('102% of $1.00')
    expect((await ui.find({ type: 'Text', text: /^Enforced/ }))?.text).toBe('Enforced · kept going past the budget')
    await ui.unmount()
  },
)

test('a budget without Enforce only warns', { options: { billing: 'metered', budgetUsd: 1 } }, async ($, on) => {
  const state: State = { t: 1_000, usd: 2, aborted: [] }
  engine(on, state)
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'work', turnId: 'turn-w' })
  const ran = await $.tool.call({ tool: 'Read', file_path: '/x' } as any)
  expect(ran.deny).toBeUndefined()
})

test('a subagent spawned by a subagent sits under it, and opens to the task it was given', async ($, on) => {
  const state: State = { t: 1_000, usd: 0, aborted: [] }
  engine(on, state)
  on('agent.spawn', (_: unknown, e: any) => ({ model: 'claude-sonnet-5-5', agentId: e.description === 'Agent p' ? 'p' : 'c' }))
  on('tool.call', () => ({ result: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.messages', () => ({ value: [] as any }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'plan', turnId: 'turn-n' })
  await $.agent.spawn(spawn('p'))
  await $.agent.spawn(spawn('c', { parentAgentId: 'p' }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const names = (await ui.findAll({ type: 'Text', text: /Agent [pc]$/ })).map(n => n.text)
  expect(names).toEqual(['● Agent p', '  └ ● Agent c'])
  await ui.press({ plugin: 'agent-monitor-pane', key: 'agent-c' })
  await ui.unmount()
  const open = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await open.find({ type: 'Text', text: /^task for c$/ }))?.text).toBe('task for c')
  await open.unmount()
})

test('a turn an API error ended says which error', async ($, on) => {
  const state: State = { t: 1_000, usd: 0, aborted: [] }
  engine(on, state)
  on('classic.StopFailure', () => ({}))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'job', turnId: 'turn-e' })
  await $.classic.StopFailure({ error: 'rate_limit' } as any)
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'turn-e', reason: 'error' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^Failed/ }))?.text).toBe('Failed · rate limited')
  await ui.unmount()
})

test('the 7-day line sums the past six days and today, time and cost', async ($, on) => {
  const noon = new Date(2026, 9, 31, 12, 0, 0).getTime()
  const day = 86_400_000
  const hour = 3_600_000
  const state: State = { t: noon, usd: 1, aborted: [] }
  engine(on, state)
  on('session.id', () => ({ value: 'me' }))
  const store = new Map<string, unknown>([
    [`worked:${ymd(noon - 2 * day)}:a`, [[noon - 2 * day, noon - 2 * day + hour]]],
    [`worked:${ymd(noon - 2 * day)}:b`, [[noon - 2 * day + hour / 2, noon - 2 * day + 2 * hour]]], // overlaps a by 30m
    [`spent:${ymd(noon - day)}:a`, 1.5],
    [`worked:${ymd(noon - 9 * day)}:old`, [[noon - 9 * day, noon - 9 * day + hour]]], // outside the week
  ])
  on('store.get', (_: unknown, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_: unknown, e: any) => (store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'work', turnId: 'turn-7' })
  state.usd = 1.25
  state.t = noon + 30 * 60_000
  await $.turn.complete({ answer: '', durationMs: 30 * 60_000, isAborted: false, turnId: 'turn-7', reason: 'answer' })
  expect(store.get(`spent:${ymd(noon)}:me`)).toBe(0.25)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // 2h (overlap once) two days ago + 30m today; $1.50 yesterday + $0.25 today.
  expect((await ui.find({ type: 'Text', text: /^ 2h 30m · / }))?.text).toMatch(/^ 2h 30m · ≈?\$1\.75$/)
  await ui.unmount()
})

test('a task made after a deleted one gets a fresh id, and an unfinished list carries into the next turn', async ($, on) => {
  const state: State = { t: 1_000, usd: 0, aborted: [] }
  engine(on, state)
  on('tool.call', () => ({ result: {} }))
  const label = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const text = (await ui.find({ type: 'Text', text: /^ \d+\/\d+ · \d+%$/ }))?.text
    await ui.unmount()
    return text
  }

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'work', turnId: 'turn-t1' })
  for (const subject of ['a', 'b', 'c']) await $.tool.call({ tool: 'TaskCreate', subject } as any)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'deleted' } as any)
  await $.tool.call({ tool: 'TaskCreate', subject: 'd' } as any) // task 4, not a second 3
  await $.tool.call({ tool: 'TaskUpdate', taskId: '3', status: 'completed' } as any)
  expect(await label()).toBe(' 1/3 · 33%')
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'turn-t1', reason: 'answer' })

  await $.turn.start({ text: 'go on', turnId: 'turn-t2' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '4', status: 'completed' } as any)
  expect(await label()).toBe(' 2/3 · 67%')
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as any)
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'turn-t2', reason: 'answer' })

  // A finished list does not follow into the next turn.
  await $.turn.start({ text: 'new work', turnId: 'turn-t3' })
  expect(await label()).toBeUndefined()
})

test('+N more counts only the rows that could have been listed', async ($, on) => {
  const state: State = { t: 1_000, usd: 0, aborted: [] }
  const clock = engine(on, state)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: `a${++n}` }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.messages', () => ({ value: [] as any }))
  const spawn = () =>
    $.agent.spawn({
      tool_use_id: `tu${n}`,
      prompt: 'look',
      description: `Look ${n + 1}`,
      subagentType: 'Explore',
      parentModel: 'claude-opus-5-5',
      background: false,
      fork: false,
    } as any)
  const more = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const text = (await ui.find({ type: 'Text', text: /^\+\d+ more$/ }))?.text
    await ui.unmount()
    return text
  }

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (let i = 0; i < 7; i++) await spawn()
  for (let i = 1; i <= 7; i++) {
    await $.turn.complete({ agentId: `a${i}`, answer: 'ok', durationMs: 10, isAborted: false, turnId: `t${i}`, reason: 'answer' } as any)
  }
  await clock.advance(31_000)
  expect(await more()).toBe('+1 more') // nothing live: the latest six, one more

  await spawn()
  expect(await more()).toBeUndefined() // one live row listed, the finished ones hidden
})

test('the branch poll asks git for status without optional locks', async ($, on) => {
  const state: State = { t: 1_000, usd: 0, aborted: [] }
  engine(on, state)
  const git = gitFor('main')
  const calls: string[][] = []
  on('process.run', (_: unknown, e: any) => {
    calls.push([...e.argv])
    return { value: git(e.argv) ?? { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const status = calls.filter(a => a[0] === 'git' && a.includes('status'))
  expect(status.length).toBeGreaterThan(0)
  for (const a of status) expect(a.slice(0, 3)).toEqual(['git', '--no-optional-locks', 'status'])
})
