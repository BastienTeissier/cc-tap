import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { makeClaudeHome, claudeTranscript } from './helpers/harness-home'

const EARLY = 'a1a1a1a1-0000-0000-0000-000000000000'
const LATE = 'a2a2a2a2-0000-0000-0000-000000000000'
let home: Awaited<ReturnType<typeof makeClaudeHome>>

beforeAll(async () => {
  home = await makeClaudeHome([
    { id: EARLY, slug: '-Users-test-proj', jsonl: claudeTranscript({ cwd: '/Users/test/proj', start: '2026-06-01T10:00:00.000Z' }) },
    { id: LATE, slug: '-Users-test-proj', jsonl: claudeTranscript({ cwd: '/Users/test/proj', start: '2026-06-03T10:00:00.000Z' }) },
  ])
})

afterAll(() => home.cleanup())

async function list(query: string): Promise<string[]> {
  const { GET } = await import('@/app/api/sessions/route')
  const body = await (await GET(new NextRequest(`http://localhost/api/sessions${query}`))).json()
  return body.sessions.map((s: { session_id: string; harness: string }) => `${s.harness}:${s.session_id}`)
}

describe('GET /api/sessions harness filter', () => {
  it('keeps every session without h, or with an empty h', async () => {
    expect(await list('')).toEqual([`claude:${LATE}`, `claude:${EARLY}`])
    expect(await list('?h=')).toEqual([`claude:${LATE}`, `claude:${EARLY}`])
  })

  it('keeps only the selected harnesses', async () => {
    expect(await list('?h=claude')).toHaveLength(2)
    expect(await list('?h=codex')).toEqual([])
  })

  it('selects nothing when every harness is unknown', async () => {
    expect(await list('?h=foo')).toEqual([])
  })

  it('slices the time window after the harness filter', async () => {
    const window = '&from=2026-06-02T00:00:00.000Z&to=2026-06-04T00:00:00.000Z'
    expect(await list(`?h=claude${window}`)).toEqual([`claude:${LATE}`])
    expect(await list(`?h=codex${window}`)).toEqual([])
  })
})
