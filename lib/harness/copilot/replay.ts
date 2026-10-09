import type { ReplayData, ReplayTurn, ToolCall, TurnUsage } from '@/types/claude'
import { estimateCostFromUsage } from '@/lib/pricing'
import { readJSONLLines } from '@/lib/jsonl'
import { eventTime, rowCostUSD, rowTokens, sessionStart, type CopilotEvent } from './reader'
import { mainRowsByTurn, usageFor, type CopilotUsageRow } from './usage-db'

/** A tool result's text: its content, or the error Copilot reported */
function resultText(d: CopilotEvent['data']): string {
  if (typeof d?.result?.content === 'string') return d.result.content
  if (typeof d?.error?.message === 'string') return d.error.message
  if (typeof d?.error === 'string') return d.error
  return ''
}

/**
 * events.jsonl → replay turns. Each assistant.turn_start…turn_end span is one model
 * call, so one assistant turn, its usage taken from the nth main-agent row of the DB.
 * The tool results of a span follow it as a user turn of `tool_results`, the way
 * Claude's transcripts carry them.
 */
export async function parseCopilotReplay(eventsPath: string, sessionId: string): Promise<ReplayData> {
  const turns: ReplayTurn[] = []
  const callsById = new Map<string, ToolCall>()
  let id = sessionId
  let version: string | undefined
  let gitBranch: string | undefined
  let model: string | undefined
  let totalCost = 0
  let turnCount = 0
  let rows: CopilotUsageRow[] | null = null
  // `spanned`: opened by assistant.turn_start, so it owns the next usage row
  let pending: { timestamp: string; spanned: boolean; model?: string; text: string[]; thinking: string[]; hasThinking: boolean; calls: ToolCall[] } | null = null
  let results: NonNullable<ReplayTurn['tool_results']> = []

  const push = (turn: Omit<ReplayTurn, 'uuid' | 'parentUuid'>) => {
    const uuid = `${id}-${turns.length}`
    turns.push({ uuid, parentUuid: turns.at(-1)?.uuid ?? null, ...turn })
  }
  // Results go after the turn that asked for them, even when written after its turn_end
  const flushResults = () => {
    if (!results.length) return
    push({ type: 'user', timestamp: turns.at(-1)?.timestamp ?? '', tool_results: results })
    results = []
  }
  const flush = (endTs?: string) => {
    if (!pending) return flushResults()
    rows ??= mainRowsByTurn(usageFor(id) ?? [])
    const row = pending.spanned ? rows[turnCount++] : undefined
    let usage: TurnUsage | undefined
    let cost: number | undefined
    if (row) {
      const t = rowTokens(row)
      usage = { input_tokens: t.input, output_tokens: t.output, cache_read_input_tokens: t.cacheRead, cache_creation_input_tokens: t.cacheWrite }
      // What Copilot billed for the call, else the token table's estimate
      cost = rowCostUSD(row) ?? estimateCostFromUsage(row.model, usage)
    }
    const turnModel = row?.model ?? pending.model
    if (cost) totalCost += cost
    const duration = endTs ? Date.parse(endTs) - Date.parse(pending.timestamp) : NaN
    push({
      type: 'assistant',
      timestamp: pending.timestamp,
      model: turnModel,
      usage,
      text: pending.text.join('\n\n') || undefined,
      tool_calls: pending.calls.length ? pending.calls : undefined,
      has_thinking: pending.hasThinking || undefined,
      thinking_text: pending.thinking.join('\n\n') || undefined,
      estimated_cost: cost,
      turn_duration_ms: Number.isFinite(duration) ? duration : undefined,
    })
    pending = null
    flushResults()
  }

  await readJSONLLines(eventsPath, (raw) => {
    const e = raw as CopilotEvent
    const d = e.data
    const ts = eventTime(e)
    switch (e.type) {
      case 'session.start': {
        const start = sessionStart(d)
        id = start.id ?? id
        version = start.version ?? version
        gitBranch = start.branch ?? gitBranch
        break
      }
      case 'session.model_change':
        if (typeof d?.newModel === 'string') model = d.newModel
        break
      case 'user.message': {
        flush()
        const text = typeof d?.content === 'string' ? d.content.trim() : ''
        if (text) push({ type: 'user', timestamp: ts, text })
        break
      }
      case 'assistant.turn_start':
        flush()
        pending = { timestamp: ts, spanned: true, model, text: [], thinking: [], hasThinking: false, calls: [] }
        break
      case 'assistant.message': {
        // A message outside a turn span: shown, but no billed call of its own
        pending ??= { timestamp: ts, spanned: false, model, text: [], thinking: [], hasThinking: false, calls: [] }
        if (typeof d?.model === 'string') pending.model = d.model
        if (typeof d?.content === 'string' && d.content) pending.text.push(d.content)
        if (typeof d?.reasoningText === 'string' && d.reasoningText) pending.thinking.push(d.reasoningText)
        if (d?.reasoningText || d?.reasoningOpaque) pending.hasThinking = true
        for (const r of Array.isArray(d?.toolRequests) ? d.toolRequests : []) {
          if (typeof r?.name !== 'string') continue
          const call: ToolCall = { id: r.toolCallId ?? `${id}-call-${callsById.size}`, name: r.name, input: r.arguments ?? {} }
          callsById.set(call.id, call)
          pending.calls.push(call)
        }
        break
      }
      case 'tool.execution_complete': {
        const content = resultText(d)
        const isError = d?.success === false
        const call = callsById.get(d?.toolCallId)
        if (call) Object.assign(call, { result: content, is_error: isError })
        results.push({ tool_use_id: d?.toolCallId ?? '', content, is_error: isError })
        break
      }
      case 'assistant.turn_end':
        flush(ts)
        break
    }
  })
  flush()

  return {
    session_id: id,
    harness: 'copilot',
    version,
    git_branch: gitBranch,
    turns,
    compactions: [],
    summaries: [],
    total_cost: totalCost,
  }
}
