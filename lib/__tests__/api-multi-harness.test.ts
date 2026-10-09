import { describe, it, expect, vi } from 'vitest'
import type { SessionRecord } from '@/lib/harness/types'
import type { Harness } from '@/types/harness'

// No reader for another harness ships yet, so the store is stubbed with a Claude and a Codex session
const session = (harness: Harness, id: string, project_path: string, extra: Record<string, unknown> = {}) => ({
  session: {
    harness, session_id: id, project_path, start_time: '2026-06-01T10:00:00.000Z',
    duration_minutes: 1, user_message_count: 1, assistant_message_count: 1, tool_counts: {}, languages: {},
    ...extra,
  },
  ledger: [], rate_limit_hits: [], git_branches: {},
}) as unknown as SessionRecord

const records = vi.hoisted(() => ({ value: [] as SessionRecord[] }))
vi.mock('@/lib/harness/session-store', () => ({
  getAllSessionRecords: vi.fn(async () => records.value),
  getAllParsedSessions: vi.fn(async () => records.value.map(r => r.session)),
  getSessions: vi.fn(async () => records.value.map(r => r.session)),
}))
vi.mock('@/lib/harness/claude/reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/harness/claude/reader')>()),
  resolveProjectPath: vi.fn(async () => '/Users/me/proj'),
  listProjectSlugs: vi.fn(async () => []),
}))

describe('GET /api/projects/[slug] under a harness filter', () => {
  it('is empty when the project has no session of that harness, even if another project shares its last segment', async () => {
    records.value = [
      session('claude', 'c1', '/Users/me/proj'),
      session('codex', 'x1', '/Users/me/other/proj'),
    ]
    const { GET } = await import('@/app/api/projects/[slug]/route')
    const body = await (await GET(
      new Request('http://localhost/api/projects/-Users-me-proj?h=codex'),
      { params: Promise.resolve({ slug: '-Users-me-proj' }) },
    )).json()
    expect(body.sessions).toEqual([])
  })
})

describe('GET /api/costs Copilot premium requests', () => {
  it('sums them only when a Copilot session reported them', async () => {
    const { GET } = await import('@/app/api/costs/route')
    records.value = [session('claude', 'c1', '/Users/me/proj')]
    expect(await (await GET(new Request('http://localhost/api/costs?range=all'))).json()).not.toHaveProperty('copilot_premium_requests')

    records.value = [
      session('copilot', 'p1', '/Users/me/proj', { copilot: { aiu: 1, premium_requests: 3 } }),
      session('copilot', 'p2', '/Users/me/proj', { copilot: { aiu: 1, premium_requests: 2 } }),
    ]
    expect((await (await GET(new Request('http://localhost/api/costs?range=all'))).json()).copilot_premium_requests).toBe(5)
  })
})

describe('one model under two harnesses', () => {
  const usage = (inputTokens: number) => ({
    model_usage: {
      'claude-sonnet-4-6': { inputTokens, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, webSearchRequests: 0 },
    },
    input_tokens: inputTokens,
    cc_version: '1.0.0',
    tool_counts: { Read: 2 },
  })
  const twoHarnesses = () => {
    records.value = [
      session('claude', 'c1', '/Users/me/proj', usage(1_000_000)),
      session('copilot', 'p1', '/Users/me/proj', usage(3_000_000)),
    ]
  }

  it('gives costs one row per harness and splits each day by harness', async () => {
    twoHarnesses()
    const { GET } = await import('@/app/api/costs/route')
    const body = await (await GET(new Request('http://localhost/api/costs?range=all'))).json()

    const rows = body.models.map((m: { harness: string; model: string; input_tokens: number }) => `${m.harness}:${m.model}:${m.input_tokens}`)
    expect(rows.sort()).toEqual(['claude:claude-sonnet-4-6:1000000', 'copilot:claude-sonnet-4-6:3000000'])
    const [day] = body.daily
    expect(day.by_harness.copilot).toBeCloseTo(3 * day.by_harness.claude)
    expect(day.by_harness.claude + day.by_harness.copilot).toBeCloseTo(day.total)
    expect(body.harnesses.sort()).toEqual(['claude', 'copilot'])
  })

  it('counts each harness on the shared project card', async () => {
    twoHarnesses()
    const { GET } = await import('@/app/api/projects/route')
    const { projects } = await (await GET(new Request('http://localhost/api/projects'))).json()

    expect(projects).toHaveLength(1)
    expect(projects[0].by_harness.claude.sessions).toBe(1)
    expect(projects[0].by_harness.copilot.sessions).toBe(1)
  })

  it('gives tools and versions one row per harness', async () => {
    twoHarnesses()
    const { GET } = await import('@/app/api/tools/route')
    const body = await (await GET(new Request('http://localhost/api/tools'))).json()

    expect(body.tools.map((t: { harness: string; name: string; total_calls: number }) => `${t.harness}:${t.name}:${t.total_calls}`).sort())
      .toEqual(['claude:Read:2', 'copilot:Read:2'])
    expect(body.versions.map((v: { harness: string; version: string }) => `${v.harness}:${v.version}`).sort())
      .toEqual(['claude:1.0.0', 'copilot:1.0.0'])
  })
})
