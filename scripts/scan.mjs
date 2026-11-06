#!/usr/bin/env node
// Lifetime Usage Dashboard: transcript scanner.
//
// Reads every Claude Code transcript on this computer: Code sessions
// (<config>/projects/**/*.jsonl) and the desktop app's Cowork sessions (its
// local-agent-mode-sessions folder). Tallies the token usage each assistant
// reply recorded and prints one JSON summary on stdout. It reads incrementally:
// a per-file cache remembers how far each transcript was read, so later runs
// only read what was appended.
//
// The cache also keeps each transcript's totals after Claude Code deletes the
// file (cleanupPeriodDays), so the totals keep growing from the first scan on.
//
// It writes nothing but its own cache: <config>/lifetime-usage-dashboard/.
// Usage: node scan.mjs [--session <id>] [--config <claude config dir>] [--reset]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CACHE_VERSION = 1
const RECENT_KEYS = 400 // de-duplication window per file (a reply is logged once per content block)
const CHUNK = 8 * 1024 * 1024
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const args = parseArgs(process.argv.slice(2))
const configDir =
  args.config || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const projectsDir = path.join(configDir, 'projects')
const cacheDir = path.join(configDir, 'lifetime-usage-dashboard')
const cachePath = path.join(cacheDir, 'scan-cache.json')
const sessionId = args.session || ''

// The de-duplication window, held as a Map while scanning and written back
// to the record as pairs once its file is read.
const keyMaps = new Map()

const startedAt = Date.now()
const cache = args.reset ? freshCache() : loadCache()
let bytesRead = 0
let changedFiles = 0

// A resumed or forked session's transcript starts with copies of the earlier
// session's replies, each still carrying that earlier session's id. A copy is
// skipped while the earlier session's own transcript exists (that file counts
// the reply); with the original gone, the copy is the only record and counts.
const files = [...transcripts()]
const sessionFiles = new Set()
for (const { file, inner } of files) {
  if (inner.split(/[\\/]/).length === 2) sessionFiles.add(path.basename(file, '.jsonl'))
}

const present = new Set()
for (const { file, rel, inner } of files) {
  present.add(rel)
  // Only a transcript directly under a project folder is named for its
  // session; a subagent's, deeper down, carries its parent's id on purpose.
  const ownSession = inner.split(/[\\/]/).length === 2 ? path.basename(file, '.jsonl') : null
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    continue
  }
  let rec = cache.files[rel]
  if (rec && rec.gone) delete rec.gone
  if (rec && rec.size === stat.size && rec.mtimeMs === stat.mtimeMs) continue
  if (!rec || stat.size < rec.offset) rec = cache.files[rel] = emptyRecord()
  changedFiles++
  const from = rec.offset
  rec.offset = readLines(file, from, line => takeLine(rec, line, ownSession))
  if (keyMaps.has(rec)) rec.keys = [...keyMaps.get(rec)]
  bytesRead += rec.offset - from
  rec.size = stat.size
  rec.mtimeMs = stat.mtimeMs
}

// Transcripts Claude Code has since deleted keep their totals; their
// de-duplication window is no longer needed.
let newlyGone = 0
for (const [rel, rec] of Object.entries(cache.files)) {
  if (!present.has(rel) && !rec.gone) {
    rec.gone = true
    rec.keys = []
    newlyGone++
  }
}

if (changedFiles > 0 || newlyGone > 0 || args.reset || !fs.existsSync(cachePath)) saveCache(cache)
process.stdout.write(JSON.stringify(summarize(cache)))

// ---------------------------------------------------------------------------

function parseArgs(list) {
  const out = {}
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    if (a === '--reset') out.reset = true
    else if (a === '--session') out.session = list[++i]
    else if (a === '--config') out.config = list[++i]
  }
  return out
}

function freshCache() {
  return { v: CACHE_VERSION, trackingSince: new Date().toISOString(), files: {} }
}

function loadCache() {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    if (c && c.v === CACHE_VERSION && c.files) return c
  } catch {}
  return freshCache()
}

// Several sessions may scan at once. A save that fails (Windows refuses the
// rename while another scan has the file open) is skipped: this scan's figures
// are still printed, and the next scan reads the changed files again.
function saveCache(c) {
  const tmp = `${cachePath}.${process.pid}.tmp`
  try {
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(c))
    fs.renameSync(tmp, cachePath)
  } catch {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {}
  }
}

