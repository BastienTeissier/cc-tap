import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// Point user overrides at a path that doesn't exist so the developer's real
// ~/.cc-lens/pricing.json can't leak into assertions
const previousConfigDir = process.env.CC_LENS_CONFIG_DIR
process.env.CC_LENS_CONFIG_DIR = '/nonexistent-cc-lens-test'

import { readCostState, reportedCost, transcriptModelId } from '@/lib/reported-cost'
import { LedgerBuilder, ledgerMetrics } from '@/lib/session-ledger'
import { estimateTotalCostFromModel, sessionCost } from '@/lib/pricing'

const T0 = Date.parse('2026-09-29T08:47:32.000Z')
const MIN = 60_000

/** The line Claude Code appends when its process exits */
function costStateLine(totalCostUSD: number, modelUsage: Record<string, number>, extra: Record<string, unknown> = {}) {
  return {
    type: 'cost-state', sessionId: 's', startTime: T0, totalCostUSD, hasUnknownModelCost: false,
    modelUsage: Object.fromEntries(Object.entries(modelUsage).map(([m, costUSD]) => [m, { inputTokens: 1, outputTokens: 1, costUSD }])),
    ...extra,
  }
}

describe('readCostState', () => {
  it('reads the total and each model, the context suffix dropped', () => {
    const state = readCostState(costStateLine(35.24, { 'claude-opus-5-5[1m]': 32.87, 'claude-haiku-4-5-20251001': 2.37 }))
    expect(state).toEqual({
      total: 35.24,
      byModel: { 'claude-opus-5-5': 32.87, 'claude-haiku-4-5-20251001': 2.37 },
      unknownModel: false,
      startTime: T0,
    })
    expect(transcriptModelId('claude-sonnet-5[1m]')).toBe('claude-sonnet-5')
  })

  it('refuses a line that is not one, or has no total', () => {
    expect(readCostState({ type: 'assistant' })).toBeNull()
    expect(readCostState({ type: 'cost-state', totalCostUSD: 'x' })).toBeNull()
  })
})

describe('reportedCost', () => {
  const state = readCostState(costStateLine(35.24, { 'claude-opus-5-5': 35.24 }))

  it('is the last cost-state when it covers every turn', () => {
    expect(reportedCost(state, false, [T0 + MIN, T0 + 2 * MIN])).toEqual({ total: 35.24, by_model: { 'claude-opus-5-5': 35.24 } })
  })

  it('is null when a model call came after it: still running, or a later process died', () => {
    expect(reportedCost(state, true, [T0 + MIN])).toBeNull()
  })

  it('is null when a turn predates its start: an earlier process died without writing one', () => {
    expect(reportedCost(state, false, [T0 - 90 * MIN, T0 + MIN])).toBeNull()
  })

  it('is null when Claude Code could not price a model, or wrote no line', () => {
    expect(reportedCost(readCostState(costStateLine(1, {}, { hasUnknownModelCost: true })), false, [T0 + MIN])).toBeNull()
    expect(reportedCost(null, false, [T0 + MIN])).toBeNull()
  })
})

