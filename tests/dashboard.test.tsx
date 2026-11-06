import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { UsageSummary } from '../types'

// A scanner result with made-up figures, shaped as scripts/scan.mjs prints it.
const totals = (input: number, output: number, cacheWrite: number, cacheRead: number, replies: number) => ({
  input,
  output,
  cacheWrite,
  cacheRead,
  total: input + output + cacheWrite + cacheRead,
  replies,
})

const FIXTURE: UsageSummary = {
  generatedAt: 1_700_000_000_000,
  configDir: '/home/test/.claude',
  trackingSince: '2026-01-10T00:00:00.000Z',
  since: '2026-01-01T09:00:00.000Z',
  latest: '2026-01-10T09:00:00.000Z',
  files: 12,
  goneFiles: 0,
  sessions: 11,
  projects: 4,
  all: totals(1_000, 2_000_000, 40_000_000, 1_200_000_000, 900),
  week: totals(100, 300_000, 2_000_000, 50_000_000, 120),
  today: totals(10, 20_000, 100_000, 3_000_000, 15),
  last7: [
    { date: '2026-01-04', total: 0, label: 'Su' },
    { date: '2026-01-05', total: 1_000_000, label: 'Mo' },
    { date: '2026-01-06', total: 9_000_000, label: 'Tu' },
    { date: '2026-01-07', total: 0, label: 'We' },
    { date: '2026-01-08', total: 30_000_000, label: 'Th' },
    { date: '2026-01-09', total: 9_000_000, label: 'Fr' },
    { date: '2026-01-10', total: 3_120_010, label: 'Sa' },
  ],
  models: [{ model: 'claude-opus-5-5', total: 1_100_000_000, replies: 800, share: 0.9 }],
  topDay: { date: '2026-01-02', total: 400_000_000, label: 'Fri 2 Jan 2026' },
  tools: [{ name: 'Bash', count: 300 }],
  toolCalls: 1_000,
  current: { sessionId: 'sess-1', ...totals(5, 4_000, 50_000, 900_000, 7) },
  display: { since: '1 Jan 2026', trackingSince: '10 Jan 2026', generated: '09:00:05' },
  scan: { ms: 40, changedFiles: 1, bytesRead: 1_000 },
}

const PLACED = {
  plugin: 'lifetime-usage-dashboard',
  component: 'Placed',
  requestId: 'row-top',
  props: { id: 'top', plugin: 'lifetime-usage-dashboard' },
} as const

const SURFACES = ['terminal', 'desktop'] as const

// The command as a person types it at the prompt.
const typed = (args: string) =>
  ({
    command: 'usage-dashboard',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  }) as const

type Ran = { exitCode: number; stdout: string; stderr: string }
const SCAN_OK: Ran = { exitCode: 0, stdout: JSON.stringify(FIXTURE), stderr: '' }

type PlaceAnswer =
  | { isPlaced: true; requestId: string }
  | { isPlaced: false; requestId?: string; reason: string }

