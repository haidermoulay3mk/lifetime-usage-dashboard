# Lifetime Usage Dashboard

A Claude Code mod that puts a usage card at the top of every new session,
centred above the conversation. It scrolls away with the chat, so it never
covers the prompt box.

Layout sketch (the numbers here are only examples):

```
╭──────────────────────────────────────────────────────────────────────╮
│ ✻ Claude Code usage · this computer             [ Refresh ] [ Hide ] │
│ All time = available history since 5 Jul 2026 (44 sessions, …)      │
│                                                                      │
│ ALL TIME (AVAILABLE)     LAST 7 DAYS        TODAY                    │
│ 1.07B                    6.65M              6.65M                    │
│ 3.78M in+out · 2,481 …   …                  …                        │
│                                                                      │
│ Top model     Opus 5.5 · 98% of tokens (2,078 replies)               │
│ Busiest day   Sat 3 Oct 2026 · 323M tokens                           │
│ Top tool      Bash · 1,175 calls (36% of 3,261)                      │
│                                                                      │
│ This session  6.65M tokens · 44.8k in+out · 32 replies               │
│ Context       ▰▰▰▱▱▱▱▱▱▱ 142k of 1.00M used · 86% left · Opus 5.5    │
│ Last 7 days   ·  ▁  ·  ·  ·  ·  █                                    │
│               Th Fr Sa Su Mo Tu We                                   │
│ Updated 19:05:12 · auto-refresh every 30s                            │
╰──────────────────────────────────────────────────────────────────────╯
```

## Install

At the prompt of a terminal session:

```
/plugin install lifetime-usage-dashboard --marketplace haidermoulay3mk/lifetime-usage-dashboard
```

Answer `y` to add the marketplace, then press Enter to install for your user,
so it runs in every session.

From a shell:

```bash
claude plugin install lifetime-usage-dashboard --marketplace haidermoulay3mk/lifetime-usage-dashboard
```

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with
`haidermoulay3mk/lifetime-usage-dashboard`, then Add plugin.

See [Requirements](#requirements) first: the mod needs Node.js or Bun.

## What it shows, and where each number comes from

| Figure | Source |
| --- | --- |
| All time, last 7 days, today | Token usage recorded in the transcripts on this computer: Code sessions (`~/.claude/projects/**/*.jsonl`) and the desktop app's Cowork sessions (its `local-agent-mode-sessions` folder) |
| Top model | Sum of tokens per model across those transcripts |
| Busiest day | The local calendar day with the most tokens |
| Top tool | The most-called tool across those transcripts |
| This session | The current session's transcript |
| Context | Claude Code's own status-line figures (`$.session.usage()`) |
| ≈ cost | Claude Code's own `/cost` total at API prices (not a bill on a subscription) |

How the counting works:

- **Tokens** means input + output + cache writes + cache reads. Cache reads
  dominate, so each figure also shows the input+output part separately.
- **Each reply is counted once.** A transcript logs one line per content
  block, and a resumed session starts with copies of the earlier session's
  replies. Both kinds of repeat are skipped, and a Cowork session's `audit.jsonl`
  (a second copy of its replies) is not read. `node tests/scan-check.mjs` checks
  this against made-up transcripts in a temporary folder.
- **"All time" means available history.** Claude Code deletes old transcripts
  (the `cleanupPeriodDays` setting). Nothing on the computer keeps their token
  counts, so whatever was deleted before this mod's first scan on your computer
  is gone and is not in the total. From that scan on, the scanner keeps each
  transcript's totals in its cache even after the file is deleted, so the
  totals only grow. Usage from other computers or claude.ai is not included.
  The card says "since <date>" so you can see the range.
- **Missing figures say "Not available".** The context figure, for example,
  only appears after the session's first reply. Nothing is estimated.

## Using it

- The card appears by itself in each new session:
  - **Desktop app (Code tab):** in the band just above the message box, once
    you have sent your first message (the empty new-session screen has no
    session behind it yet, so nothing can draw there). A compact card stays
    until you send your second message, then it folds to one line. **Show**
    opens it again. The desktop app does not draw mod rows inside the
    transcript, so the band is its place. `/usage-dashboard pane` gives the
    full dashboard, chart included, beside the chat.
  - **Terminal `claude`:** as a row at the top of the chat, scrolling away
    with it.
- **Refresh** rescans now. It also refreshes after each turn, and every 30
  seconds while a window shows the session (never in a headless `claude -p` run).
- **Hide** folds the card to one line. **Show** opens it again. Your choice
  is remembered for later sessions.
- `/usage-dashboard`: show the card again at the current end of the chat.
- `/usage-dashboard pane`: dock the dashboard beside the chat.
- `/usage-dashboard refresh`: rescan now.

## Requirements

- Claude Code **2.1.317 or newer** (the desktop app's built-in Claude Code
  qualifies; an older terminal `claude` may not load function-hook mods).
- **Node.js** or **Bun** on PATH. The scanner (`scripts/scan.mjs`) runs with it.
- It reads only local files and uses no network. It writes only its own cache
  at `~/.claude/lifetime-usage-dashboard/scan-cache.json`.

## Enable, disable, update, remove

```bash
claude plugin disable lifetime-usage-dashboard@usage-dashboard
```

```bash
claude plugin enable lifetime-usage-dashboard@usage-dashboard
```

**Update**, then start a new session:

```bash
claude plugin update lifetime-usage-dashboard@usage-dashboard
```

**Remove:**

```bash
claude plugin uninstall lifetime-usage-dashboard@usage-dashboard
```

```bash
claude plugin marketplace remove usage-dashboard
```

Then delete the folder `~/.claude/lifetime-usage-dashboard`. It is the mod's
cache and also holds the totals of transcripts Claude Code has since deleted,
so those totals go with it.

## Licence

MIT. See [LICENSE](LICENSE).
