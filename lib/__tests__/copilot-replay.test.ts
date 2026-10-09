import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { copilotAdapter } from '@/lib/harness/copilot/adapter'
import { estimateCostFromUsage } from '@/lib/pricing'
import type { ReplayData } from '@/types/claude'
import { COPILOT_A as A, makeCopilotHome } from './helpers/copilot-home'

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
