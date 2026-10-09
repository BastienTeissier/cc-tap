import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import { makeClaudeHome, claudeTranscript } from './helpers/harness-home'

const STATS_ONLY_DAY = '2025-01-15'
let home: Awaited<ReturnType<typeof makeClaudeHome>>

beforeAll(async () => {
  home = await makeClaudeHome([
    { id: 'f1f1f1f1-0000-0000-0000-000000000000', slug: '-Users-test-proj', jsonl: claudeTranscript({ cwd: '/Users/test/proj', start: '2026-06-01T10:00:00.000Z' }) },
  ])
  // A day only Claude's own stats cache knows about
  await fs.writeFile(path.join(home.claudeDir, 'stats-cache.json'), JSON.stringify({
    version: 1, lastComputedDate: STATS_ONLY_DAY, tokensByDate: [], modelUsage: {}, totalSessions: 1, totalMessages: 9,
    longestSession: { sessionId: '', duration: 0, messageCount: 0, timestamp: '' }, firstSessionDate: '', hourCounts: {}, totalSpeculationTimeSavedMs: 0,
    dailyActivity: [{ date: STATS_ONLY_DAY, messageCount: 9, sessionCount: 1, toolCallCount: 0 }],
  }))
})

afterAll(() => home.cleanup())

const days = (activity: Array<{ date: string }>) => activity.map(d => d.date)

describe('stats cache and the harness filter', () => {
  it('merges the Claude stats cache when Claude is selected', async () => {
    const { GET } = await import('@/app/api/activity/route')
    const body = await (await GET(new Request('http://localhost/api/activity?h=claude'))).json()
    expect(days(body.daily_activity)).toEqual([STATS_ONLY_DAY, '2026-06-01'])
  })

  it('skips the Claude stats cache when Claude is filtered out', async () => {
    const activity = await (await (await import('@/app/api/activity/route')).GET(new Request('http://localhost/api/activity?h=codex'))).json()
    expect(activity.daily_activity).toEqual([])

    const stats = await (await (await import('@/app/api/stats/route')).GET(new Request('http://localhost/api/stats?h=codex'))).json()
    expect(stats.stats.dailyActivity).toEqual([])
    expect(stats.computed.sessionCount).toBe(0)
  })

  it('sums storage over the detected harness dirs', async () => {
    const { GET } = await import('@/app/api/stats/route')
    const body = await (await GET(new Request('http://localhost/api/stats'))).json()
    expect(body.computed.storageBytes).toBeGreaterThan(0)
  })
})
