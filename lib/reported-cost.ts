// The cost Claude Code reports for a session.
//
// When its process exits, Claude Code appends a `cost-state` line to the
// session's transcript: `totalCostUSD` (the session, its sub-agent and Workflow
// transcripts included), `modelUsage[model].costUSD`, `hasUnknownModelCost` and
// `startTime`. It prices tokens with the rates the running release ships, so it
// is exact where the table in lib/pricing.ts is an estimate: over 49 local
// sessions the table was off by a median 18 % per session. A `--resume` carries
// the line on: the next process keeps its `startTime` and adds to its cost.
//
// The last line covers the whole session only when:
//   - no model call comes after it: otherwise the session is still running, or
//     a later process died before writing its own;
//   - no model call is older than its `startTime`: otherwise an earlier process
//     died without writing one (or ran a Claude Code that did not), and its
//     spend is missing — one such session reported $73 with a whole first hour
//     of Fable 5.1 and 13 agents left out;
//   - Claude Code knew every model's price (`hasUnknownModelCost` false).
// Anything else is priced from the table, and shown as an estimate.

import type { ReportedCost } from '@/types/claude'

export interface CostState {
  total: number
  /** per model id, as the transcript's assistant lines name it */
  byModel: Record<string, number>
  unknownModel: boolean
  /** ms since epoch; null when the line has none */
  startTime: number | null
}

const money = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** Claude Code keys a model by the context it ran with (`claude-opus-5[1m]`); transcripts name it bare */
export function transcriptModelId(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '')
}

/** The content of a `cost-state` line, or null when the line is not one Claude Code wrote whole */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readCostState(line: Record<string, any>): CostState | null {
  if (line?.type !== 'cost-state' || !money(line.totalCostUSD)) return null
  const byModel: Record<string, number> = {}
  for (const [model, usage] of Object.entries(line.modelUsage ?? {})) {
    const cost = (usage as { costUSD?: unknown })?.costUSD
    if (!money(cost)) continue
    const id = transcriptModelId(model)
    byModel[id] = (byModel[id] ?? 0) + cost
  }
  return {
    total: line.totalCostUSD,
    byModel,
    unknownModel: line.hasUnknownModelCost === true,
    startTime: typeof line.startTime === 'number' && Number.isFinite(line.startTime) ? line.startTime : null,
  }
}

/**
 * Claude Code's cost for a session, when its last cost-state line covers every
 * turn of it. `callsAfter` says whether a model call followed that line in the
 * session's own transcript; `turnTimes` are the times of every turn, the
 * sub-agents' included.
 */
export function reportedCost(state: CostState | null, callsAfter: boolean, turnTimes: ArrayLike<number>): ReportedCost | null {
  if (!state || callsAfter || state.unknownModel) return null
  if (state.startTime !== null) {
    for (let i = 0; i < turnTimes.length; i++) if (turnTimes[i] < state.startTime) return null
  }
  return { total: state.total, by_model: state.byModel }
}
