// Lifetime Usage Dashboard
//
// A usage card at the top of every new session: all-time (available history),
// last-7-days and today token totals, the most-used model, the busiest day, the
// most-used tool, this session's tokens and how much context is left.
//
// History comes from scripts/scan.mjs, which reads the Claude Code transcripts
// on this computer. Live context and cost come from $.session.usage(). Nothing
// is estimated or invented: a figure that is missing says "Not available".

import { atom, read, update } from 'claude-code'
import type { Elements, Register, RenderSurface, Timer } from 'claude-code'

import type { UsageLive, UsageStatus, UsageSummary, UsageTotals } from '../types'

const PANE = 'usage-dashboard'
const TOP_ROW = 'top'
const REFRESH_MS = 30_000
const SCAN_TIMEOUT_MS = 300_000
const MAX_WIDTH = 88
const LABEL_WIDTH = 14

// Change a shape tag when that value's fields change: it declines what an
// earlier version stored, which outlives a reload.
const summary = atom({ plugin: 'lifetime-usage-dashboard', key: 'summary' } as const, null, {
  shape: 'summary-1',
})
const live = atom({ plugin: 'lifetime-usage-dashboard', key: 'live' } as const, null, {
  shape: 'live-1',
})
const status = atom(
  { plugin: 'lifetime-usage-dashboard', key: 'status' } as const,
  { isScanning: false, error: null } as UsageStatus,
  { shape: 'status-1' },
)
const isCollapsed = atom({ plugin: 'lifetime-usage-dashboard', key: 'isCollapsed' } as const, false)
const band = atom({ plugin: 'lifetime-usage-dashboard', key: 'band' } as const, 'start')

// Set by session.start: rescans the transcripts and rereads the live figures.
// The timer, a finished turn, the command and the Refresh button all call it.
let refreshNow: (() => Promise<void>) | undefined
// Set by session.start: starts the 30-second timer if it is not running.
let keepFresh: (() => void) | undefined
let ticker: Timer | undefined

