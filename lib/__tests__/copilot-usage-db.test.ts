import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import { lastUsageMs, usageFor } from '@/lib/harness/copilot/usage-db'
import { COPILOT_A, COPILOT_B, makeCopilotHome } from './helpers/copilot-home'

let saved: string | undefined
let root: string

beforeAll(async () => {
  saved = process.env.COPILOT_HOME
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-lens-copilot-'))
})

afterAll(async () => {
  if (saved === undefined) delete process.env.COPILOT_HOME
  else process.env.COPILOT_HOME = saved
  await fs.rm(root, { recursive: true, force: true })
})

describe('copilot usage db', () => {
  it('yields null when the DB is missing', () => {
    process.env.COPILOT_HOME = path.join(root, 'missing')
    expect(usageFor(COPILOT_A)).toBeNull()
  })

  it('reads a session\'s rows oldest first', async () => {
    const home = path.join(root, 'home')
    await makeCopilotHome(home)
    process.env.COPILOT_HOME = home
    const rows = usageFor(COPILOT_A)!
    expect(rows.map(r => [r.agent_id, r.model])).toEqual([[null, 'gpt-5.5'], ['agent-1', 'claude-haiku-4-5'], [null, 'gpt-5.5']])
    expect(rows[0]).toMatchObject({ input_tokens: 1000, cache_read_tokens: 600, cache_write_tokens: 100, output_tokens: 200 })
    expect(usageFor(COPILOT_B)).toEqual([])
  })

  it('warns once when the table cannot be read', async () => {
    const home = path.join(root, 'other-schema')
    await fs.mkdir(home)
    new DatabaseSync(path.join(home, 'session-store.db')).exec('CREATE TABLE sessions (id TEXT)')
    process.env.COPILOT_HOME = home
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(usageFor(COPILOT_A)).toBeNull()
      expect(lastUsageMs().size).toBe(0)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})
