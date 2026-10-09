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