export const register: Register = on => {
  // Every session start, the terminal's and the desktop app's alike. The
  // desktop app runs the engine as an SDK host, so `e.isInteractive` is false
  // there and nothing draws until its window attaches (session.attach below).
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-dashboard',
      description:
        'Show the lifetime usage dashboard ("pane" docks it beside the chat, "refresh" rescans now)',
      argumentHint: '[pane | refresh]',
    })
    const stored = await $.store.get('isCollapsed')
    if (typeof stored === 'boolean') await update($, isCollapsed, () => stored)

    let isScanning = false
    let isScanQueued = false

    const scanOnce = async (): Promise<void> => {
      await update($, status, s => ({ ...s, isScanning: true }))
      try {
        const sessionId = await $.session.id()
        const script = `${$.plugin.root}/scripts/scan.mjs`
        let stdout: string | undefined
        let reason = 'Node.js or Bun was not found on PATH, and one is needed to read the transcripts'
        for (const exe of ['node', 'bun']) {
          let ran
          try {
            ran = await $.process.run([exe, script, '--session', sessionId], {
              timeoutMs: SCAN_TIMEOUT_MS,
            })
          } catch {
            continue // this runtime is not installed: try the next
          }
          if (ran.exitCode === 0 && !ran.isStdoutTruncated) stdout = ran.stdout
          else reason = firstLine(ran.stderr) || `the scanner exited with code ${ran.exitCode}`
          break
        }
        if (stdout === undefined) throw new Error(reason)
        const fresh = JSON.parse(stdout) as UsageSummary
        await update($, summary, () => fresh)
        await update($, status, () => ({ isScanning: false, error: null }))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await update($, status, () => ({ isScanning: false, error: message.slice(0, 240) }))
      }
    }

    // One scan at a time; a request that arrives during a scan runs once after.
    const rescan = async (): Promise<void> => {
      if (isScanning) {
        isScanQueued = true
        return
      }
      isScanning = true
      try {
        do {
          isScanQueued = false
          await scanOnce()
        } while (isScanQueued)
      } finally {
        isScanning = false
      }
    }

    const readLive = async (): Promise<void> => {
      try {
        const [usage, model] = await Promise.all([$.session.usage(), $.session.model()])
        await update($, live, () => ({
          contextTokens: usage.context.tokens ?? null,
          contextWindow: usage.context.window ?? null,
          contextPercent: usage.context.percent ?? null,
          costUsd: usage.cost?.usd ?? null,
          model,
        }))
      } catch (err) {
        // The live figures keep their last reading; say why in the debug log.
        $.ui.log(`live usage not read: ${err instanceof Error ? err.message : String(err)}`, {
          to: 'debug',
        })
      }
    }

    // The card at the top. A row placed before a surface attaches still stands
    // (it carries a requestId) and is drawn on attach; one that does not stand
    // is placed again on the next refresh, until one does.
    let isRowPlaced = false
    const placeRow = async (): Promise<void> => {
      if (isRowPlaced) return
      try {
        const placed = await $.ui.place({ id: TOP_ROW })
        if (placed.isPlaced || placed.requestId !== undefined) isRowPlaced = true
        else $.ui.log(`dashboard row not placed yet: ${placed.reason}`, { to: 'debug' })
      } catch (err) {
        $.ui.log(`dashboard row not placed: ${err instanceof Error ? err.message : String(err)}`, {
          to: 'debug',
        })
      }
    }

    refreshNow = async () => {
      await Promise.all([placeRow(), rescan(), readLive()])
    }

    ticker?.cancel()
    ticker = undefined
    keepFresh = () => {
      if (ticker === undefined) ticker = $.clock.every(REFRESH_MS, () => void refreshNow?.())
    }

    // The row is placed and the history read now in every session, so the card
    // is ready when a window draws it. The timer runs only while someone can
    // see it: from the start under the terminal, from attach in the desktop
    // app, and never in a headless -p run.
    if (e.isInteractive) keepFresh()
    void refreshNow()

    return next(e)
  })

  // The desktop app's window (or a phone) attached: draw fresh figures and
  // keep them fresh while it watches.
  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    keepFresh?.()
    void refreshNow?.()

    return result
  })

  // The last window left: stop the timer until one attaches again.
  on('session.detach', async ($, e, next) => {
    const result = await next(e)
    if ((await $.session.surfaces()).length === 0) {
      ticker?.cancel()
      ticker = undefined
    }

    return result
  })

  // A finished turn wrote new usage to the transcript: rescan shortly after.
  // The desktop app starts a session only with its first message, so the band
  // stays full through the first reply and folds when the next message goes.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (refreshNow) $.clock.after(1_500, () => void refreshNow?.())
    if (e.agentId === undefined) await update($, band, b => (b === 'start' ? 'replied' : b))

    return result
  })

  // A person's message: typed here, through the bridge, or from the desktop app
  // (which sends as an SDK host). A background task's notice folds nothing.
  on('prompt.submit', async ($, e, next) => {
    const isPerson = ['composer', 'bridge', 'sdk'].includes(e.origin.kind) && !e.isMeta
    if (isPerson) await update($, band, b => (b === 'replied' ? 'folded' : b))

    return next(e)
  })

  // The status line's figures moved (context fill, cost): show them at once.
  on('session.measure', async ($, e, next) => {
    await update($, live, prev => ({
      contextTokens: e.context.tokens ?? null,
      contextWindow: e.context.window ?? null,
      contextPercent: e.context.percent ?? null,
      costUsd: e.cost?.usd ?? prev?.costUsd ?? null,
      model: prev?.model ?? null,
    }))

    return next(e)
  })

  on('command.run', { command: 'usage-dashboard' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'refresh') {
      await refreshNow?.()
      return { text: 'Usage dashboard refreshed.' }
    }

    if (arg === 'pane') {
      const opened = await $.ui.open({ id: PANE, title: 'Usage' })
      void refreshNow?.()
      return {
        text: opened.isPlaced
          ? 'Usage dashboard opened in a pane.'
          : `The usage pane is waiting to be shown: ${opened.reason}`,
      }
    }

    await update($, isCollapsed, () => false)
    await $.store.set('isCollapsed', false)
    await update($, band, () => 'open')
    await $.ui.place({ id: `shown-${Math.floor(await $.clock.now())}` })
    void refreshNow?.()
    return { text: 'Usage dashboard shown.' }
  })

  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    if (e.props.plugin !== 'lifetime-usage-dashboard') return next(e)

    const ui = $.ui.resolve(e)
    const model: Model = {
      data: await read($, summary),
      now: await read($, live),
      state: await read($, status),
      collapsed: await read($, isCollapsed),
    }
    const actions: Actions = {
      refresh: () => void refreshNow?.(),
      setCollapsed: value => {
        void update($, isCollapsed, () => value)
        void $.store.set('isCollapsed', value)
      },
    }

    return view(ui, model, actions, Math.max(28, (e.viewport?.columns ?? 100) - 2), true)
  })

  // The desktop app draws no transcript rows from mods (only the band above
  // the prompt and panes), so there the card lives in this band: the compact
  // card (the desktop gives a band 12 rows) until the second message, then one
  // line. The terminal keeps its row at the top of the chat and leaves the band
  // to others.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'terminal' || e.props.hasSurvey) return next(e)

    const ui = $.ui.resolve(e)
    const model: Model = {
      data: await read($, summary),
      now: await read($, live),
      state: await read($, status),
      collapsed: (await read($, isCollapsed)) || (await read($, band)) === 'folded',
    }
    const actions: Actions = {
      refresh: () => void refreshNow?.(),
      setCollapsed: value => {
        void update($, isCollapsed, () => value)
        void $.store.set('isCollapsed', value)
        if (!value) void update($, band, () => 'open')
      },
    }

    return view(ui, model, actions, e.props.bodyColumns, true, true)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const model: Model = {
      data: await read($, summary),
      now: await read($, live),
      state: await read($, status),
      collapsed: await read($, isCollapsed),
    }
    const actions: Actions = {
      refresh: () => void refreshNow?.(),
      setCollapsed: value => {
        void update($, isCollapsed, () => value)
        void $.store.set('isCollapsed', value)
      },
    }

    return view(ui, model, actions, e.props.bodyColumns, false)
  })
}

