import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// The store caches per module instance, so it is imported fresh after env setup.
let tmpDir: string
let previousClaudeConfigDir: string | undefined
let store: typeof import('@/lib/harness/session-store')
let adapter: typeof import('@/lib/harness/claude/adapter')

const SESSION_ID = 'b1b1b1b1-0000-0000-0000-000000000000'
const OTHER_ID = 'c2c2c2c2-0000-0000-0000-000000000000'

const line = (o: Record<string, unknown>) => JSON.stringify(o)

const sessionLines = [
  line({ type: 'user', timestamp: '2026-06-01T10:00:00.000Z', cwd: '/Users/test/proj', version: '2.1.62', gitBranch: 'main', message: { content: 'Hi' } }),
  line({ type: 'assistant', timestamp: '2026-06-01T10:01:00.000Z', gitBranch: 'main', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1, output_tokens: 1 }, content: [] } }),
  line({ type: 'user', timestamp: '2026-06-01T10:02:00.000Z', gitBranch: 'feat', message: { content: 'More' } }),
  line({ type: 'user', timestamp: '2026-06-01T10:03:00.000Z', gitBranch: 'HEAD', message: { content: 'Detached' } }),
]
const otherLines = [
  line({ type: 'user', timestamp: '2026-05-01T10:00:00.000Z', cwd: '/Users/test/proj', version: '2.1.50', gitBranch: 'main', message: { content: 'Older' } }),
]

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-lens-store-'))
  const projectDir = path.join(tmpDir, 'projects', '-Users-test-proj')
  await fs.mkdir(projectDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, `${SESSION_ID}.jsonl`), sessionLines.join('\n'))
  await fs.writeFile(path.join(projectDir, `${OTHER_ID}.jsonl`), otherLines.join('\n'))

  previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  vi.resetModules()
  store = await import('@/lib/harness/session-store')
  adapter = await import('@/lib/harness/claude/adapter')
})

afterAll(async () => {
  if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir
  vi.resetModules()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('session store', () => {
  it('tags every Claude session with the claude harness', async () => {
    const sessions = await store.getAllParsedSessions()
    expect(sessions.map(s => s.session_id)).toEqual([SESSION_ID, OTHER_ID])
    expect(sessions.every(s => s.harness === 'claude')).toBe(true)
  })

  it('counts lines per git branch in the parsing pass, skipping HEAD', async () => {
    const [session] = await store.getAllParsedSessions()
    expect(session.git_branches).toEqual({ main: 2, feat: 1 })
    expect(session.git_branch).toBe('main')
  })

  it('reparses a file only when its mtime changes', async () => {
    await store.getAllParsedSessions()
    const parse = vi.spyOn(adapter.claudeAdapter, 'parseSession')
    try {
      await store.getAllParsedSessions()
      expect(parse).not.toHaveBeenCalled()

      const file = path.join(tmpDir, 'projects', '-Users-test-proj', `${OTHER_ID}.jsonl`)
      const later = new Date(Date.now() + 60_000)
      await fs.utimes(file, later, later)
      await store.getAllParsedSessions()
      expect(parse).toHaveBeenCalledTimes(1)
      expect(parse.mock.calls[0][0].session_id).toBe(OTHER_ID)
    } finally {
      parse.mockRestore()
    }
  })

  it('keeps the old reader module working as a re-export', async () => {
    const reader = await import('@/lib/claude-reader')
    expect((await reader.getSessions()).map(s => s.session_id)).toEqual([SESSION_ID, OTHER_ID])
    expect(await reader.findSessionJSONL(SESSION_ID)).toContain(`${SESSION_ID}.jsonl`)
  })
})

describe('GET /api/tools', () => {
  it('builds versions and branches from the parsed sessions', async () => {
    const { GET } = await import('@/app/api/tools/route')
    const body = await (await GET()).json()

    expect(body.versions.map((v: { version: string }) => v.version).sort()).toEqual(['2.1.50', '2.1.62'])
    expect(body.versions.find((v: { version: string }) => v.version === '2.1.62')).toMatchObject({
      session_count: 1, first_seen: '2026-06-01T10:00:00.000Z',
    })
    expect(body.branches).toEqual([{ branch: 'main', turns: 3 }, { branch: 'feat', turns: 1 }])
  })
})

describe('GET /api/projects', () => {
  it('lists the branches its sessions recorded', async () => {
    const { GET } = await import('@/app/api/projects/route')
    const body = await (await GET()).json()

    expect(body.projects).toHaveLength(1)
    expect(body.projects[0].branches.sort()).toEqual(['feat', 'main'])
  })
})
