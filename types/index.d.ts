/** Token counts for one span of time, as the transcripts recorded them. */
export type UsageTotals = {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  /** input + output + cacheWrite + cacheRead */
  total: number
  /** API replies counted (each reply once, copies skipped) */
  replies: number
}

/** What scripts/scan.mjs prints: the history tallied from the transcripts. */
export type UsageSummary = {
  generatedAt: number
  configDir: string
  /** When this dashboard first scanned (its own running totals start here). */
  trackingSince: string
  /** The earliest and latest reply found, ISO times. */
  since: string | null
  latest: string | null
  files: number
  /** Transcripts Claude Code has since deleted whose totals the cache kept. */
  goneFiles: number
  sessions: number
  projects: number
  all: UsageTotals
  week: UsageTotals
  today: UsageTotals
  last7: { date: string; total: number; label: string }[]
  models: { model: string; total: number; replies: number; share: number }[]
  topDay: { date: string; total: number; label: string } | null
  tools: { name: string; count: number }[]
  toolCalls: number
  current: (UsageTotals & { sessionId: string }) | null
  /** Dates and times already written in this computer's local time. */
  display: { since: string | null; trackingSince: string; generated: string }
  scan: { ms: number; changedFiles: number; bytesRead: number }
}

/** The live session's figures, as the status line reads them. */
export type UsageLive = {
  contextTokens: number | null
  contextWindow: number | null
  contextPercent: number | null
  costUsd: number | null
  model: string | null
}

export type UsageStatus = {
  isScanning: boolean
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'lifetime-usage-dashboard': {
      summary: Shaped<UsageSummary | null>
      live: Shaped<UsageLive | null>
      status: Shaped<UsageStatus>
      isCollapsed: boolean
      /**
       * The band above the prompt (the desktop app's place for the card): the
       * card through `start` and `replied` (the first reply came), one line
       * once `folded` by the next message, the card again once the person
       * chose `open` this session.
       */
      band: 'start' | 'replied' | 'folded' | 'open'
    }
  }
}