describe('ledgerMetrics with a reported cost', () => {
  const OPUS = 'claude-opus-5-5'
  const HAIKU = 'claude-haiku-4-5'
  function ledger() {
    const b = new LedgerBuilder()
    b.addTurn({ ts: T0 + MIN, model: OPUS, input: 1000, output: 1000, cacheRead: 100_000, cacheWrite: 10_000, toolCalls: 0 })
    b.addTurn({ ts: T0 + 2 * MIN, model: OPUS, input: 1000, output: 3000, cacheRead: 300_000, cacheWrite: 30_000, toolCalls: 0 })
    b.addTurn({ ts: T0 + 3 * MIN, model: HAIKU, input: 500, output: 500, cacheRead: 0, cacheWrite: 0, toolCalls: 0, isAgent: true })
    return b.build()
  }
  const reported = { total: 1.2, by_model: { [OPUS]: 1, [HAIKU]: 0.15 } }

  it('costs the whole session what Claude Code reported, each model its reported share', () => {
    const m = ledgerMetrics(ledger(), null, 3, reported)
    expect(m.estimated_cost).toBeCloseTo(1.2)
    // 0.05 of calls the transcripts never show is spread over both, in proportion
    expect(m.model_usage[OPUS].costUSD / m.model_usage[HAIKU].costUSD).toBeCloseTo(1 / 0.15)
    expect(m.agents_cost).toBeCloseTo(m.model_usage[HAIKU].costUSD)
  })

  it('gives a window its share, so windows add up to the reported total', () => {
    const l = ledger()
    const first = ledgerMetrics(l, { from: T0, to: T0 + 1.5 * MIN }, 1, reported)
    const rest = ledgerMetrics(l, { from: T0 + 1.5 * MIN + 1, to: T0 + 10 * MIN }, 2, reported)
    expect(first.estimated_cost + rest.estimated_cost).toBeCloseTo(1.2)
  })

  it('without one, prices every model from the table, as before', () => {
    const m = ledgerMetrics(ledger(), null, 3)
    expect(m.model_usage[OPUS].costUSD).toBeCloseTo(estimateTotalCostFromModel(OPUS, { ...m.model_usage[OPUS], costUSD: 0 }))
    expect(m.estimated_cost).toBeCloseTo(m.model_usage[OPUS].costUSD + m.model_usage[HAIKU].costUSD)
  })
})

// End to end, through the reader: CLAUDE_CONFIG_DIR is read at module load.
describe('the reader', () => {
  let tmpDir: string
  let reader: typeof import('@/lib/claude-reader')
  let previousClaudeConfigDir: string | undefined
  const at = (min: number) => new Date(T0 + min * MIN).toISOString()
  const user = (min: number) => JSON.stringify({ type: 'user', timestamp: at(min), cwd: '/Users/test/proj', message: { content: 'go' } })
  const call = (min: number, id: string) => JSON.stringify({
    type: 'assistant', timestamp: at(min),
    message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 100_000 }, content: [] },
  })
  const cost = (total: number) => JSON.stringify(costStateLine(total, { 'claude-opus-5-5[1m]': total }))
  const SESSIONS: Record<string, string[]> = {
    'a0000000-0000-0000-0000-00000000000a': [user(1), call(2, 'm1'), cost(0.5)],
    'b0000000-0000-0000-0000-00000000000b': [user(1), call(2, 'm1'), cost(0.5), call(3, 'm2')],
    'c0000000-0000-0000-0000-00000000000c': [user(-60), call(-59, 'm0'), user(1), call(2, 'm1'), cost(0.5)],
  }

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-lens-cost-state-'))
    const projectDir = path.join(tmpDir, 'projects', '-Users-test-proj')
    await fs.mkdir(projectDir, { recursive: true })
    for (const [id, lines] of Object.entries(SESSIONS)) await fs.writeFile(path.join(projectDir, `${id}.jsonl`), lines.join('\n'))
    previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    vi.resetModules()
    reader = await import('@/lib/claude-reader')
  })

  afterAll(async () => {
    if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir
    if (previousConfigDir === undefined) delete process.env.CC_LENS_CONFIG_DIR
    else process.env.CC_LENS_CONFIG_DIR = previousConfigDir
    vi.resetModules()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('takes a complete session cost from Claude Code, and estimates the others', async () => {
    const sessions = Object.fromEntries((await reader.getAllParsedSessions()).map(s => [s.session_id[0], s]))
    expect(sessions.a.reported_cost).toEqual({ total: 0.5, by_model: { 'claude-opus-5-5': 0.5 } })
    expect(sessionCost(sessions.a)).toBeCloseTo(0.5)
    expect(sessions.b.reported_cost).toBeNull()
    expect(sessions.c.reported_cost).toBeNull()
    expect(sessionCost(sessions.b)).toBeCloseTo(2 * estimateTotalCostFromModel('claude-opus-5-5', {
      inputTokens: 1000, outputTokens: 1000, cacheReadInputTokens: 100_000, cacheCreationInputTokens: 0, costUSD: 0, webSearchRequests: 0,
    }))
  })
})