function emptyRecord() {
  return {
    size: 0,
    mtimeMs: 0,
    offset: 0,
    keys: [], // [key, outputTokensCounted]
    days: {}, // date -> [input, output, cacheWrite, cacheRead, replies]
    models: {}, // model -> [input, output, cacheWrite, cacheRead, replies]
    tools: {}, // tool name -> calls
    sessions: {}, // sessionId -> [input, output, cacheWrite, cacheRead, replies]
    first: null,
    last: null,
  }
}

// Each transcript as { file, rel, inner }: `rel` names it in the cache, `inner`
// is its path under its own projects folder. Code sessions sit directly under
// <config>/projects. Each Cowork session keeps a projects folder of its own in
// <root>/<account>/<org>/local_<id>/.claude/projects; the audit.jsonl beside
// that folder is a second copy of the same replies, so it is not read.
function* transcripts() {
  for (const file of walk(projectsDir)) {
    const rel = path.relative(projectsDir, file)
    yield { file, rel, inner: rel }
  }
  for (const root of coworkRoots()) {
    for (const account of subdirs(root)) {
      for (const org of subdirs(account)) {
        for (const session of subdirs(org)) {
          const projects = path.join(session, '.claude', 'projects')
          for (const file of walk(projects)) {
            const inner = path.relative(projects, file)
            yield { file, inner, rel: path.join('cowork', path.basename(session), inner) }
          }
        }
      }
    }
  }
}

// Where the desktop app keeps Cowork sessions: the app's data folder, which the
// Microsoft Store build puts under Claude-Data\<package>.
function coworkRoots() {
  const home = os.homedir()
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  const apps = [
    path.join(roaming, 'Claude'),
    path.join(home, 'Library', 'Application Support', 'Claude'),
    path.join(home, '.config', 'Claude'),
    ...subdirs(path.join(local, 'Claude-Data')),
  ]
  return apps.map(app => path.join(app, 'local-agent-mode-sessions'))
}

function subdirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(ent => ent.isDirectory())
      .map(ent => path.join(dir, ent.name))
  } catch {
    return []
  }
}

function* walk(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) yield* walk(full)
    else if (ent.isFile() && ent.name.endsWith('.jsonl')) yield full
  }
}

// Reads complete lines from byte `start`; returns the offset just past the
// last newline, so a line still being written is read whole next time.
function readLines(file, start, onLine) {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.allocUnsafe(CHUNK)
  let pos = start
  let carry = null
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos)
      if (n === 0) break
      pos += n
      const data = carry ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
      const nl = data.lastIndexOf(10)
      if (nl === -1) {
        carry = Buffer.from(data)
        continue
      }
      const text = data.toString('utf8', 0, nl)
      for (const line of text.split('\n')) onLine(line)
      carry = nl + 1 < data.length ? Buffer.from(data.subarray(nl + 1)) : null
    }
  } finally {
    fs.closeSync(fd)
  }
  return pos - (carry ? carry.length : 0)
}

function localDay(ts) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return null
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function bump(map, key, i, o, cw, cr, replies) {
  const row = map[key] || (map[key] = [0, 0, 0, 0, 0])
  row[0] += i
  row[1] += o
  row[2] += cw
  row[3] += cr
  row[4] += replies
}

function takeLine(rec, line, ownSession) {
  if (line.length < 40 || !line.includes('"assistant"')) return
  let o
  try {
    o = JSON.parse(line)
  } catch {
    return
  }
  if (!o || o.type !== 'assistant' || !o.message) return
  const isCopy =
    ownSession && o.sessionId && o.sessionId !== ownSession && sessionFiles.has(o.sessionId)
  if (isCopy) return
  const m = o.message
  const keys = keysOf(rec)

  if (Array.isArray(m.content)) {
    for (const c of m.content) {
      if (c && c.type === 'tool_use' && c.name) {
        const k = `tool:${c.id || ''}`
        if (c.id && keys.has(k)) continue
        rec.tools[c.name] = (rec.tools[c.name] || 0) + 1
        if (c.id) remember(rec, keys, k, 0)
      }
    }
  }

  const u = m.usage
  const model = m.model
  if (!u || !model || model === '<synthetic>') return
  const i = u.input_tokens || 0
  const out = u.output_tokens || 0
  const cw = u.cache_creation_input_tokens || 0
  const cr = u.cache_read_input_tokens || 0
  const day = localDay(o.timestamp)
  if (!day) return
  const sid = o.sessionId || ''
  const key = `${m.id || ''}:${o.requestId || ''}`

  if (keys.has(key)) {
    // The same reply logged again (one line per content block). Count it once;
    // if a later line carries a larger output count, add only the difference.
    const counted = keys.get(key)
    if (out > counted) {
      const extra = out - counted
      bump(rec.days, day, 0, extra, 0, 0, 0)
      bump(rec.models, model, 0, extra, 0, 0, 0)
      if (sid) bump(rec.sessions, sid, 0, extra, 0, 0, 0)
      remember(rec, keys, key, out)
    }
    return
  }

  bump(rec.days, day, i, out, cw, cr, 1)
  bump(rec.models, model, i, out, cw, cr, 1)
  if (sid) bump(rec.sessions, sid, i, out, cw, cr, 1)
  remember(rec, keys, key, out)
  if (!rec.first || o.timestamp < rec.first) rec.first = o.timestamp
  if (!rec.last || o.timestamp > rec.last) rec.last = o.timestamp
}

