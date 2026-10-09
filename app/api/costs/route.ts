import { NextResponse } from 'next/server'
import { getSessions } from '@/lib/harness/session-store'
import { harnessesFromSearch, filterByHarness } from '@/lib/harness-filter'
import { FALLBACK_MODEL, estimateTotalCostFromModel, cacheEfficiency, hasKnownPricing, pricedAs, usageCost } from '@/lib/pricing'
import { projectDisplayName } from '@/lib/decode'
import type { CostAnalytics, ModelCostBreakdown, DailyCost, ProjectCost, ModelUsage, SessionMeta } from '@/types/claude'
import type { Harness } from '@/types/harness'
import { harnessRowKey as rowKey, splitHarnessRowKey } from '@/lib/harness/row-key'

export const dynamic = 'force-dynamic'

type CostRange = '30d' | '90d' | 'all'

function parseRange(value: string | null): CostRange {
  if (value === '30d' || value === '90d' || value === 'all') return value
  return '90d'
}

function rangeCutoff(range: CostRange): string | null {
  if (range === 'all') return null
  const days = range === '30d' ? 30 : 90
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - (days - 1))
  return date.toISOString().slice(0, 10)
}

function emptyUsage(): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUSD: 0,
    webSearchRequests: 0,
  }
}

function addUsage(target: ModelUsage, usage: ModelUsage) {
  target.inputTokens += usage.inputTokens ?? 0
  target.outputTokens += usage.outputTokens ?? 0
  target.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0
  target.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0
  target.cacheCreation1hInputTokens = (target.cacheCreation1hInputTokens ?? 0) + (usage.cacheCreation1hInputTokens ?? 0)
  target.costUSD += usage.costUSD ?? 0
  target.webSearchRequests += usage.webSearchRequests ?? 0
}

function sessionModelUsage(session: SessionMeta): Record<string, ModelUsage> {
  if (session.model_usage && Object.keys(session.model_usage).length > 0) {
    return session.model_usage
  }
  const usage: ModelUsage = {
    inputTokens: session.input_tokens ?? 0,
    outputTokens: session.output_tokens ?? 0,
    cacheCreationInputTokens: session.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: session.cache_read_input_tokens ?? 0,
    costUSD: 0,
    webSearchRequests: 0,
  }
  // Priced here, like the ledger prices the others: a model's costUSD is summed across sessions
  return { [FALLBACK_MODEL]: { ...usage, costUSD: estimateTotalCostFromModel(FALLBACK_MODEL, usage) } }
}

/** Adds a session's usage to rows keyed by rowKey(harness, model), skipping synthetic and empty models */
function addSessionUsage(rows: Record<string, ModelUsage>, session: SessionMeta) {
  for (const [model, usage] of Object.entries(sessionModelUsage(session))) {
    const tokenTotal =
      (usage.inputTokens ?? 0) +
      (usage.outputTokens ?? 0) +
      (usage.cacheReadInputTokens ?? 0) +
      (usage.cacheCreationInputTokens ?? 0)
    if (model === '<synthetic>' || (tokenTotal === 0 && !(usage.costUSD > 0))) continue
    const key = rowKey(session.harness, model)
    addUsage(rows[key] ??= emptyUsage(), usage)
  }
}

