import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { makeClaudeHome, claudeTranscript } from './helpers/harness-home'

let home: Awaited<ReturnType<typeof makeClaudeHome>>

beforeAll(async () => {
  home = await makeClaudeHome([
    { id: 'd1d1d1d1-0000-0000-0000-000000000000', slug: '-Users-test-proj', jsonl: claudeTranscript({ cwd: '/Users/test/proj', start: '2026-06-01T10:00:00.000Z', branch: 'main' }) },
    { id: 'd2d2d2d2-0000-0000-0000-000000000000', slug: '-Users-test-proj', jsonl: claudeTranscript({ cwd: '/Users/test/proj', start: '2026-06-02T10:00:00.000Z', branch: 'feat' }) },
  ])
})

afterAll(() => home.cleanup())

describe('GET /api/projects harness dimensions', () => {
  it('counts sessions and cost per harness on each card', async () => {
    const { GET } = await import('@/app/api/projects/route')
    const { projects } = await (await GET(new Request('http://localhost/api/projects'))).json()

    expect(projects).toHaveLength(1)
    expect(projects[0].slug).toBe('-Users-test-proj')
    expect(projects[0].by_harness.claude.sessions).toBe(2)
    expect(projects[0].by_harness.claude.estimated_cost).toBeCloseTo(projects[0].estimated_cost)
  })

  it('lists no project when the filter selects another harness', async () => {
    const { GET } = await import('@/app/api/projects/route')
    const { projects } = await (await GET(new Request('http://localhost/api/projects?h=codex'))).json()
    expect(projects).toEqual([])
  })
})

describe('GET /api/projects/[slug]', () => {
  it('builds sessions and branches from the parsed records', async () => {
    const { GET } = await import('@/app/api/projects/[slug]/route')
    const body = await (await GET(new Request('http://localhost/api/projects/-Users-test-proj'), { params: Promise.resolve({ slug: '-Users-test-proj' }) })).json()

    expect(body.sessions.map((s: { harness: string; version: string }) => `${s.harness}:${s.version}`)).toEqual(['claude:2.1.62', 'claude:2.1.62'])
    expect(body.branches).toEqual(expect.arrayContaining([{ branch: 'main', turns: 2 }, { branch: 'feat', turns: 2 }]))
    expect(body.branches).toHaveLength(2)
  })

  it('keeps only the selected harnesses', async () => {
    const { GET } = await import('@/app/api/projects/[slug]/route')
    const body = await (await GET(new Request('http://localhost/api/projects/-Users-test-proj?h=codex'), { params: Promise.resolve({ slug: '-Users-test-proj' }) })).json()
    expect(body.sessions).toEqual([])
  })
})
