import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { makeClaudeHome, claudeTranscript } from './helpers/harness-home'

const SESSION_ID = 'b2b2b2b2-0000-0000-0000-000000000000'
let home: Awaited<ReturnType<typeof makeClaudeHome>>
const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeAll(async () => {
  home = await makeClaudeHome([
    { id: SESSION_ID, slug: '-Users-test-proj', jsonl: claudeTranscript({ cwd: '/Users/test/proj', start: '2026-06-01T10:00:00.000Z' }) },
  ])
})

afterAll(() => home.cleanup())

describe('GET /api/sessions/[id]/replay', () => {
  it('replays a session found through the session store, tagged with its harness', async () => {
    const { GET } = await import('@/app/api/sessions/[id]/replay/route')
    const res = await GET(new Request('http://localhost/'), params(SESSION_ID))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ session_id: SESSION_ID, harness: 'claude' })
    expect(body.turns.length).toBeGreaterThan(0)

    const again = await GET(new Request('http://localhost/', { headers: { 'if-none-match': res.headers.get('etag')! } }), params(SESSION_ID))
    expect(again.status).toBe(304)
  })

  it('answers 404 for an unknown session', async () => {
    const { GET } = await import('@/app/api/sessions/[id]/replay/route')
    expect((await GET(new Request('http://localhost/'), params('missing'))).status).toBe(404)
  })
})

describe('Claude-only session views', () => {
  it('serve a Claude session', async () => {
    const { GET } = await import('@/app/api/sessions/[id]/agents/route')
    expect((await GET(new Request('http://localhost/'), params(SESSION_ID))).status).toBe(200)
  })

  it('answer 404 for an unknown session', async () => {
    const { GET } = await import('@/app/api/sessions/[id]/agents/route')
    expect((await GET(new Request('http://localhost/'), params('missing'))).status).toBe(404)
  })
})
