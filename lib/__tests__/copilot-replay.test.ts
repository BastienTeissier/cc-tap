import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { copilotAdapter } from '@/lib/harness/copilot/adapter'
import { estimateCostFromUsage } from '@/lib/pricing'
import type { ReplayData } from '@/types/claude'
import { COPILOT_A as A, COPILOT_ROWS, makeCopilotHome, type CopilotRow } from './helpers/copilot-home'

let saved: string | undefined
let root: string
let replay: ReplayData

beforeAll(async () => {
  saved = process.env.COPILOT_HOME
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-lens-copilot-'))
  await makeCopilotHome(root)
  process.env.COPILOT_HOME = root
  const entry = (await copilotAdapter.listSessionFiles()).find(e => e.session_id === A)!
  replay = await copilotAdapter.parseReplay(entry)
})

afterAll(async () => {
  if (saved === undefined) delete process.env.COPILOT_HOME
  else process.env.COPILOT_HOME = saved
  await fs.rm(root, { recursive: true, force: true })
})

describe('copilot replay', () => {
  it('joins the usage rows to the turns by order', () => {
    expect(replay).toMatchObject({ session_id: A, harness: 'copilot', version: '1.0.93' })
    expect(replay.turns.map(t => t.type)).toEqual(['user', 'assistant', 'user', 'assistant'])
    const [prompt, first, results, second] = replay.turns
    expect(prompt.text).toBe('Fix the bug')
    expect(first.usage).toEqual({ input_tokens: 300, output_tokens: 200, cache_read_input_tokens: 600, cache_creation_input_tokens: 100 })
    expect(second.usage).toEqual({ input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 })
    expect(first).toMatchObject({ model: 'gpt-5.5', text: 'Looking', has_thinking: true, thinking_text: 'Check the file first', turn_duration_ms: 8000 })
    expect(first.tool_calls?.map(c => c.name)).toEqual(['view', 'view', 'bash'])
    expect(first.tool_calls?.[2]).toMatchObject({ result: '1 test failed', is_error: true })
    expect(results.tool_results?.map(r => r.is_error)).toEqual([false, false, true])
    expect(replay.total_cost).toBeCloseTo(estimateCostFromUsage('gpt-5.5', first.usage!) + estimateCostFromUsage('gpt-5.5', second.usage!))
  })
})

const C = '33333333-0000-4000-8000-00000000000c'
const event = (type: string, second: number, data: Record<string, unknown> = {}) =>
  JSON.stringify({ type, data, id: `e${second}`, timestamp: `2026-10-03T10:00:${String(second).padStart(2, '0')}.000Z`, parentId: null })
const row = (output: number, second: number): CopilotRow => ({
  session_id: C, model: 'gpt-5.5', input: 100, output, cacheRead: 0, cacheWrite: 0, reasoning: 0, nanoAiu: 1e9, at: `2026-10-03T10:00:${second}.000Z`,
})

/** Session C's replay, built from `events` and its `rows` */
async function replayOf(events: string[], rows: CopilotRow[]): Promise<ReplayData> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-lens-copilot-'))
  try {
    await makeCopilotHome(home, [...COPILOT_ROWS, ...rows])
    const dir = path.join(home, 'session-state', C)
    await fs.mkdir(dir)
    await fs.writeFile(path.join(dir, 'events.jsonl'), events.join('\n') + '\n')
    process.env.COPILOT_HOME = home
    const entry = (await copilotAdapter.listSessionFiles()).find(e => e.session_id === C)!
    return await copilotAdapter.parseReplay(entry)
  } finally {
    process.env.COPILOT_HOME = root
    await fs.rm(home, { recursive: true, force: true })
  }
}

describe('copilot replay edge cases', () => {
  it('gives no usage row to a message outside a turn span', async () => {
    const replay = await replayOf([
      event('session.start', 0, { sessionId: C }),
      event('user.message', 1, { content: 'Go' }),
      event('assistant.message', 2, { model: 'gpt-5.5', content: 'Preamble' }),
      event('assistant.turn_start', 3),
      event('assistant.message', 4, { model: 'gpt-5.5', content: 'Answer' }),
      event('assistant.turn_end', 5),
    ], [row(42, 4)])
    const assistant = replay.turns.filter(t => t.type === 'assistant')
    expect(assistant.map(t => [t.text, t.usage?.output_tokens])).toEqual([['Preamble', undefined], ['Answer', 42]])
  })

  it('puts results written after turn_end before the next turn', async () => {
    const replay = await replayOf([
      event('session.start', 0, { sessionId: C }),
      event('user.message', 1, { content: 'Go' }),
      event('assistant.turn_start', 2),
      event('assistant.message', 3, { model: 'gpt-5.5', content: '', toolRequests: [{ toolCallId: 'k1', name: 'view', arguments: {} }] }),
      event('assistant.turn_end', 4),
      event('tool.execution_complete', 5, { toolCallId: 'k1', success: true, result: { content: 'file' } }),
      event('assistant.turn_start', 6),
      event('assistant.message', 7, { model: 'gpt-5.5', content: 'After' }),
      event('assistant.turn_end', 8),
    ], [row(10, 3), row(20, 7)])
    expect(replay.turns.map(t => t.type)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(replay.turns[2].tool_results?.map(r => r.tool_use_id)).toEqual(['k1'])
    expect(replay.turns[3]).toMatchObject({ text: 'After', usage: { output_tokens: 20 } })
  })
})