function keysOf(rec) {
  let keys = keyMaps.get(rec)
  if (!keys) keyMaps.set(rec, (keys = new Map(rec.keys)))
  return keys
}

function remember(rec, keys, key, value) {
  keys.delete(key)
  keys.set(key, value)
  if (keys.size > RECENT_KEYS) keys.delete(keys.keys().next().value)
}

function totals(row) {
  const [input = 0, output = 0, cacheWrite = 0, cacheRead = 0, replies = 0] = row || []
  return { input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead, replies }
}

function summarize(c) {
  const days = {}
  const models = {}
  const tools = {}
  const sessions = {}
  const projects = new Set()
  let first = null
  let last = null
  let goneFiles = 0
  let files = 0

  for (const [rel, rec] of Object.entries(c.files)) {
    files++
    if (rec.gone) goneFiles++
    let hasReplies = false
    for (const [k, r] of Object.entries(rec.days)) {
      bump(days, k, ...r)
      if (r[4] > 0) hasReplies = true
    }
    for (const [k, r] of Object.entries(rec.models)) bump(models, k, ...r)
    for (const [k, r] of Object.entries(rec.sessions)) bump(sessions, k, ...r)
    for (const [k, n] of Object.entries(rec.tools)) tools[k] = (tools[k] || 0) + n
    if (hasReplies) projects.add(rel.split(/[\\/]/)[0])
    if (rec.first && (!first || rec.first < first)) first = rec.first
    if (rec.last && (!last || rec.last > last)) last = rec.last
  }

  const now = new Date()
  const today = localDay(now)
  const last7 = []
  for (let back = 6; back >= 0; back--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, 12)
    const k = localDay(d)
    last7.push({ date: k, total: totals(days[k]).total, label: WEEKDAYS[d.getDay()].slice(0, 2) })
  }
  const week = [0, 0, 0, 0, 0]
  for (const { date } of last7) {
    const r = days[date]
    if (r) for (let j = 0; j < 5; j++) week[j] += r[j]
  }

  const all = [0, 0, 0, 0, 0]
  let topDay = null
  for (const [k, r] of Object.entries(days)) {
    for (let j = 0; j < 5; j++) all[j] += r[j]
    const t = totals(r).total
    if (!topDay || t > topDay.total) topDay = { date: k, total: t, label: dayLabel(k) }
  }
  const allTotals = totals(all)

  const modelList = Object.entries(models)
    .map(([model, r]) => ({ model, total: totals(r).total, replies: r[4] }))
    .sort((a, b) => b.total - a.total)
    .map(m => ({ ...m, share: allTotals.total ? m.total / allTotals.total : 0 }))

  const toolList = Object.entries(tools)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)

  const current = sessionId && sessions[sessionId] ? { sessionId, ...totals(sessions[sessionId]) } : null

  return {
    generatedAt: Date.now(),
    configDir,
    trackingSince: c.trackingSince,
    since: first,
    latest: last,
    files,
    goneFiles,
    sessions: Object.keys(sessions).length,
    projects: projects.size,
    all: allTotals,
    week: totals(week),
    today: totals(days[today]),
    last7,
    models: modelList.slice(0, 5),
    topDay,
    tools: toolList.slice(0, 5),
    toolCalls: toolList.reduce((n, t) => n + t.count, 0),
    current,
    display: {
      since: first ? dateLabel(new Date(first)) : null,
      trackingSince: dateLabel(new Date(c.trackingSince)),
      generated: timeLabel(now),
    },
    scan: { ms: Date.now() - startedAt, changedFiles, bytesRead },
  }
}

function dateLabel(d) {
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

// "2026-10-03" -> "Sat 3 Oct 2026"
function dayLabel(key) {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d, 12)
  return `${WEEKDAYS[date.getDay()]} ${dateLabel(date)}`
}

function timeLabel(d) {
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}
