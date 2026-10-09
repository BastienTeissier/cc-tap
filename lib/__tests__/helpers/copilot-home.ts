import fs from 'fs/promises'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'

export const COPILOT_FIXTURES = path.join(__dirname, '..', 'fixtures', 'copilot')
export const COPILOT_A = '11111111-0000-4000-8000-00000000000a'
export const COPILOT_B = '22222222-0000-4000-8000-00000000000b'

type Row = { session_id: string; agent_id?: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; nanoAiu: number; at: string }

/** Session A's billed calls: two main-agent turns and one sub-agent call between them */
export const COPILOT_ROWS: Row[] = [
  { session_id: COPILOT_A, model: 'gpt-5.5', input: 1000, output: 200, cacheRead: 600, cacheWrite: 100, reasoning: 50, nanoAiu: 1e9, at: '2026-10-02T10:00:05.000Z' },
  { session_id: COPILOT_A, agent_id: 'agent-1', model: 'claude-haiku-4-5', input: 300, output: 30, cacheRead: 0, cacheWrite: 0, reasoning: 0, nanoAiu: 1e9, at: '2026-10-02T10:00:08.000Z' },
  { session_id: COPILOT_A, model: 'gpt-5.5', input: 1500, output: 100, cacheRead: 1000, cacheWrite: 0, reasoning: 0, nanoAiu: 1e9, at: '2026-10-02T10:00:15.000Z' },
]

/** The fixtures copied into `home`, with a session-store.db (schema v8) holding `rows` */
export async function makeCopilotHome(home: string, rows: Row[] = COPILOT_ROWS) {
  await fs.cp(COPILOT_FIXTURES, home, { recursive: true })
  const db = new DatabaseSync(path.join(home, 'session-store.db'))
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, summary TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
      turn_index INTEGER, agent_id TEXT, parent_tool_call_id TEXT, model TEXT NOT NULL, copilot_usage_model TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
      total_nano_aiu INTEGER, request_multiplier REAL, duration_ms INTEGER, time_to_first_token_ms INTEGER, output_ttft_ms REAL,
      inter_token_latency_ms INTEGER, initiator TEXT, api_endpoint TEXT, reasoning_effort TEXT, finish_reason TEXT,
      content_filter_triggered INTEGER, token_details_json TEXT, created_at TEXT DEFAULT (datetime('now')));`)
  const session = db.prepare('INSERT INTO sessions (id) VALUES (?)')
  for (const id of [COPILOT_A, COPILOT_B]) session.run(id)
  const insert = db.prepare(`INSERT INTO assistant_usage_events (session_id, turn_index, agent_id, model, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, reasoning_tokens, total_nano_aiu, request_multiplier, created_at) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
  for (const r of rows) {
    insert.run(r.session_id, r.agent_id ?? null, r.model, r.input, r.output, r.cacheRead, r.cacheWrite, r.reasoning, r.nanoAiu, r.at)
  }
  db.close()
}
