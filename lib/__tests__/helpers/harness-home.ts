import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { vi } from 'vitest'

const ENV = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COPILOT_HOME', 'HOME', 'CC_LENS_CONFIG_DIR'] as const

export const line = (o: Record<string, unknown>) => JSON.stringify(o)

/** A user + assistant exchange in a Claude transcript */
export function claudeTranscript(opts: { cwd: string; start: string; model?: string; version?: string; branch?: string; prompt?: string }): string {
  const end = new Date(new Date(opts.start).getTime() + 60_000).toISOString()
  return [
    line({ type: 'user', timestamp: opts.start, cwd: opts.cwd, version: opts.version ?? '2.1.62', gitBranch: opts.branch ?? 'main', message: { content: opts.prompt ?? 'Hi' } }),
    line({ type: 'assistant', timestamp: end, gitBranch: opts.branch ?? 'main', message: { model: opts.model ?? 'claude-sonnet-5-5', usage: { input_tokens: 1000, output_tokens: 100 }, content: [] } }),
  ].join('\n')
}

/**
 * A temp home holding only a Claude dir with the given transcripts, keyed by session id,
 * grouped under the project dir named after their cwd. Codex and Copilot dirs point at
 * missing paths so a developer's real dirs never leak in. Modules are reset so the
 * session cache starts empty.
 */
export async function makeClaudeHome(sessions: Array<{ id: string; slug: string; jsonl: string }>) {
  const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]))
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-lens-home-'))
  const claudeDir = path.join(root, '.claude')
  for (const s of sessions) {
    const dir = path.join(claudeDir, 'projects', s.slug)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, `${s.id}.jsonl`), s.jsonl)
  }
  await fs.mkdir(claudeDir, { recursive: true })
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = claudeDir
  process.env.CODEX_HOME = path.join(root, '.codex')
  process.env.COPILOT_HOME = path.join(root, '.copilot')
  process.env.CC_LENS_CONFIG_DIR = path.join(root, '.cc-lens')
  vi.resetModules()

  return {
    root,
    claudeDir,
    async cleanup() {
      for (const k of ENV) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
      vi.resetModules()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}