// Stands for the engine beneath the mod; the scanner answers `ran`, and each
// command line it was started with is recorded in `argv`. `place` is how the
// engine answers a placed row; `surfaces` is the roster of attached windows.
function engine(
  on: On,
  ran: Ran,
  argv: string[][] = [],
  place: PlaceAnswer = { isPlaced: true, requestId: 'row-top' },
  surfaces: ('terminal' | 'desktop')[] = [],
) {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  let places = 0
  mock.store(on)
  on('command.register', () => ({ value: { command: 'usage-dashboard' } }))
  on('ui.place', () => {
    places += 1
    return { value: place }
  })
  on('session.surfaces', () => ({ value: [...surfaces] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 60_000, window: 200_000, percent: 30 },
      rateLimits: [],
      cost: { usd: 1.25 },
    },
  }))
  on('process.run', (_, e) => {
    argv.push([...e.argv])
    return { value: { ...ran, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('session.attach', (_, e) => {
    surfaces.push(e.surface as 'desktop')
    return { clientId: e.clientId }
  })
  on('session.detach', (_, e) => {
    surfaces.splice(surfaces.indexOf(e.surface as 'desktop'), 1)
    return { clientId: e.clientId }
  })

  return { clock, places: () => places }
}

test('the desktop app gets the card: placed at start, kept fresh while its window is attached', async ($, on) => {
  const argv: string[][] = []
  const world = engine(on, SCAN_OK, argv, {
    isPlaced: false,
    requestId: 'row-top',
    reason: 'no surface is attached yet',
  })

  // How the desktop app starts the engine: an SDK host, nothing drawing yet.
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await world.clock.settle()
  expect(world.places()).toBe(1)
  expect(argv.length).toBe(1)

  // No window yet: no 30-second timer.
  await world.clock.advance(31_000)
  expect(argv.length).toBe(1)

  // The window attaches: one refresh at once, then one every 30 seconds.
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await world.clock.settle()
  expect(argv.length).toBe(2)
  await world.clock.advance(30_000)
  expect(argv.length).toBe(3)
  expect(world.places()).toBe(1)

  const ui = await $.ui.mount({ ...PLACED, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^1\.24B$/ }))?.text).toBe('1.24B')
  expect(await ui.find({ type: 'Text', text: /auto-refresh every 30s/ })).toBeDefined()
  await ui.unmount()

  // The window closes: the timer stops until one attaches again.
  await $.session.detach({ surface: 'desktop', clientId: 'desktop:default', reason: 'detach' })
  await world.clock.advance(90_000)
  expect(argv.length).toBe(3)
})

// The band above the prompt, as a surface asks for it.
const bandOn = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'lifetime-usage-dashboard',
    component: 'AbovePrompt',
    requestId: 'band',
    surface,
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 40,
      bodyColumns: 96,
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

// A message as the desktop app sends it; other origins are not a person typing.
const said = (text: string, kind: 'sdk' | 'task-notification' = 'sdk') =>
  ({ text, wait: false, origin: { kind } }) as const

const turnEnds = (agentId?: string) =>
  ({
    answer: 'ok',
    durationMs: 10,
    isAborted: false,
    turnId: `turn-${agentId ?? 'main'}`,
    reason: 'answer',
    ...(agentId === undefined ? {} : { agentId }),
  }) as const

test('the desktop app shows the compact card above the prompt until the second message', async ($, on) => {
  const world = engine(on, SCAN_OK)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await world.clock.settle()

  // A new session: the compact card, the chart left to the pane.
  let ui = await $.ui.mount(bandOn('desktop'))
  expect((await ui.find({ type: 'Text', text: /^1\.24B$/ }))?.text).toBe('1.24B')
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Last 7 days/ })).toBeUndefined()
  expect(
    await ui.find({ type: 'Text', text: /All time = Code \+ Cowork history since 1 Jan 2026, cache included · updated 09:00:05/ }),
  ).toBeDefined()
  await ui.unmount()

  // It stays through the first reply; a subagent's end or a background task's
  // notice changes nothing either.
  await $.turn.complete(turnEnds('agent-1'))
  await $.turn.complete(turnEnds())
  await $.prompt.submit(said('a task finished', 'task-notification'))
  ui = await $.ui.mount(bandOn('desktop'))
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
  await ui.unmount()

  // The next message folds it to one line.
  await $.prompt.submit(said('next'))
  ui = await $.ui.mount(bandOn('desktop'))
  expect(await ui.find({ key: 'expand' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^1\.24B$/ })).toBeUndefined()

  // Show opens it again, and it stays open through later messages.
  await ui.press({ key: 'expand' })
  await ui.unmount()
  await $.prompt.submit(said('more'))
  await $.turn.complete(turnEnds())
  ui = await $.ui.mount(bandOn('desktop'))
  expect((await ui.find({ type: 'Text', text: /^1\.24B$/ }))?.text).toBe('1.24B')
  await ui.unmount()
})

test('a window coming back restarts the timer', async ($, on) => {
  const argv: string[][] = []
  const world = engine(on, SCAN_OK, argv)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await $.session.detach({ surface: 'desktop', clientId: 'desktop:default', reason: 'detach' })
  await world.clock.advance(60_000)
  const stopped = argv.length

  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await world.clock.settle()
  expect(argv.length).toBe(stopped + 1)
  await world.clock.advance(30_000)
  expect(argv.length).toBe(stopped + 2)
})

