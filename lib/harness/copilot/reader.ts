import fs from 'fs/promises'
import path from 'path'
import type { ParsedSession, SessionRecord } from '@/lib/harness/types'
import { LedgerBuilder, NO_MODEL, ledgerMetrics } from '@/lib/session-ledger'
import { readJSONLLines } from '@/lib/jsonl'
import { pathToSlug } from '@/lib/decode'
import { isMcpTool } from '@/lib/tool-categories'
import { mainRowsByTurn, usageFor, type CopilotUsageRow } from './usage-db'

// Copilot CLI sessions (~/.copilot/session-state/<id>/): events.jsonl holds one
// `{type, data, id, timestamp, parentId}` event per line and gives the structure;
// the token counts live in ~/.copilot/session-store.db (usage-db.ts). Without the
// DB a session still lists, with no tokens.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CopilotEvent = { type?: string; timestamp?: string; id?: string; data?: any }

/** The event's time, or '' when missing or unparseable */
export function eventTime(e: CopilotEvent): string {
  return typeof e.timestamp === 'string' && Number.isFinite(Date.parse(e.timestamp)) ? e.timestamp : ''
}

/** Top-level `key: value` pairs of workspace.yaml, quotes removed. Enough for the flat
 *  file Copilot writes; nested or multi-line values are not read. */
export function parseWorkspaceYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_][\w-]*):[ \t]*(.*?)[ \t]*$/.exec(line)
    if (!m) continue
    const quoted = /^(['"])(.*)\1$/.exec(m[2])
    out[m[1]] = quoted ? quoted[2] : m[2]
  }
  return out
}

export async function readWorkspace(sessionDir: string): Promise<Record<string, string>> {
  try {
    return parseWorkspaceYaml(await fs.readFile(path.join(sessionDir, 'workspace.yaml'), 'utf8'))
  } catch {
    return {}
  }
}

/** Ledger token fields of one billed call: the prompt counts minus the cached parts */
export function rowTokens(r: CopilotUsageRow) {
  const cacheRead = r.cache_read_tokens ?? 0
  const cacheWrite = r.cache_write_tokens ?? 0
  return {
    input: Math.max(0, (r.input_tokens ?? 0) - cacheRead - cacheWrite),
    output: r.output_tokens ?? 0,
    cacheRead,
    cacheWrite,
  }
}

