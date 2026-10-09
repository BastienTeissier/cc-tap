import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const ENV = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COPILOT_HOME'] as const
let saved: Record<string, string | undefined>
let tmpDir: string

beforeEach(async () => {
  saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]))
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-lens-registry-'))
  vi.resetModules()
})

afterEach(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('harness registry', () => {
  it('detects only the harness dirs that exist', async () => {
    await fs.mkdir(path.join(tmpDir, 'claude'))
    process.env.CLAUDE_CONFIG_DIR = path.join(tmpDir, 'claude')
    process.env.CODEX_HOME = path.join(tmpDir, 'missing-codex')
    process.env.COPILOT_HOME = path.join(tmpDir, 'missing-copilot')
    const { detectedHarnesses } = await import('@/lib/harness/registry')
    const { existingHarnessDir } = await import('@/lib/harness/dirs')

    expect(detectedHarnesses()).toEqual(['claude'])
    expect(existingHarnessDir('codex')).toBeNull()
  })

  it('honors each harness env override', async () => {
    process.env.CLAUDE_CONFIG_DIR = '/x/claude'
    process.env.CODEX_HOME = '/x/codex'
    process.env.COPILOT_HOME = '/x/copilot'
    const { harnessDir } = await import('@/lib/harness/dirs')

    expect(harnessDir('claude')).toBe('/x/claude')
    expect(harnessDir('codex')).toBe('/x/codex')
    expect(harnessDir('copilot')).toBe('/x/copilot')
  })

  it('defaults to the dot dirs under the home dir', async () => {
    for (const k of ENV) delete process.env[k]
    const { harnessDir } = await import('@/lib/harness/dirs')

    expect(harnessDir('codex')).toBe(path.join(os.homedir(), '.codex'))
    expect(harnessDir('copilot')).toBe(path.join(os.homedir(), '.copilot'))
  })
})