test('the terminal leaves the band to the engine: its card is the row at the top', async ($, on) => {
  engine(on, SCAN_OK)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(bandOn('terminal'))
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  expect(await ui.find({ key: 'refresh' })).toBeUndefined()
  await ui.unmount()
})

test('a terminal session keeps the card fresh from the start', async ($, on) => {
  const argv: string[][] = []
  const world = engine(on, SCAN_OK, argv, { isPlaced: true, requestId: 'row-top' }, ['terminal'])

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await world.clock.settle()
  expect(argv.length).toBe(1)
  await world.clock.advance(30_000)
  expect(argv.length).toBe(2)
})

test('a new session draws the scanned history, live context and session figures', async ($, on) => {
  const argv: string[][] = []
  engine(on, SCAN_OK, argv)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(typed('refresh'))

  expect(argv.length).toBeGreaterThan(0)
  expect(argv[0]?.[0]).toBe('node')
  expect(argv[0]).toContain('--session')
  expect(argv[0]).toContain('sess-1')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PLACED, surface })
    expect((await ui.find({ type: 'Text', text: /^1\.24B$/ }))?.text).toBe('1.24B')
    expect((await ui.find({ type: 'Text', text: /^52\.3M$/ }))?.text).toBe('52.3M')
    expect((await ui.find({ type: 'Text', text: /^3\.12M$/ }))?.text).toBe('3.12M')
    expect(await ui.find({ type: 'Text', text: /Opus 5\.5 · 90% of tokens/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Fri 2 Jan 2026 · 400M tokens/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Bash · 300 calls \(30% of 1,000\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /954k tokens .* ≈ \$1\.25 at API prices/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /60\.0k of 200k used · 70% left/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /available Code and Cowork history since 1 Jan 2026/ })).toBeDefined()
    await ui.unmount()
  }
})

test('one reply reads "1 reply"', async ($, on) => {
  const one = { ...FIXTURE, current: { ...FIXTURE.current!, replies: 1 } }
  engine(on, { ...SCAN_OK, stdout: JSON.stringify(one) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(typed('refresh'))

  const ui = await $.ui.mount({ ...PLACED, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /· 1 reply · ≈/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 replies/ })).toBeUndefined()
  await ui.unmount()
})

test('Hide collapses the card to one line and Show brings it back', async ($, on) => {
  engine(on, SCAN_OK)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(typed('refresh'))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PLACED, surface })
    await ui.press({ key: 'hide' })
    expect(await ui.find({ key: 'expand' })).toBeDefined()
    expect(await ui.find({ key: 'refresh' })).toBeUndefined()
    await ui.press({ key: 'expand' })
    expect(await ui.find({ key: 'refresh' })).toBeDefined()
    await ui.unmount()
  }
})

test('a failing scan says Not available instead of showing numbers', async ($, on) => {
  engine(on, { exitCode: 1, stdout: '', stderr: 'Error: EACCES reading projects\n  at x' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(typed('refresh'))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PLACED, surface })
    expect(
      await ui.find({ type: 'Text', text: /History: Not available \(Error: EACCES reading projects\)/ }),
    ).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^Not available$/ }))?.text).toBe('Not available')
    expect(await ui.find({ type: 'Text', text: /^1\.24B$/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the pane variant opens and draws the same dashboard', async ($, on) => {
  engine(on, SCAN_OK)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const opened = await $.command.run(typed('pane'))
  expect(opened.text).toBe('Usage dashboard opened in a pane.')
  await $.command.run(typed('refresh'))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'lifetime-usage-dashboard',
      component: 'Pane',
      requestId: 'usage-dashboard',
      surface,
      props: {
        title: 'Usage',
        isFocused: false,
        bodyColumns: 50,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 30 },
        view: {},
      },
    })
    expect((await ui.find({ type: 'Text', text: /^1\.24B$/ }))?.text).toBe('1.24B')
    await ui.unmount()
  }
})

test("another plugin's placed row is left to it", async ($, on) => {
  engine(on, SCAN_OK)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({
    plugin: 'lifetime-usage-dashboard',
    component: 'Placed',
    requestId: 'row-other',
    surface: 'desktop',
    props: { id: 'x', plugin: 'someone-else' },
  })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})