// ---------------------------------------------------------------------------
// Drawing: a plain function of the element table, the values and two actions.

type Ui = Elements[RenderSurface]
type Model = {
  data: UsageSummary | null
  now: UsageLive | null
  state: UsageStatus
  collapsed: boolean
}
type Actions = {
  refresh: () => void
  setCollapsed: (value: boolean) => void
}

// `isCompact` is the band's card: at most 12 rows, no chart, each line truncated.
function view(
  ui: Ui,
  model: Model,
  actions: Actions,
  columns: number,
  isFramed: boolean,
  isCompact = false,
) {
  const { Box, Text, Button } = ui
  const { data, now, state, collapsed } = model
  const width = Math.max(28, Math.min(Number.isFinite(columns) ? columns : MAX_WIDTH, MAX_WIDTH))
  const isNarrow = width < 64

  if (collapsed) {
    return (
      <Box width="100%" justifyContent="center">
        <Box width={width} flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={2}>
          <Text wrap="truncate-end">
            <Text color="claude" bold>
              Usage
            </Text>
            <Text dimColor> all </Text>
            {data ? short(data.all.total) : '…'}
            <Text dimColor> · 7d </Text>
            {data ? short(data.week.total) : '…'}
            <Text dimColor> · today </Text>
            {data ? short(data.today.total) : '…'}
            <Text dimColor> · session </Text>
            {data?.current ? short(data.current.total) : '—'}
          </Text>
          <Button key="expand" label="Show" onPress={() => actions.setCollapsed(false)} />
        </Box>
      </Box>
    )
  }

  const unavailable = state.error ? 'Not available' : '…'

  const stat = (label: string, totals: UsageTotals | undefined) => (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      minWidth={isCompact ? 8 : 16}
      marginTop={isNarrow && !isCompact ? 1 : 0}
    >
      <Text dimColor size="caption" wrap={isCompact ? 'truncate-end' : undefined}>
        {label}
      </Text>
      <Text bold size="title">
        {totals ? short(totals.total) : unavailable}
      </Text>
      {!isCompact && (
        <Text dimColor size="footnote">
          {totals ? `${short(totals.input + totals.output)} in+out · ${count(totals.replies, 'reply', 'replies')}` : ' '}
        </Text>
      )}
    </Box>
  )

  const row = (label: string, value: string) => (
    <Box flexDirection="row">
      <Box width={LABEL_WIDTH} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexShrink={1}>
        <Text wrap={isCompact ? 'truncate-end' : undefined}>{value}</Text>
      </Box>
    </Box>
  )

  const notReady = state.error
    ? `History: Not available (${state.error})`
    : 'Reading your Claude Code transcripts… the first scan takes a few seconds.'

  const topModel = data?.models[0]
  const topTool = data?.tools[0]
  const max7 = Math.max(0, ...(data?.last7.map(d => d.total) ?? [0]))

  return (
    <Box width="100%" justifyContent="center">
      <Box
        width={width}
        flexDirection="column"
        borderStyle={isFramed ? 'round' : undefined}
        borderDimColor={isFramed ? true : undefined}
        paddingX={isFramed ? 2 : 0}
      >
        <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={2}>
          <Text>
            <Text color="claude" bold>
              ✻ Claude Code usage
            </Text>
            <Text dimColor> · this computer</Text>
          </Text>
          <Box flexDirection="row" columnGap={1}>
            <Button
              key="refresh"
              label={state.isScanning ? 'Refreshing' : 'Refresh'}
              onPress={() => actions.refresh()}
            />
            <Button key="hide" label="Hide" onPress={() => actions.setCollapsed(true)} />
          </Box>
        </Box>

        {!isCompact && (
          <Text dimColor size="footnote">
            {data
              ? `All time = available Code and Cowork history since ${data.display.since ?? 'no replies yet'} (${count(data.sessions, 'session', 'sessions')}, ${count(data.projects, 'project', 'projects')}). Totals include cache reads and writes. Transcripts Claude Code has already deleted can't be counted.`
              : notReady}
          </Text>
        )}

        <Box
          flexDirection={isNarrow && !isCompact ? 'column' : 'row'}
          columnGap={3}
          marginTop={isCompact ? 0 : 1}
        >
          {stat('ALL TIME (AVAILABLE)', data?.all)}
          {stat('LAST 7 DAYS', data?.week)}
          {stat('TODAY', data?.today)}
        </Box>

        <Box flexDirection="column" marginTop={isCompact ? 0 : 1}>
          {row(
            'Top model',
            topModel
              ? `${modelName(topModel.model)} · ${percent(topModel.share)} of tokens (${count(topModel.replies, 'reply', 'replies')})`
              : data
                ? 'Not available (no replies recorded)'
                : unavailable,
          )}
          {row(
            'Busiest day',
            data?.topDay
              ? `${data.topDay.label} · ${short(data.topDay.total)} tokens`
              : data
                ? 'Not available'
                : unavailable,
          )}
          {row(
            'Top tool',
            topTool && data
              ? `${toolName(topTool.name)} · ${count(topTool.count, 'call', 'calls')} (${percent(topTool.count / Math.max(1, data.toolCalls))} of ${group(data.toolCalls)})`
              : data
                ? 'Not available (no tool calls recorded)'
                : unavailable,
          )}
        </Box>

        <Box flexDirection="column" marginTop={isCompact ? 0 : 1}>
          {row('This session', sessionLine(data, now, state))}
          {row('Context', contextLine(now))}
        </Box>

        {data && !isCompact && (
          <Box flexDirection="row" marginTop={1}>
            <Box width={LABEL_WIDTH} flexShrink={0}>
              <Text dimColor>Last 7 days</Text>
            </Box>
            <Box flexDirection="column">
              <Text mono color="claude">
                {data.last7.map(d => spark(d.total, max7).padEnd(3)).join('')}
              </Text>
              <Text mono dimColor>
                {data.last7.map(d => d.label.padEnd(3)).join('')}
              </Text>
            </Box>
          </Box>
        )}

        {isCompact ? (
          <Text dimColor size="footnote" wrap="truncate-end">
            {data
              ? `All time = Code + Cowork history since ${data.display.since ?? 'no replies yet'}, cache included · updated ${data.display.generated}`
              : notReady}
          </Text>
        ) : (
          <Box marginTop={1}>
            <Text dimColor size="caption">
              {footer(data, state)}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}

// "1 reply", "2,664 replies"
function count(n: number, one: string, many: string): string {
  return `${group(n)} ${n === 1 ? one : many}`
}

function sessionLine(data: UsageSummary | null, now: UsageLive | null, state: UsageStatus): string {
  const cost = now?.costUsd && now.costUsd > 0 ? ` · ≈ $${now.costUsd.toFixed(2)} at API prices` : ''
  if (data?.current) {
    const c = data.current
    return `${short(c.total)} tokens · ${short(c.input + c.output)} in+out · ${count(c.replies, 'reply', 'replies')}${cost}`
  }
  if (data) return `Not available yet (no reply recorded in this session)${cost}`
  return state.error ? `Not available${cost}` : `…${cost}`
}

function contextLine(now: UsageLive | null): string {
  if (!now || now.contextTokens === null || now.contextWindow === null) {
    return 'Not available until the first reply of this session'
  }
  const used =
    now.contextPercent ?? Math.round((now.contextTokens / Math.max(1, now.contextWindow)) * 100)
  const left = Math.max(0, 100 - used)
  const filled = Math.min(10, Math.max(0, Math.round(used / 10)))
  const bar = '▰'.repeat(filled) + '▱'.repeat(10 - filled)
  const model = now.model ? ` · ${modelName(now.model)}` : ''
  return `${bar} ${short(now.contextTokens)} of ${short(now.contextWindow)} used · ${left}% left${model}`
}

function footer(data: UsageSummary | null, state: UsageStatus): string {
  const parts: string[] = []
  if (data) parts.push(`Updated ${data.display.generated}`)
  parts.push(state.isScanning ? 'refreshing…' : 'auto-refresh every 30s')
  if (data && data.goneFiles > 0) parts.push(`${group(data.goneFiles)} deleted transcripts kept in totals`)
  if (data && state.error) parts.push(`last refresh failed: ${state.error}`)
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// Formatting

function short(n: number): string {
  if (n < 1_000) return String(n)
  const steps: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ]
  for (const [size, unit] of steps) {
    if (n >= size) {
      const v = n / size
      return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)}${unit}`
    }
  }
  return String(n)
}

function group(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function percent(share: number): string {
  const p = share * 100
  return p >= 10 || p === 0 ? `${Math.round(p)}%` : `${p.toFixed(1)}%`
}

const SPARKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
function spark(value: number, max: number): string {
  if (value <= 0 || max <= 0) return '·'
  const step = Math.ceil((value / max) * SPARKS.length) - 1
  return SPARKS[Math.min(SPARKS.length - 1, Math.max(0, step))] ?? '·'
}

// "claude-opus-5-5" -> "Opus 5.5"; an id of another form is shown as it is.
function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[.*\])?$/.exec(id)
  if (!m || !m[1] || !m[2]) return id
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1)
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

// "mcp__server__tool" -> "tool (MCP: server)"
function toolName(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m && m[1] && m[2] ? `${m[2]} (MCP: ${m[1]})` : name
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map(l => l.trim())
      .find(l => l.length > 0) ?? ''
  ).slice(0, 240)
}
