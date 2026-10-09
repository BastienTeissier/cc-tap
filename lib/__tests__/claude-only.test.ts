import { describe, it, expect, vi } from 'vitest'

// A session another harness recorded: no reader for one ships yet, so the store is stubbed
vi.mock('@/lib/harness/session-store', () => ({
  findSessionEntry: vi.fn(async (id: string) =>
    id === 'codex-1' ? { harness: 'codex', session_id: id, path: '/x/rollout.jsonl', mtimeMs: 0 } : null),
}))

const params = (id: string) => ({ params: Promise.resolve({ id }) })

describe('Claude-only session views for another harness', () => {
  it('answer 404 naming the harness', async () => {
    const { GET } = await import('@/app/api/sessions/[id]/agents/route')
    const res = await GET(new Request('http://localhost/'), params('codex-1'))

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not available for codex sessions' })
  })

  it('answer the same on search and workflow runs', async () => {
    const search = await import('@/app/api/sessions/[id]/search/route')
    const res = await search.GET(new Request('http://localhost/?q=x'), params('codex-1'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not available for codex sessions' })

    const workflows = await import('@/app/api/sessions/[id]/workflows/[runId]/route')
    const run = await workflows.GET(new Request('http://localhost/'), { params: Promise.resolve({ id: 'codex-1', runId: 'wf_aaaaaaaa-111' }) })
    expect(run.status).toBe(404)
    expect(await run.json()).toEqual({ error: 'not available for codex sessions' })
  })
})