export async function parseCopilotSession(eventsPath: string, sessionId: string): Promise<SessionRecord | null> {
  let id = sessionId
  let startTime = ''
  let lastTime = ''
  let cwd: string | undefined
  let version: string | undefined
  let gitBranch: string | undefined
  let model = NO_MODEL
  let firstPrompt = ''
  let toolErrors = 0
  let hasMcp = false
  let hasThinking = false
  let usesTask = false
  let usesWebFetch = false
  let premiumRequests = 0
  let checkpointNanoAiu = 0
  let lineCount = 0
  const toolCounts: Record<string, number> = {}
  const messageHours: number[] = []
  const userMessageTimestamps: string[] = []
  const userTs: number[] = []
  // The main agent's turns in order: when each started, its model and tool calls
  const turns: Array<{ ts: number; model: string; toolCalls: number }> = []

  await readJSONLLines(eventsPath, (raw) => {
    const e = raw as CopilotEvent
    const d = e.data
    const ts = eventTime(e)
    lineCount++
    if (ts) {
      if (!startTime) startTime = ts
      lastTime = ts
    }
    switch (e.type) {
      case 'session.start':
        if (typeof d?.sessionId === 'string') id = d.sessionId
        if (typeof d?.copilotVersion === 'string') version = d.copilotVersion
        if (typeof d?.context?.cwd === 'string') cwd = d.context.cwd
        if (typeof d?.context?.branch === 'string' && d.context.branch) gitBranch = d.context.branch
        break
      case 'session.model_change':
        if (typeof d?.newModel === 'string') model = d.newModel
        break
      case 'user.message': {
        const text = typeof d?.content === 'string' ? d.content.trim() : ''
        const at = Date.parse(ts)
        if (Number.isFinite(at)) {
          messageHours.push(new Date(at).getHours())
          userMessageTimestamps.push(ts)
          userTs.push(at)
        }
        if (!firstPrompt && text) firstPrompt = text.slice(0, 500)
        break
      }
      case 'assistant.turn_start':
        turns.push({ ts: Date.parse(ts), model, toolCalls: 0 })
        break
      case 'assistant.message': {
        const turn = turns.at(-1)
        if (turn) {
          if (typeof d?.model === 'string') turn.model = d.model
          turn.toolCalls += Array.isArray(d?.toolRequests) ? d.toolRequests.length : 0
        }
        if (d?.reasoningText || d?.reasoningOpaque) hasThinking = true
        break
      }
      case 'tool.execution_start': {
        const name = d?.toolName
        if (typeof name !== 'string') break
        toolCounts[name] = (toolCounts[name] ?? 0) + 1
        if (isMcpTool(name, 'copilot')) hasMcp = true
        if (name === 'task') usesTask = true
        if (name === 'web_fetch') usesWebFetch = true
        break
      }
      case 'tool.execution_complete':
        if (d?.success === false) toolErrors++
        break
      case 'session.usage_checkpoint':
        if (typeof d?.totalPremiumRequests === 'number') premiumRequests = d.totalPremiumRequests
        if (typeof d?.totalNanoAiu === 'number') checkpointNanoAiu = d.totalNanoAiu
        break
    }
  })

  if (!startTime) return null

  const workspace = await readWorkspace(path.dirname(eventsPath))
  cwd = workspace.cwd || cwd
  gitBranch = workspace.branch || gitBranch

  // Tokens come from the DB; sub-agent rows join as agent turns
  const rows = usageFor(id)
  const main = mainRowsByTurn(rows ?? [])
  const ledger = new LedgerBuilder()
  for (const at of userTs) ledger.addUser(at)
  const count = Math.max(turns.length, main.length)
  for (let i = 0; i < count; i++) {
    const turn = turns[i]
    const row = main[i]
    const t = row ? rowTokens(row) : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    ledger.addTurn({
      ts: turn?.ts ?? Date.parse(row.created_at),
      model: row?.model ?? turn?.model ?? model,
      ...t,
      toolCalls: turn?.toolCalls ?? 0,
    })
  }
  const agentIds = new Set<string>()
  for (const row of rows ?? []) {
    if (!row.agent_id) continue
    agentIds.add(row.agent_id)
    ledger.addTurn({ ts: Date.parse(row.created_at), model: row.model, ...rowTokens(row), toolCalls: 0, isAgent: true })
  }

  const durationMinutes = (Date.parse(lastTime) - Date.parse(startTime)) / 60_000
  const built = ledger.build()
  const m = ledgerMetrics(built, null, durationMinutes, null)
  // Without rows in the DB, the last checkpoint still carries the session's AI units
  const nanoAiu = rows?.length ? rows.reduce((sum, r) => sum + (r.total_nano_aiu ?? 0), 0) : checkpointNanoAiu

  const session: ParsedSession = {
    session_id: id,
    harness: 'copilot',
    project_path: cwd ?? '',
    start_time: startTime,
    last_activity: lastTime,
    duration_minutes: durationMinutes,
    user_message_count: m.user_message_count,
    assistant_message_count: m.assistant_message_count,
    tool_counts: toolCounts,
    languages: {},
    git_commits: 0,
    git_pushes: 0,
    input_tokens: m.input_tokens,
    output_tokens: m.output_tokens,
    cache_creation_input_tokens: m.cache_creation_input_tokens,
    cache_read_input_tokens: m.cache_read_input_tokens,
    first_prompt: firstPrompt,
    user_interruptions: 0,
    user_response_times: [],
    tool_errors: toolErrors,
    tool_error_categories: {},
    uses_task_agent: usesTask,
    uses_mcp: hasMcp,
    uses_web_search: false,
    uses_web_fetch: usesWebFetch,
    lines_added: 0,
    lines_removed: 0,
    files_modified: 0,
    message_hours: messageHours,
    user_message_timestamps: userMessageTimestamps,
    model_usage: m.model_usage,
    agent_model_usage: m.agent_model_usage,
    agent_count: agentIds.size,
    copilot: { aiu: nanoAiu / 1e9, premium_requests: premiumRequests },
    reported_cost: null,
    cwd,
    slug_name: cwd ? pathToSlug(cwd) : undefined,
    ai_title: workspace.name || undefined,
    cc_version: version,
    git_branch: gitBranch,
    has_compaction: false,
    has_thinking: hasThinking,
  }
  const gitBranches = gitBranch && gitBranch !== 'HEAD' ? { [gitBranch]: lineCount } : {}
  return { session, ledger: built, rate_limit_hits: [], git_branches: gitBranches }
}
