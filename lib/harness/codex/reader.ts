import type { ParsedSession, RateLimitHit, SessionRecord } from '@/lib/harness/types'
import { LedgerBuilder, NO_MODEL, ledgerMetrics } from '@/lib/session-ledger'
import { readJSONLLines } from '@/lib/jsonl'
import { pathToSlug } from '@/lib/decode'
import { isMcpTool } from '@/lib/tool-categories'

// Codex CLI rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl): one
// `{timestamp, type, payload}` record per line. Rollouts written before Sept 2025 have
// no session_meta line and no token counts; they are skipped.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RolloutLine = { timestamp?: string; type?: string; payload?: any }

export interface TokenUsage {
  input_tokens?: number
  cached_input_tokens?: number
  cache_write_input_tokens?: number
  output_tokens?: number
  total_tokens?: number
}

/** Ledger fields of one response: Codex's input_tokens includes the cached part */
export function turnTokens(u: TokenUsage) {
  const cacheRead = u.cached_input_tokens ?? 0
  return {
    input: Math.max(0, (u.input_tokens ?? 0) - cacheRead),
    output: u.output_tokens ?? 0,
    cacheRead,
    cacheWrite: u.cache_write_input_tokens ?? 0,
  }
}

/**
 * The response's usage of a token_count event, or null for one that adds nothing: Codex
 * repeats the event (same running total) and writes some with `info: null`.
 * `seen` carries the running total between calls.
 */
export function newTokenUsage(payload: RolloutLine['payload'], seen: { total: number }): TokenUsage | null {
  const info = payload?.info
  if (!info?.last_token_usage) return null
  const total = info.total_token_usage?.total_tokens
  if (typeof total === 'number') {
    if (total === seen.total) return null
    seen.total = total
  }
  return info.last_token_usage
}

// Messages with role=user that Codex injects itself
const INJECTED_PREFIXES = ['<environment_context>', '# AGENTS.md instructions', '<user_instructions>', '<skill>', '<turn_aborted>']
// The VS Code extension wraps the prompt after the IDE context
const IDE_REQUEST = '## My request for Codex:'

/** What the user typed, or null for a message Codex injected */
export function userPrompt(payload: RolloutLine['payload']): string | null {
  if (payload?.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) return null
  const text = payload.content
    .filter((c: { type?: string; text?: unknown }) => c.type === 'input_text' && typeof c.text === 'string')
    .map((c: { text: string }) => c.text)
    .join('\n')
    .trim()
  if (!text || INJECTED_PREFIXES.some(p => text.startsWith(p))) return null
  const ide = text.indexOf(IDE_REQUEST)
  return ide >= 0 ? text.slice(ide + IDE_REQUEST.length).trim() : text
}

/** Tool name of a call item, or null when the item is not a tool call */
export function toolCallName(payload: RolloutLine['payload']): string | null {
  if (payload?.type === 'function_call' || payload?.type === 'custom_tool_call') return payload.name ?? null
  if (payload?.type === 'web_search_call') return 'web_search'
  return null
}

/** A function_call_output's text: a string, or the text parts of a list */
export function outputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output.map(o => (typeof o?.text === 'string' ? o.text : '')).filter(Boolean).join('\n')
  }
  return ''
}

const EXIT_CODE = /^Exit code: (\d+)/m
const PROCESS_EXIT = /Process exited with code (\d+)/
const FAILURES = ['failed in sandbox', 'apply_patch verification failed', 'patch rejected']

/** Whether a tool output reports a failure: a non-zero exit code or a rejected patch */
export function isErrorOutput(text: string): boolean {
  try {
    const json = JSON.parse(text)
    const code = json?.metadata?.exit_code
    if (typeof code === 'number') return code !== 0
  } catch { /* plain text */ }
  const exit = EXIT_CODE.exec(text) ?? PROCESS_EXIT.exec(text)
  if (exit) return exit[1] !== '0'
  return FAILURES.some(f => text.includes(f))
}

/** Compaction markers; none observed in local data yet (unverified names) */
export function isCompaction(line: RolloutLine): boolean {
  return line.type === 'compacted' || (line.type === 'event_msg' && line.payload?.type === 'context_compacted')
}

