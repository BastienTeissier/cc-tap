import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { makeClaudeHome, claudeTranscript } from './helpers/harness-home'

const SESSION_ID = 'e1e1e1e1-0000-0000-0000-000000000000'
let home: Awaited<ReturnType<typeof makeClaudeHome>>

beforeAll(async () => {
  home = await makeClaudeHome([
    { id: SESSION_ID, slug: '-Users-test-proj', jsonl: claudeTranscript({ cwd: '/Users/test/proj', start: '2026-06-01T10:00:00.000Z' }) },
  ])
})

afterAll(() => home.cleanup())

describe('GET /api/harnesses', () => {
  it('lists the detected harnesses and the dir of each', async () => {
    const { GET } = await import('@/app/api/harnesses/route')
    const body = await (await GET()).json()

    expect(body).toEqual({ detected: ['claude'], dirs: { claude: home.claudeDir, codex: null, copilot: null } })
  })
})

describe('GET/POST /api/export', () => {
  it('exports version 1.1.0 with each session\'s harness', async () => {
    const { POST } = await import('@/app/api/export/route')
    const body = await (await POST(new Request('http://localhost/api/export', { method: 'POST', body: '{}' }))).json()

    expect(body.version).toBe('1.1.0')
    expect(body.sessions.map((s: { session_id: string; harness: string }) => `${s.harness}:${s.session_id}`)).toEqual([`claude:${SESSION_ID}`])
  })

  it('exports only the selected harnesses', async () => {
    const { POST, GET } = await import('@/app/api/export/route')
    const body = await (await POST(new Request('http://localhost/api/export?h=codex', { method: 'POST', body: '{}' }))).json()
    expect(body.sessions).toEqual([])
    expect((await (await GET(new Request('http://localhost/api/export?h=codex'))).json()).sessionCount).toBe(0)
  })
})

describe('POST /api/import', () => {
  it('reads sessions of a 1.0.0 export as Claude sessions', async () => {
    const { POST } = await import('@/app/api/import/route')
    const payload = {
      exportedAt: '2026-06-10T00:00:00.000Z', version: '1.0.0', stats: null, facets: [], history: [],
      sessions: [{ session_id: 'imported-1', start_time: '2026-06-01T10:00:00.000Z' }],
    }
    const diff = await (await POST(new Request('http://localhost/api/import', { method: 'POST', body: JSON.stringify(payload) }))).json()

    expect(diff.sessions_to_add).toHaveLength(1)
    expect(diff.sessions_to_add[0].harness).toBe('claude')
  })
})

describe('POST /api/export/team', () => {
  it('exports version 1.1.0 with the harnesses and their versions', async () => {
    const { POST } = await import('@/app/api/export/team/route')
    const body = await (await POST(new Request('http://localhost/api/export/team', { method: 'POST', body: JSON.stringify({ memberName: 'Alice' }) }))).json()

    expect(body).toMatchObject({
      version: '1.1.0',
      harnesses: ['claude'],
      versions_by_harness: { claude: ['2.1.62'] },
      cc_versions: ['2.1.62'],
    })
    expect(body.sessions[0].harness).toBe('claude')
  })
})
