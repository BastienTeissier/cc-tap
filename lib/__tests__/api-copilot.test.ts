import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { makeClaudeHome, claudeTranscript } from './helpers/harness-home'
import { COPILOT_A, COPILOT_B, makeCopilotHome } from './helpers/copilot-home'
import { pathToSlug } from '@/lib/decode'

// A Claude transcript and the Copilot fixtures, read through the registry
const CLAUDE = 'c3c3c3c3-0000-0000-0000-000000000000'
const CWD = '/Users/test/proj'
let home: Awaited<ReturnType<typeof makeClaudeHome>>
const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeAll(async () => {
  home = await makeClaudeHome([
    { id: CLAUDE, slug: pathToSlug(CWD), jsonl: claudeTranscript({ cwd: CWD, start: '2026-09-25T10:00:00.000Z' }) },
  ])
  await makeCopilotHome(process.env.COPILOT_HOME!)
})

afterAll(() => home.cleanup())

describe('Copilot sessions through the API', () => {
  it('lists Copilot sessions with the others', async () => {
    const { GET } = await import('@/app/api/sessions/route')
    const body = await (await GET(new NextRequest('http://localhost/api/sessions?h=copilot'))).json()
    expect(body.sessions.map((s: { session_id: string }) => s.session_id).sort()).toEqual([COPILOT_A, COPILOT_B])
    const all = await (await GET(new NextRequest('http://localhost/api/sessions'))).json()
    expect(all.sessions).toHaveLength(3)
  })

  it('replays a Copilot session with usage on its assistant turns', async () => {
    const { GET } = await import('@/app/api/sessions/[id]/replay/route')
    const res = await GET(new Request('http://localhost/'), params(COPILOT_A))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ session_id: COPILOT_A, harness: 'copilot' })
    const assistant = body.turns.filter((t: { type: string }) => t.type === 'assistant')
    expect(assistant).toHaveLength(2)
    expect(assistant.every((t: { usage?: { output_tokens: number } }) => (t.usage?.output_tokens ?? 0) > 0)).toBe(true)
  })

  it('categorizes Copilot tools with the Copilot map', async () => {
    const { GET } = await import('@/app/api/tools/route')
    const body = await (await GET(new Request('http://localhost/api/tools?h=copilot'))).json()
    const category = (name: string) => body.tools.find((t: { name: string }) => t.name === name)?.category
    expect(category('view')).toBe('file-io')
    expect(category('bash')).toBe('shell')
    expect(category('task')).toBe('agent')
  })

  it('costs Copilot rows by AI units and totals its premium requests', async () => {
    const { GET } = await import('@/app/api/costs/route')
    const body = await (await GET(new Request('http://localhost/api/costs?range=all&h=copilot'))).json()
    expect(body.copilot_premium_requests).toBe(3)
    const cost = (model: string) => body.models.find((m: { model: string }) => m.model === model)?.estimated_cost
    // 1 AIU per call at $0.01; session B's checkpoint (0.5 AIU) goes to its model
    expect(cost('gpt-5.5')).toBeCloseTo(0.02)
    expect(cost('claude-haiku-4-5')).toBeCloseTo(0.01)
    expect(cost('claude-sonnet-5-5')).toBeCloseTo(0.005)
    expect(body.models.every((m: { priced_as?: string }) => m.priced_as === undefined)).toBe(true)
  })
})
