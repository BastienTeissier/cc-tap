import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import { NextRequest } from 'next/server'
import { makeClaudeHome, claudeTranscript } from './helpers/harness-home'
import { pathToSlug } from '@/lib/decode'

// A real Claude transcript and the Codex fixtures on the same cwd, read through the registry
const CLAUDE = 'c3c3c3c3-0000-0000-0000-000000000000'
const CODEX = 'aaaaaaaa-0000-4000-8000-000000000001'
const ARCHIVED = 'bbbbbbbb-0000-4000-8000-000000000002'
const CWD = '/Users/test/proj'
let home: Awaited<ReturnType<typeof makeClaudeHome>>
const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeAll(async () => {
  home = await makeClaudeHome([
    { id: CLAUDE, slug: pathToSlug(CWD), jsonl: claudeTranscript({ cwd: CWD, start: '2026-09-25T10:00:00.000Z', branch: 'feat' }) },
  ])
  await fs.cp(path.join(__dirname, 'fixtures', 'codex'), process.env.CODEX_HOME!, { recursive: true })
})

afterAll(() => home.cleanup())

describe('Codex sessions through the API', () => {
  it('lists sessions of both harnesses, newest first', async () => {
    const { GET } = await import('@/app/api/sessions/route')
    const body = await (await GET(new NextRequest('http://localhost/api/sessions'))).json()
    expect(body.sessions.map((s: { harness: string; session_id: string }) => `${s.harness}:${s.session_id}`))
      .toEqual([`codex:${CODEX}`, `claude:${CLAUDE}`, `codex:${ARCHIVED}`])

    const codexOnly = await (await GET(new NextRequest('http://localhost/api/sessions?h=codex'))).json()
    expect(codexOnly.sessions.every((s: { harness: string }) => s.harness === 'codex')).toBe(true)
  })

  it('gives costs one row per harness and model', async () => {
    const { GET } = await import('@/app/api/costs/route')
    const body = await (await GET(new Request('http://localhost/api/costs?range=all'))).json()
    expect(body.models.map((m: { harness: string; model: string }) => `${m.harness}:${m.model}`).sort())
      .toEqual(['claude:claude-sonnet-5-5', 'codex:gpt-5.3-codex', 'codex:gpt-5.5'])
  })

  it('categorizes Codex tools with the Codex map', async () => {
    const { GET } = await import('@/app/api/tools/route')
    const body = await (await GET(new Request('http://localhost/api/tools?h=codex'))).json()
    const category = (name: string) => body.tools.find((t: { name: string }) => t.name === name)?.category
    expect(category('exec_command')).toBe('shell')
    expect(category('apply_patch')).toBe('file-io')
    expect(body.mcp_servers.map((s: { server_name: string }) => s.server_name)).toEqual(['github'])
    expect(body.versions.map((v: { harness: string; version: string }) => `${v.harness}:${v.version}`).sort())
      .toEqual(['codex:0.8.0', 'codex:0.9.0'])
  })

  it('merges both harnesses on one project card per cwd', async () => {
    const { GET } = await import('@/app/api/projects/route')
    const { projects } = await (await GET(new Request('http://localhost/api/projects'))).json()
    const card = projects.find((p: { project_path: string }) => p.project_path === CWD)
    expect(card).toMatchObject({ slug: pathToSlug(CWD), session_count: 2 })
    expect(Object.keys(card.by_harness).sort()).toEqual(['claude', 'codex'])
    expect(card.branches.sort()).toEqual(['feat', 'main'])

    const detail = await import('@/app/api/projects/[slug]/route')
    const body = await (await detail.GET(new Request(`http://localhost/api/projects/${card.slug}`), { params: Promise.resolve({ slug: card.slug }) })).json()
    expect(body.sessions.map((s: { harness: string }) => s.harness).sort()).toEqual(['claude', 'codex'])
  })

  it('replays a Codex session and changes its ETag when the rollout grows', async () => {
    const { GET } = await import('@/app/api/sessions/[id]/replay/route')
    const res = await GET(new Request('http://localhost/'), params(CODEX))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ session_id: CODEX, harness: 'codex', context_window: 400000 })
    expect(body.turns.length).toBeGreaterThan(0)

    const file = path.join(process.env.CODEX_HOME!, 'sessions', '2026', '10', '01', `rollout-2026-10-01T10-00-00-${CODEX}.jsonl`)
    await fs.appendFile(file, JSON.stringify({ timestamp: '2026-10-01T10:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'More' }] } }) + '\n')
    const later = new Date(Date.now() + 60_000)
    await fs.utimes(file, later, later)
    const again = await GET(new Request('http://localhost/'), params(CODEX))
    expect(again.headers.get('etag')).not.toBe(res.headers.get('etag'))
  })

  it('answers 404 for the agents of a Codex session', async () => {
    const { GET } = await import('@/app/api/sessions/[id]/agents/route')
    expect((await GET(new Request('http://localhost/'), params(CODEX))).status).toBe(404)
  })

  it('serves insights, digest and wrapped over both harnesses', async () => {
    const routes = [
      await import('@/app/api/insights/route'),
      await import('@/app/api/digest/route'),
      await import('@/app/api/wrapped/route'),
    ]
    for (const { GET } of routes) {
      expect((await GET(new Request('http://localhost/'))).status).toBe(200)
    }
  })
})
