import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import { parseCodexReplay } from '@/lib/harness/codex/replay'
import type { ReplayData } from '@/types/claude'

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const FILE = path.join(__dirname, 'fixtures', 'codex', 'sessions', '2026', '10', '01', `rollout-2026-10-01T10-00-00-${A}.jsonl`)

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

  it('takes the context window from the token count', () => {
    expect(replay.context_window).toBe(400000)
    expect(replay.version).toBe('0.9.0')
    expect(replay.git_branch).toBe('main')
  })
})
