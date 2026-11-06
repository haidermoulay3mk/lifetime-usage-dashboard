#!/usr/bin/env node
// Checks scripts/scan.mjs against made-up transcripts in a temporary folder.
// Run it with: node tests/scan-check.mjs
// It never reads or writes your real transcripts or the real cache.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scanner = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'scan.mjs')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-scan-check-'))
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
}
delete env.CLAUDE_CONFIG_DIR

const scan = () => JSON.parse(execFileSync(process.execPath, [scanner], { env, encoding: 'utf8' }))
const put = (file, ...lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, lines.map(l => l + '\n').join(''))
}

// One assistant line. `extra` holds what differs between a transcript line and
// an audit.jsonl line.
const reply = (sessionId, id, tokens, day, extra = { requestId: `req-${id}` }) =>
  JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp: `${day}T12:00:00.000Z`,
    message: {
      id,
      model: 'claude-test',
      content: [],
      usage: { input_tokens: tokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    ...extra,
  })

const checks = []
const check = (name, fn) => checks.push([name, fn])

const code = path.join(home, '.claude', 'projects', 'project-a')
const coworkSession = path.join(
  env.LOCALAPPDATA, 'Claude-Data', 'claude_package', 'local-agent-mode-sessions', 'account', 'org', 'local_1',
)
const cowork = path.join(coworkSession, '.claude', 'projects', 'project-b')

check('Code and Cowork are both counted, each reply once', () => {
  // A reply is logged once per content block: the same line twice.
  put(path.join(code, 'code-1.jsonl'), reply('code-1', 'msg-a', 100, '2026-03-02'), reply('code-1', 'msg-a', 100, '2026-03-02'))
  put(path.join(cowork, 'cowork-1.jsonl'), reply('cowork-1', 'msg-b', 1000, '2026-01-15'))
  const s = scan()
  assert.equal(s.all.total, 1100)
  assert.equal(s.all.replies, 2)
  assert.equal(s.since, '2026-01-15T12:00:00.000Z', 'the earliest reply is the Cowork one')
})

check('a Cowork audit.jsonl (a second copy) adds nothing', () => {
  put(
    path.join(coworkSession, 'audit.jsonl'),
    reply('cowork-1', 'msg-b', 1000, '2026-01-15', { request_id: 'req-msg-b', _audit_timestamp: '2026-01-15T12:00:00Z' }),
  )
  assert.equal(scan().all.total, 1100)
})

check("a resumed session's copy of an earlier reply adds nothing", () => {
  put(path.join(code, 'code-2.jsonl'), reply('code-1', 'msg-a', 100, '2026-03-02'), reply('code-2', 'msg-c', 10, '2026-03-03'))
  const s = scan()
  assert.equal(s.all.total, 1110)
  assert.equal(s.all.replies, 3)
})

check('a new reply is added to what was already read', () => {
  put(path.join(cowork, 'cowork-1.jsonl'), reply('cowork-1', 'msg-d', 5, '2026-01-16'))
  const s = scan()
  assert.equal(s.all.total, 1115)
  assert.equal(s.scan.changedFiles, 1, 'only the changed transcript is read')
})

check('totals survive when the transcripts are deleted', () => {
  fs.rmSync(path.join(home, '.claude', 'projects'), { recursive: true })
  fs.rmSync(path.join(env.LOCALAPPDATA, 'Claude-Data'), { recursive: true })
  const s = scan()
  assert.equal(s.all.total, 1115)
  assert.equal(s.all.replies, 4)
  assert.equal(s.goneFiles, 3)
  assert.equal(scan().all.total, 1115, 'and stay there on the next scan')
})

check('a corrupt cache starts over instead of failing', () => {
  fs.writeFileSync(path.join(home, '.claude', 'lifetime-usage-dashboard', 'scan-cache.json'), '{not json')
  put(path.join(code, 'code-3.jsonl'), reply('code-3', 'msg-e', 7, '2026-04-01'))
  assert.equal(scan().all.total, 7)
})

let failed = 0
for (const [name, fn] of checks) {
  try {
    fn()
    console.log(`ok    ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}\n      ${err.message}`)
  }
}
fs.rmSync(home, { recursive: true, force: true })
console.log(failed ? `\n${failed} of ${checks.length} failed` : `\nall ${checks.length} passed`)
process.exit(failed ? 1 : 0)
