import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { codexAdapter } from '@/lib/harness/codex/adapter'
import { parseCodexSession } from '@/lib/harness/codex/reader'
import { pathToSlug } from '@/lib/decode'
import type { SessionFileEntry, SessionRecord } from '@/lib/harness/types'

const FIXTURES = path.join(__dirname, 'fixtures', 'codex')
const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'

let saved: string | undefined
let entries: SessionFileEntry[]
let a: SessionRecord
let b: SessionRecord

beforeAll(async () => {
  saved = process.env.CODEX_HOME
  process.env.CODEX_HOME = FIXTURES
  entries = await codexAdapter.listSessionFiles()
  a = (await codexAdapter.parseSession(entries.find(e => e.session_id === A)!))!
  b = (await codexAdapter.parseSession(entries.find(e => e.session_id === B)!))!
})

afterAll(() => {
  if (saved === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = saved
})

describe('codex reader', () => {
  it('lists dated and archived rollouts', () => {
    expect(entries.map(e => e.session_id).sort()).toEqual([A, B])
    expect(entries.every(e => e.harness === 'codex')).toBe(true)
  })

  it('takes the session id from session_meta', () => {
    expect(a.session.session_id).toBe(A)
    expect(a.session.harness).toBe('codex')
  })

  it('takes the project from the cwd', () => {
    expect(a.session.project_path).toBe('/Users/test/proj')
    expect(a.session.slug_name).toBe(pathToSlug('/Users/test/proj'))
  })

  it('builds the ledger from token counts, net of the cached input', () => {
    expect(a.session).toMatchObject({
      input_tokens: 1200,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 200,
      output_tokens: 100,
      assistant_message_count: 2,
    })
  })

  it('skips token counts with no info and repeated running totals', () => {
    expect(a.ledger.ts).toHaveLength(2)
  })

  it('charges each response to the model of the latest turn_context', () => {
    expect(Object.keys(a.session.model_usage ?? {}).sort()).toEqual(['gpt-5.3-codex', 'gpt-5.5'])
    expect(a.session.model_usage?.['gpt-5.5']).toMatchObject({ inputTokens: 600, outputTokens: 50, cacheReadInputTokens: 400 })
  })

  it('counts tool calls, MCP included', () => {
    expect(a.session.tool_counts).toEqual({ exec_command: 2, apply_patch: 1, mcp__github__search: 1 })
    expect(a.session.uses_mcp).toBe(true)
    expect(Array.from(a.ledger.toolCalls)).toEqual([1, 3])
  })

  it('counts a non-zero exit code as a tool error', () => {
    expect(a.session.tool_errors).toBe(1)
  })

  it('reads prompts, skipping the context Codex injects', () => {
    expect(a.session.first_prompt).toBe('Fix the failing test')
    expect(a.session.user_message_timestamps).toEqual(['2026-10-01T10:00:03.000Z'])
    expect(a.session.user_message_count).toBe(1)
  })

  it('reads the request out of an IDE context message', () => {
    expect(b.session.first_prompt).toBe('Add a README')
  })

  it('records one rate limit hit per window at 100%', () => {
    expect(a.rate_limit_hits).toEqual([{ ts: Date.parse('2026-10-01T10:00:14.000Z'), resets_at: 1790000000_000 }])
  })

  it('reports the CLI version, branch and reasoning', () => {
    expect(a.session.cc_version).toBe('0.9.0')
    expect(a.session.git_branch).toBe('main')
    expect(Object.keys(a.git_branches)).toEqual(['main'])
    expect(a.session.has_thinking).toBe(true)
    expect(b.git_branches).toEqual({})
  })

  it('skips a malformed line', () => {
    expect(a.session.last_activity).toBe('2026-10-01T10:00:19.000Z')
  })
})

describe('codex reader edge cases', () => {
  let dir: string
  beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-lens-codex-')) })
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  it('skips a legacy rollout with no session_meta', async () => {
    const file = path.join(dir, 'legacy.jsonl')
    await fs.writeFile(file, [
      JSON.stringify({ id: A, timestamp: '2025-08-01T10:00:00.000Z', instructions: '' }),
      JSON.stringify({ record_type: 'state' }),
      JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }),
    ].join('\n'))
    expect(await parseCodexSession(file, A)).toBeNull()
  })
})
