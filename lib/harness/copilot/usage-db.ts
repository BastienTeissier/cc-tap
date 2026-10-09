import fs from 'fs'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import { harnessDir } from '@/lib/harness/dirs'

/** One model call Copilot CLI billed: a row of session-store.db's assistant_usage_events (schema v8).
 *  input_tokens counts the whole prompt, cache reads and writes included; output_tokens
 *  includes reasoning_tokens (verified against token_details_json). */
export interface CopilotUsageRow {
  session_id: string
  turn_index: number | null
  /** null on the main agent's calls; a sub-agent's id otherwise */
  agent_id: string | null
  parent_tool_call_id: string | null
  model: string
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  reasoning_tokens: number | null
  total_nano_aiu: number | null
  request_multiplier: number | null
  created_at: string
  token_details_json: string | null
}

const COLUMNS = 'session_id, turn_index, agent_id, parent_tool_call_id, model, input_tokens, output_tokens, '
  + 'cache_read_tokens, cache_write_tokens, reasoning_tokens, total_nano_aiu, request_multiplier, created_at, token_details_json'

function usageDbPath(): string {
  return path.join(harnessDir('copilot'), 'session-store.db')
}

// Opened once per path, read-only; COPILOT_HOME can change between calls (tests)
let opened: { path: string; db: DatabaseSync } | null = null

function getDb(): DatabaseSync | null {
  const file = usageDbPath()
  if (opened?.path === file) return opened.db
  // A readOnly open of a missing file throws: no DB means events-only sessions
  if (!fs.existsSync(file)) return null
  try {
    opened?.db.close()
    opened = { path: file, db: new DatabaseSync(file, { readOnly: true }) }
    return opened.db
  } catch {
    return null
  }
}

let warned = false

/** Sessions then show no tokens: say why once, not once per session */
function warnOnce(err: unknown) {
  if (warned) return
  warned = true
  console.warn('[cc-tap] could not read Copilot usage from session-store.db:', err)
}

/** The session's billed calls, oldest first; null when the DB is absent or unreadable */
export function usageFor(sessionId: string): CopilotUsageRow[] | null {
  const db = getDb()
  if (!db) return null
  try {
    return db.prepare(`SELECT ${COLUMNS} FROM assistant_usage_events WHERE session_id = ? ORDER BY created_at, id`)
      .all(sessionId) as unknown as CopilotUsageRow[]
  } catch (err) {
    warnOnce(err)
    return null // locked, or another schema
  }
}

/** The main agent's calls indexed by turn: the nth is the nth assistant.turn_start.
 *  turn_index is always 0 in schema v8, so call order is the only join key. */
export function mainRowsByTurn(rows: CopilotUsageRow[]): CopilotUsageRow[] {
  return rows.filter(r => !r.agent_id)
}

/** Time of each session's latest billed call, by session id; empty when the DB is absent or unreadable.
 *  One query per scan: a write for one session must not date the others. */
export function lastUsageMs(): Map<string, number> {
  const db = getDb()
  const last = new Map<string, number>()
  if (!db) return last
  try {
    const rows = db.prepare('SELECT session_id, MAX(created_at) AS at FROM assistant_usage_events GROUP BY session_id')
      .all() as unknown as Array<{ session_id: string; at: string }>
    for (const r of rows) {
      const at = Date.parse(r.at)
      if (Number.isFinite(at)) last.set(r.session_id, at)
    }
  } catch (err) {
    warnOnce(err) // locked, or another schema
  }
  return last
}
