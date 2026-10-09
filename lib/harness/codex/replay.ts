import type { CompactionEvent, ReplayData, ReplayTurn, ToolCall, TurnUsage } from '@/types/claude'
import { estimateCostFromUsage } from '@/lib/pricing'
import { readJSONLLines } from '@/lib/jsonl'
import {
  isCompaction, isErrorOutput, newTokenUsage, outputText, toolCallName, turnTokens, userPrompt,
  type RolloutLine,
} from './reader'

/** Parsed call arguments: function_call carries a JSON string, custom_tool_call raw input */
function callInput(p: RolloutLine['payload']): Record<string, unknown> {
  if (p.type === 'function_call') {
    try {
      const args = JSON.parse(p.arguments)
      if (args && typeof args === 'object') return args
    } catch { /* not JSON */ }
    return { arguments: p.arguments }
  }
  if (p.type === 'custom_tool_call') return { input: p.input }
  return { action: p.action }
}

/**
 * Rollout items → replay turns. A model response's items (reasoning, message,
 * tool calls) come before the token_count that closes it, so they gather into one
 * assistant turn flushed on that count; tool outputs follow as a user turn of
 * `tool_results`, the way Claude's transcripts carry them.
 */
export async function parseCodexReplay(filePath: string, sessionId: string): Promise<ReplayData> {
  const turns: ReplayTurn[] = []
  const compactions: CompactionEvent[] = []
  const callsById = new Map<string, ToolCall>()
  const seen = { total: -1 }
  let id = sessionId
  let version: string | undefined
  let gitBranch: string | undefined
  let contextWindow: number | undefined
  let model: string | undefined
  let totalCost = 0
  let pending: { timestamp: string; text: string[]; thinking: string[]; hasThinking: boolean; calls: ToolCall[]; durationMs?: number } | null = null
  let taskStartedAt: number | undefined
  // Prompt size of the latest response: the context a compaction starts from
  let contextTokens = 0
  // Outputs written before their response's token_count, pushed once it closes the response
  let pendingResults: NonNullable<ReplayTurn['tool_results']> = []

  const push = (turn: Omit<ReplayTurn, 'uuid' | 'parentUuid'>) => {
    const uuid = `${id}-${turns.length}`
    turns.push({ uuid, parentUuid: turns.at(-1)?.uuid ?? null, ...turn })
  }
  const flush = (usage?: TurnUsage) => {
    if (!pending && !usage) return
    const cost = usage && model ? estimateCostFromUsage(model, usage) : undefined
    if (cost) totalCost += cost
    const last = turns.at(-1)
    if (!pending && last?.type === 'assistant' && !last.usage) {
      // A count closing a response already flushed (by a prompt): its usage goes on that turn
      Object.assign(last, { usage, estimated_cost: cost })
      return
    }
    push({
      type: 'assistant',
      timestamp: pending?.timestamp ?? turns.at(-1)?.timestamp ?? '',
      model,
      usage,
      text: pending?.text.join('\n\n') || undefined,
      tool_calls: pending?.calls.length ? pending.calls : undefined,
      has_thinking: pending?.hasThinking || undefined,
      thinking_text: pending?.thinking.join('\n\n') || undefined,
      estimated_cost: cost,
      turn_duration_ms: pending?.durationMs,
    })
    pending = null
    if (pendingResults.length) {
      push({ type: 'user', timestamp: turns.at(-1)!.timestamp, tool_results: pendingResults })
      pendingResults = []
    }
  }
  const open = (timestamp: string) => (pending ??= { timestamp, text: [], thinking: [], hasThinking: false, calls: [] })

  await readJSONLLines(filePath, (raw) => {
    const line = raw as RolloutLine
    const p = line.payload
    const ts = line.timestamp ?? ''

    if (isCompaction(line)) {
      compactions.push({ uuid: `${id}-compaction-${compactions.length}`, timestamp: ts, trigger: 'auto', pre_tokens: contextTokens, turn_index: turns.length })
    }
    if (line.type === 'session_meta') {
      if (typeof p?.id === 'string') id = p.id
      if (typeof p?.cli_version === 'string') version = p.cli_version
      if (typeof p?.git?.branch === 'string' && p.git.branch) gitBranch = p.git.branch
    } else if (line.type === 'turn_context') {
      if (typeof p?.model === 'string') model = p.model
    } else if (line.type === 'event_msg' && p?.type === 'task_started') {
      taskStartedAt = typeof p.started_at === 'number' ? p.started_at : undefined
    } else if (line.type === 'event_msg' && p?.type === 'task_complete') {
      // Like Claude's turn_duration: the user turn's duration, on its last assistant turn
      if (taskStartedAt !== undefined && typeof p.completed_at === 'number') {
        const durationMs = (p.completed_at - taskStartedAt) * 1000
        const last = turns.findLast(t => t.type === 'assistant')
        if (pending) pending.durationMs = durationMs
        else if (last) last.turn_duration_ms = durationMs
      }
      taskStartedAt = undefined
    } else if (line.type === 'event_msg' && p?.type === 'token_count') {
      if (typeof p.info?.model_context_window === 'number') contextWindow = p.info.model_context_window
      const usage = newTokenUsage(p, seen)
      if (usage) {
        contextTokens = usage.input_tokens ?? 0
        const t = turnTokens(usage)
        flush({ input_tokens: t.input, output_tokens: t.output, cache_read_input_tokens: t.cacheRead, cache_creation_input_tokens: t.cacheWrite })
      }
    } else if (line.type === 'response_item') {
      const prompt = userPrompt(p)
      if (prompt !== null) {
        flush()
        push({ type: 'user', timestamp: ts, text: prompt })
        return
      }
      if (p?.type === 'message' && p.role === 'assistant' && Array.isArray(p.content)) {
        const text = p.content.map((c: { text?: unknown }) => (typeof c.text === 'string' ? c.text : '')).join('')
        if (text) open(ts).text.push(text)
      } else if (p?.type === 'reasoning') {
        const turn = open(ts)
        turn.hasThinking = true
        for (const s of p.summary ?? []) if (typeof s?.text === 'string') turn.thinking.push(s.text)
      } else if (toolCallName(p)) {
        const call: ToolCall = { id: p.call_id ?? p.id ?? `${id}-call-${callsById.size}`, name: toolCallName(p)!, input: callInput(p) }
        callsById.set(call.id, call)
        open(ts).calls.push(call)
      } else if (p?.type === 'function_call_output' || p?.type === 'custom_tool_call_output') {
        const content = outputText(p.output)
        const isError = isErrorOutput(content)
        const call = callsById.get(p.call_id)
        if (call) Object.assign(call, { result: content, is_error: isError })
        const result = { tool_use_id: p.call_id ?? '', content, is_error: isError }
        const last = turns.at(-1)
        // Outputs of one response share a single results turn
        if (pending) pendingResults.push(result)
        else if (last?.type === 'user' && last.tool_results && !last.text) last.tool_results.push(result)
        else push({ type: 'user', timestamp: ts, tool_results: [result] })
      }
    }
  })
  flush()

  return {
    session_id: id,
    harness: 'codex',
    context_window: contextWindow,
    version,
    git_branch: gitBranch,
    turns,
    compactions,
    summaries: [],
    total_cost: totalCost,
  }
}