export async function parseCodexSession(filePath: string, sessionId: string): Promise<SessionRecord | null> {
  let hasMeta = false
  let id = sessionId
  let startTime = ''
  let lastTime = ''
  let cwd: string | undefined
  let cliVersion: string | undefined
  let gitBranch: string | undefined
  let model = NO_MODEL
  let firstPrompt = ''
  let pendingToolCalls = 0
  let toolErrors = 0
  let hasMcp = false
  let hasWebSearch = false
  let hasCompaction = false
  let hasThinking = false
  let lineCount = 0
  const toolCounts: Record<string, number> = {}
  const messageHours: number[] = []
  const userMessageTimestamps: string[] = []
  const rateLimitResets = new Set<number>()
  const rateLimitHits: RateLimitHit[] = []
  const seen = { total: -1 }
  const ledger = new LedgerBuilder()

  await readJSONLLines(filePath, (raw) => {
    const line = raw as RolloutLine
    const p = line.payload
    const ts = typeof line.timestamp === 'string' ? line.timestamp : ''
    lineCount++
    if (ts) {
      if (!startTime) startTime = ts
      lastTime = ts
    }
    if (isCompaction(line)) hasCompaction = true

    if (line.type === 'session_meta') {
      hasMeta = true
      if (typeof p?.id === 'string') id = p.id
      if (typeof p?.cwd === 'string') cwd = p.cwd
      if (typeof p?.cli_version === 'string') cliVersion = p.cli_version
      if (typeof p?.git?.branch === 'string' && p.git.branch) gitBranch = p.git.branch
    } else if (line.type === 'turn_context') {
      if (typeof p?.model === 'string') model = p.model
      if (!cwd && typeof p?.cwd === 'string') cwd = p.cwd
    } else if (line.type === 'response_item') {
      const prompt = userPrompt(p)
      if (prompt !== null) {
        const d = new Date(ts)
        if (!isNaN(d.getTime())) {
          messageHours.push(d.getHours())
          userMessageTimestamps.push(ts)
          ledger.addUser(d.getTime())
        }
        if (!firstPrompt) firstPrompt = prompt.slice(0, 500)
      }
      const tool = toolCallName(p)
      if (tool) {
        toolCounts[tool] = (toolCounts[tool] ?? 0) + 1
        pendingToolCalls++
        if (isMcpTool(tool, 'codex')) hasMcp = true
        if (tool === 'web_search') hasWebSearch = true
      }
      if ((p?.type === 'function_call_output' || p?.type === 'custom_tool_call_output') && isErrorOutput(outputText(p.output))) {
        toolErrors++
      }
      if (p?.type === 'reasoning') hasThinking = true
    } else if (line.type === 'event_msg' && p?.type === 'token_count') {
      const primary = p.rate_limits?.primary
      if (typeof primary?.used_percent === 'number' && primary.used_percent >= 100 && typeof primary.resets_at === 'number' && ts) {
        const resetsAt = primary.resets_at * 1000
        if (!rateLimitResets.has(resetsAt)) {
          rateLimitResets.add(resetsAt)
          rateLimitHits.push({ ts: new Date(ts).getTime(), resets_at: resetsAt })
        }
      }
      const usage = newTokenUsage(p, seen)
      if (usage && ts) {
        // The response's items come before its token_count: its tool calls are the pending ones
        ledger.addTurn({ ts: new Date(ts).getTime(), model, ...turnTokens(usage), toolCalls: pendingToolCalls })
        pendingToolCalls = 0
      }
    }
  })

  if (!hasMeta || !startTime) return null

  const start = new Date(startTime).getTime()
  const end = new Date(lastTime).getTime()
  const durationMinutes = (end - start) / 60_000
  const turns = ledger.build()
  const m = ledgerMetrics(turns, null, durationMinutes, null)

  const session: ParsedSession = {
    session_id: id,
    harness: 'codex',
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
    uses_task_agent: false,
    uses_mcp: hasMcp,
    uses_web_search: hasWebSearch,
    uses_web_fetch: false,
    lines_added: 0,
    lines_removed: 0,
    files_modified: 0,
    message_hours: messageHours,
    user_message_timestamps: userMessageTimestamps,
    model_usage: m.model_usage,
    reported_cost: null,
    cwd,
    slug_name: cwd ? pathToSlug(cwd) : undefined,
    cc_version: cliVersion,
    git_branch: gitBranch,
    has_compaction: hasCompaction,
    has_thinking: hasThinking,
  }
  // The rollout records one branch, the one the session started on
  const gitBranches = gitBranch && gitBranch !== 'HEAD' ? { [gitBranch]: lineCount } : {}
  return { session, ledger: turns, rate_limit_hits: rateLimitHits, git_branches: gitBranches }
}