export async function GET(req: Request) {
  const range = parseRange(new URL(req.url).searchParams.get('range'))
  const cutoff = rangeCutoff(range)
  const sessions = filterByHarness(await getSessions(), harnessesFromSearch(new URL(req.url).search))

  const filteredSessions = cutoff
    ? sessions.filter(s => s.start_time.slice(0, 10) >= cutoff)
    : sessions

  // Keyed by rowKey(harness, model)
  const modelUsage: Record<string, ModelUsage> = {}
  // Rows of the sessions priced from the table: only those can be charged at a borrowed rate
  const estimatedModels = new Set<string>()
  let sessionsEstimated = 0
  for (const session of filteredSessions) {
    if (!session.reported_cost) {
      sessionsEstimated++
      for (const model of Object.keys(sessionModelUsage(session))) estimatedModels.add(rowKey(session.harness, model))
    }
  }
  for (const session of filteredSessions) {
    addSessionUsage(modelUsage, session)
  }

  // ── Per-model breakdown ────────────────────────────────────────────────────
  let totalCost = 0
  let totalSavings = 0
  const models: ModelCostBreakdown[] = Object.entries(modelUsage).map(([key, usage]) => {
    const { harness, name: model } = splitHarnessRowKey(key)
    const cost = usageCost(model, usage)
    const eff = cacheEfficiency(model, usage)
    totalCost += cost
    totalSavings += eff.savedUSD
    return {
      harness,
      model,
      input_tokens: usage.inputTokens ?? 0,
      output_tokens: usage.outputTokens ?? 0,
      cache_write_tokens: usage.cacheCreationInputTokens ?? 0,
      cache_read_tokens: usage.cacheReadInputTokens ?? 0,
      estimated_cost: cost,
      cache_savings: eff.savedUSD ?? 0,
      cache_hit_rate: eff.hitRate ?? 0,
      ...(estimatedModels.has(key) && !hasKnownPricing(model) ? { priced_as: pricedAs(model) } : {}),
    }
  }).sort((a, b) => b.estimated_cost - a.estimated_cost)

  // ── Daily cost by model and by harness ────────────────────────────────────
  // Keyed by rowKey(harness, model)
  const dailyUsage = new Map<string, Record<string, ModelUsage>>()
  for (const session of filteredSessions) {
    const date = session.start_time.slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const day = dailyUsage.get(date) ?? {}
    addSessionUsage(day, session)
    dailyUsage.set(date, day)
  }

  const daily: DailyCost[] = [...dailyUsage.entries()]
    .map(([date, usageByRow]) => {
      const costs: Record<string, number> = {}
      const by_harness: Partial<Record<Harness, number>> = {}
      let dayTotal = 0
      for (const [key, usage] of Object.entries(usageByRow)) {
        const { harness, name: model } = splitHarnessRowKey(key)
        const cost = usageCost(model, usage)
        costs[model] = (costs[model] ?? 0) + cost
        by_harness[harness] = (by_harness[harness] ?? 0) + cost
        dayTotal += cost
      }
      return { date, costs, total: dayTotal, by_harness }
    })
    .sort((a, b) => a.date.localeCompare(b.date))

  // ── Cost by project ────────────────────────────────────────────────────────
  const projectMap = new Map<string, { cost: number; input: number; output: number }>()
  for (const s of filteredSessions) {
    const slug = s.project_path ?? ''
    const existing = projectMap.get(slug) ?? { cost: 0, input: 0, output: 0 }
    let cost = 0
    let input = 0
    let output = 0
    for (const [model, usage] of Object.entries(sessionModelUsage(s))) {
      if (model === '<synthetic>') continue
      cost += usageCost(model, usage)
      input += usage.inputTokens ?? 0
      output += usage.outputTokens ?? 0
    }
    projectMap.set(slug, {
      cost: existing.cost + cost,
      input: existing.input + input,
      output: existing.output + output,
    })
  }

  const by_project: ProjectCost[] = [...projectMap.entries()]
    .map(([slug, data]) => {
      const projectPath = slug
      return {
        slug,
        display_name: projectDisplayName(projectPath),
        estimated_cost: data.cost,
        input_tokens: data.input,
        output_tokens: data.output,
      }
    })
    .sort((a, b) => b.estimated_cost - a.estimated_cost)
    .slice(0, 20)

  const result: CostAnalytics = {
    total_cost: totalCost,
    total_savings: totalSavings,
    sessions: filteredSessions.length,
    sessions_estimated: sessionsEstimated,
    models,
    daily,
    by_project,
    harnesses: [...new Set(filteredSessions.map(s => s.harness))],
  }
  return NextResponse.json(result)
}
