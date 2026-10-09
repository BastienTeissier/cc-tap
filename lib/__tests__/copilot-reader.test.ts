import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { copilotAdapter } from '@/lib/harness/copilot/adapter'
import { parseWorkspaceYaml } from '@/lib/harness/copilot/reader'
import type { SessionFileEntry, SessionRecord } from '@/lib/harness/types'
import { sessionCost } from '@/lib/pricing'
import { sliceSession } from '@/lib/session-ledger'
import { COPILOT_A as A, COPILOT_B as B, COPILOT_ROWS, makeCopilotHome, withCopilotHome } from './helpers/copilot-home'

const copilot = withCopilotHome()
let entries: SessionFileEntry[]
let a: SessionRecord
let b: SessionRecord

beforeAll(async () => {
  entries = await copilotAdapter.listSessionFiles()
  a = (await copilotAdapter.parseSession(entries.find(e => e.session_id === A)!))!
  b = (await copilotAdapter.parseSession(entries.find(e => e.session_id === B)!))!
})

describe('copilot reader', () => {
  it('lists one session per session-state dir', () => {
    expect(entries.map(e => e.session_id).sort()).toEqual([A, B])
    expect(entries.every(e => e.harness === 'copilot' && e.path.endsWith('events.jsonl'))).toBe(true)
  })

  it('dates a session by its events or its own latest usage row, whichever is newer', async () => {
    const lastRowA = Date.parse('2026-10-02T10:00:15.000Z')
    const pathOf = (id: string) => entries.find(e => e.session_id === id)!.path
    const mtimeOf = async (id: string) => (await copilotAdapter.listSessionFiles()).find(e => e.session_id === id)!.mtimeMs
    const older = new Date(lastRowA - 60_000)
    const newer = new Date(lastRowA + 60_000)

    await fs.utimes(pathOf(A), older, older)
    await fs.utimes(pathOf(B), older, older)
    expect(await mtimeOf(A)).toBe(lastRowA)
    // B has no rows: A's write does not date it
    expect(await mtimeOf(B)).toBe(older.getTime())

    await fs.utimes(pathOf(A), newer, newer)
    expect(await mtimeOf(A)).toBe(newer.getTime())
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
    // Each call's AI units at $0.01: 1 AIU per row
    expect(a.session.reported_cost?.total).toBeCloseTo(0.03)
    expect(a.session.reported_cost?.by_model['gpt-5.5']).toBeCloseTo(0.02)
    expect(a.session.reported_cost?.by_model['claude-haiku-4-5']).toBeCloseTo(0.01)
    expect(b.session.reported_cost).toEqual({ total: 0.005, by_model: { 'claude-sonnet-5-5': 0.005 } })
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

  it('dates a turn with an unusable time by its usage row', async () => {
    const C = '33333333-0000-4000-8000-00000000000c'
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-lens-copilot-'))
    try {
      await makeCopilotHome(home, [...COPILOT_ROWS, { session_id: C, model: 'gpt-5.5', input: 100, output: 7, cacheRead: 0, cacheWrite: 0, reasoning: 0, nanoAiu: 0, at: '2026-10-03T10:00:02.000Z' }])
      await fs.mkdir(path.join(home, 'session-state', C))
      await fs.writeFile(path.join(home, 'session-state', C, 'events.jsonl'), [
        { type: 'session.start', timestamp: '2026-10-03T10:00:00.000Z', data: { sessionId: C } },
        { type: 'assistant.turn_start', timestamp: 'not a time', data: {} },
      ].map(e => JSON.stringify(e)).join('\n'))
      process.env.COPILOT_HOME = home
      const entry = (await copilotAdapter.listSessionFiles()).find(e => e.session_id === C)!
      const c = (await copilotAdapter.parseSession(entry))!
      expect(c.session.assistant_message_count).toBe(1)
      expect(c.session.output_tokens).toBe(7)
    } finally {
      process.env.COPILOT_HOME = copilot.root
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  it('costs the session what Copilot billed, model by model', () => {
    expect(sessionCost(a.session)).toBeCloseTo(0.03)
    expect(a.session.model_usage?.['gpt-5.5'].costUSD).toBeCloseTo(0.02)
    expect(a.session.agent_model_usage?.['claude-haiku-4-5'].costUSD).toBeCloseTo(0.01)
    expect(sessionCost(b.session)).toBeCloseTo(0.005)
  })

  it('costs a window what its calls billed', () => {
    const w = { from: Date.parse('2026-10-02T10:00:10.000Z'), to: Date.parse('2026-10-02T10:00:20.000Z') }
    const slice = sliceSession({ session: a.session, ledger: a.ledger }, w)!
    expect(slice.estimated_cost).toBeCloseTo(0.01, 5)
    expect(Object.keys(slice.model_usage)).toEqual(['gpt-5.5'])
  })
})
