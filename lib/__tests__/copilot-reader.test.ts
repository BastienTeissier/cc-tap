import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { copilotAdapter } from '@/lib/harness/copilot/adapter'
import { parseWorkspaceYaml } from '@/lib/harness/copilot/reader'
import { usageDbMtimeMs } from '@/lib/harness/copilot/usage-db'
import type { SessionFileEntry, SessionRecord } from '@/lib/harness/types'
import { COPILOT_A as A, COPILOT_B as B, makeCopilotHome } from './helpers/copilot-home'

let saved: string | undefined
let root: string
let entries: SessionFileEntry[]
let a: SessionRecord
let b: SessionRecord

beforeAll(async () => {
  saved = process.env.COPILOT_HOME
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-lens-copilot-'))
  await makeCopilotHome(root)
  process.env.COPILOT_HOME = root
  entries = await copilotAdapter.listSessionFiles()
  a = (await copilotAdapter.parseSession(entries.find(e => e.session_id === A)!))!
  b = (await copilotAdapter.parseSession(entries.find(e => e.session_id === B)!))!
})

afterAll(async () => {
  if (saved === undefined) delete process.env.COPILOT_HOME
  else process.env.COPILOT_HOME = saved
  await fs.rm(root, { recursive: true, force: true })
})

describe('copilot reader', () => {
  it('lists one session per session-state dir', () => {
    expect(entries.map(e => e.session_id).sort()).toEqual([A, B])
    expect(entries.every(e => e.harness === 'copilot' && e.path.endsWith('events.jsonl'))).toBe(true)
  })

  it('dates a session by its events or the DB, whichever is newer', async () => {
    const dbMtime = usageDbMtimeMs()
    expect(dbMtime).toBeGreaterThan(0)
    for (const e of entries) {
      const { mtimeMs } = await fs.stat(e.path)
      expect(e.mtimeMs).toBe(Math.max(mtimeMs, dbMtime))
    }
  })

  it('builds the ledger from the usage rows, sub-agent calls apart', () => {
    expect(a.session.assistant_message_count).toBe(2)
    expect(a.session.agent_count).toBe(1)
    // model_usage covers every call; agent_model_usage is the sub-agents' share of it
    expect(Object.keys(a.session.model_usage ?? {}).sort()).toEqual(['claude-haiku-4-5', 'gpt-5.5'])
    expect(Object.keys(a.session.agent_model_usage ?? {})).toEqual(['claude-haiku-4-5'])
    // input_tokens counts the cached parts: fresh input is what remains
    expect(a.session.input_tokens).toBe(300 + 500 + 300)
    expect(a.session.cache_read_input_tokens).toBe(1600)
    expect(a.session.cache_creation_input_tokens).toBe(100)
  })

  it('does not count reasoning tokens twice', () => {
    expect(a.session.output_tokens).toBe(200 + 100 + 30)
  })

  it('counts tools and their failures from the events', () => {
    expect(a.session.tool_counts).toEqual({ view: 2, bash: 1 })
    expect(a.session.tool_errors).toBe(1)
    expect(a.session.uses_task_agent).toBe(false)
    expect(a.session.has_thinking).toBe(true)
  })

  it('flags the task tool as a task agent', () => {
    expect(b.session.uses_task_agent).toBe(true)
    expect(b.session.tool_counts).toEqual({ task: 1 })
  })

  it('reports AI units and premium requests, from the checkpoint when the DB has no rows', () => {
    expect(a.session.copilot).toEqual({ aiu: 3, premium_requests: 2 })
    expect(b.session.copilot).toEqual({ aiu: 0.5, premium_requests: 1 })
    expect(a.session.reported_cost).toBeNull()
    // Without rows the turns still count, with no tokens
    expect(b.session.assistant_message_count).toBe(1)
    expect(b.session.input_tokens).toBe(0)
  })

  it('takes the CLI version, prompt and place of the session', () => {
    expect(a.session.cc_version).toBe('1.0.93')
    expect(a.session.first_prompt).toBe('Fix the bug')
    expect(a.session.ai_title).toBe('Fix the bug')
    // workspace.yaml wins over session.start's context
    expect(a.session.git_branch).toBe('feat')
    expect(a.git_branches).toEqual({ feat: 16 })
    expect(b.session).toMatchObject({ cwd: '/Users/test/other', git_branch: 'dev', cc_version: '1.0.90' })
  })

  it('reads the flat keys of workspace.yaml', () => {
    expect(parseWorkspaceYaml('id: x\ncwd: /a b\nname: "Quoted: yes"\nsummary: \'single\'\n  nested: no\n# comment\n'))
      .toEqual({ id: 'x', cwd: '/a b', name: 'Quoted: yes', summary: 'single' })
  })
})
