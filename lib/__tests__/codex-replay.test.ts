import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { parseCodexSession } from '@/lib/harness/codex/reader'
import { parseCodexReplay } from '@/lib/harness/codex/replay'
import type { ReplayData } from '@/types/claude'

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const FILE = path.join(__dirname, 'fixtures', 'codex', 'sessions', '2026', '10', '01', `rollout-2026-10-01T10-00-00-${A}.jsonl`)
const ARCHIVED = path.join(__dirname, 'fixtures', 'codex', 'archived_sessions', `rollout-2026-09-20T08-00-00-${B}.jsonl`)

let replay: ReplayData
beforeAll(async () => { replay = await parseCodexReplay(FILE, A) })

describe('codex replay', () => {
  it('groups a response into one assistant turn closed by its token count', () => {
    expect(replay.harness).toBe('codex')
    expect(replay.turns.map(t => t.type)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
    const [prompt, first] = replay.turns
    expect(prompt.text).toBe('Fix the failing test')
    expect(first).toMatchObject({ model: 'gpt-5.5', has_thinking: true, thinking_text: 'Looking at the test' })
    expect(first.tool_calls?.[0]).toMatchObject({ id: 'call_1', name: 'exec_command', input: { cmd: 'npm test' } })
    expect(first.usage).toEqual({ input_tokens: 600, output_tokens: 50, cache_read_input_tokens: 400, cache_creation_input_tokens: 100 })
  })

  it('carries tool outputs in the next user turn', () => {
    expect(replay.turns[2].tool_results).toEqual([{ tool_use_id: 'call_1', content: expect.stringContaining('ok'), is_error: false }])
    expect(replay.turns[4].tool_results?.map(r => [r.tool_use_id, r.is_error])).toEqual([
      ['call_2', true], ['call_3', false], ['call_4', false],
    ])
    expect(replay.turns[3].tool_calls?.map(c => c.name)).toEqual(['exec_command', 'apply_patch', 'mcp__github__search'])
  })

  it('keeps a trailing message without usage', () => {
    const last = replay.turns.at(-1)!
    expect(last).toMatchObject({ type: 'assistant', text: 'Fixed the test.', model: 'gpt-5.3-codex' })
    expect(last.usage).toBeUndefined()
  })

  it('times the user turn from task_started to task_complete, on its last assistant turn', () => {
    expect(replay.turns.at(-1)!.turn_duration_ms).toBe(16_000)
    expect(replay.turns.filter(t => t.turn_duration_ms !== undefined)).toHaveLength(1)
  })

  it('takes the context window from the token count', () => {
    expect(replay.context_window).toBe(400000)
    expect(replay.version).toBe('0.9.0')
    expect(replay.git_branch).toBe('main')
  })

  it('keeps a response whole when a tool output comes before its token count', async () => {
    const archived = await parseCodexReplay(ARCHIVED, B)
    expect(archived.turns.map(t => t.type)).toEqual(['user', 'assistant', 'user', 'assistant'])
    const [, response, results] = archived.turns
    expect(response.tool_calls?.map(c => c.id)).toEqual(['call_9'])
    expect(response.usage?.output_tokens).toBe(50)
    expect(results.tool_results?.map(r => r.tool_use_id)).toEqual(['call_9'])
  })
})

describe('codex compaction', () => {
  it('records both compaction markers from the size of the context before them', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-lens-codex-compact-'))
    const file = path.join(dir, 'rollout.jsonl')
    const usage = (input: number, total: number) => ({ input_tokens: input, cached_input_tokens: 0, output_tokens: 10, total_tokens: total })
    const line = (s: number, type: string, payload: unknown) => JSON.stringify({ timestamp: `2026-10-01T10:00:0${s}.000Z`, type, payload })
    await fs.writeFile(file, [
      line(0, 'session_meta', { id: A, cwd: '/x' }),
      line(1, 'event_msg', { type: 'token_count', info: { total_token_usage: usage(900, 910), last_token_usage: usage(900, 910) } }),
      line(2, 'compacted', { message: 'summary' }),
      line(3, 'event_msg', { type: 'token_count', info: { total_token_usage: usage(1200, 1220), last_token_usage: usage(300, 310) } }),
      line(4, 'event_msg', { type: 'context_compacted' }),
    ].join('\n'))
    try {
      expect((await parseCodexSession(file, A))!.session.has_compaction).toBe(true)
      const { compactions } = await parseCodexReplay(file, A)
      expect(compactions.map(c => [c.pre_tokens, c.turn_index])).toEqual([[900, 1], [300, 2]])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
