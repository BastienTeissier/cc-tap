import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { makeClaudeHome, claudeTranscript } from './helpers/harness-home'

let home: Awaited<ReturnType<typeof makeClaudeHome>>
const recent = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString()

beforeAll(async () => {
  home = await makeClaudeHome([
    { id: 'c1c1c1c1-0000-0000-0000-000000000000', slug: '-Users-test-proj', jsonl: claudeTranscript({ cwd: '/Users/test/proj', start: recent(2), model: 'claude-sonnet-5-5' }) },
    { id: 'c3c3c3c3-0000-0000-0000-000000000000', slug: '-Users-test-proj', jsonl: claudeTranscript({ cwd: '/Users/test/proj', start: recent(1), model: 'claude-opus-4-8' }) },
  ])
})

afterAll(() => home.cleanup())

async function costs(query = '') {
  const { GET } = await import('@/app/api/costs/route')
  return (await GET(new Request(`http://localhost/api/costs${query}`))).json()
}

describe('GET /api/costs harness dimensions', () => {
  it('tags each model row with its harness and lists the harnesses in range', async () => {
    const body = await costs()
    expect(body.models.map((m: { harness: string; model: string }) => `${m.harness}:${m.model}`).sort())
      .toEqual(['claude:claude-opus-4-8', 'claude:claude-sonnet-5-5'])
    expect(body.harnesses).toEqual(['claude'])
  })

  it('splits each day by harness, summing to the day total', async () => {
    const body = await costs()
    expect(body.daily).toHaveLength(2)
    for (const day of body.daily) {
      const sum = Object.values(day.by_harness as Record<string, number>).reduce((a, b) => a + b, 0)
      expect(sum).toBeCloseTo(day.total)
      expect(Object.keys(day.by_harness)).toEqual(['claude'])
    }
  })

  it('drops every row when the filter selects another harness', async () => {
    const body = await costs('?h=codex')
    expect(body).toMatchObject({ models: [], daily: [], harnesses: [], total_cost: 0, sessions: 0 })
  })
})
