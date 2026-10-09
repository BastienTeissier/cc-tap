import { NextResponse } from 'next/server'
import { getAllSessionRecords } from '@/lib/harness/session-store'
import { adapterFor } from '@/lib/harness/registry'
import { harnessesFromSearch, matchesHarness } from '@/lib/harness-filter'
import { categorizeTool, isMcpTool, parseMcpTool } from '@/lib/tool-categories'
import { harnessRowKey as rowKey, splitHarnessRowKey } from '@/lib/harness/row-key'
import type { ToolsAnalytics, ToolSummary, McpServerSummary, VersionRecord } from '@/types/claude'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const hf = harnessesFromSearch(new URL(req.url).search)
  const records = (await getAllSessionRecords()).filter(r => matchesHarness(r.session, hf))
  const sessions = records.map(r => r.session)
  const totalSessions = sessions.length

  // ── Aggregate tool counts across all sessions, keyed by rowKey(harness, name) ──
  const toolTotals = new Map<string, number>()
  const toolSessionCount = new Map<string, Set<string>>()
  const mcpServerCalls = new Map<string, Map<string, number>>()
  const mcpServerSessions = new Map<string, Set<string>>()
  const errorCategories: Record<string, number> = {}
  let totalErrors = 0

  for (const s of sessions) {
    const sid = s.session_id
    for (const [tool, count] of Object.entries(s.tool_counts ?? {})) {
      const key = rowKey(s.harness, tool)
      toolTotals.set(key, (toolTotals.get(key) ?? 0) + count)
      if (!toolSessionCount.has(key)) toolSessionCount.set(key, new Set())
      toolSessionCount.get(key)!.add(sid)

      if (isMcpTool(tool)) {
        const parsed = parseMcpTool(tool)
        if (parsed) {
          if (!mcpServerCalls.has(parsed.server)) mcpServerCalls.set(parsed.server, new Map())
          if (!mcpServerSessions.has(parsed.server)) mcpServerSessions.set(parsed.server, new Set())
          const srv = mcpServerCalls.get(parsed.server)!
          srv.set(parsed.tool, (srv.get(parsed.tool) ?? 0) + count)
          mcpServerSessions.get(parsed.server)!.add(sid)
        }
      }
    }

    // Error categories
    for (const [cat, count] of Object.entries(s.tool_error_categories ?? {})) {
      errorCategories[cat] = (errorCategories[cat] ?? 0) + count
      totalErrors += count
    }
  }

  // ── Build ToolSummary list ─────────────────────────────────────────────────
  const tools: ToolSummary[] = [...toolTotals.entries()]
    .map(([key, total_calls]) => {
      const { harness, name } = splitHarnessRowKey(key)
      return {
        harness,
        name,
        category: (adapterFor(harness)?.categorizeTool ?? categorizeTool)(name),
        total_calls,
        session_count: toolSessionCount.get(key)?.size ?? 0,
        error_count: 0,
      }
    })
    .sort((a, b) => b.total_calls - a.total_calls)


  const totalToolCalls = tools.reduce((s, t) => s + t.total_calls, 0)

  // ── MCP server summaries ───────────────────────────────────────────────────
  const mcp_servers: McpServerSummary[] = [...mcpServerCalls.entries()]
    .map(([server_name, toolMap]) => {
      const toolArr = [...toolMap.entries()]
        .map(([name, calls]) => ({ name, calls }))
        .sort((a, b) => b.calls - a.calls)
      const total_calls = toolArr.reduce((s, t) => s + t.calls, 0)
      return {
        server_name,
        tools: toolArr,
        total_calls,
        session_count: mcpServerSessions.get(server_name)?.size ?? 0,
      }
    })
    .sort((a, b) => b.total_calls - a.total_calls)

  // ── Feature adoption ──────────────────────────────────────────────────────
  const featureSessions = {
    task_agents: sessions.filter(s => s.uses_task_agent || (s.tool_counts?.Task ?? 0) > 0).length,
    mcp: sessions.filter(s => s.uses_mcp || Object.keys(s.tool_counts ?? {}).some(isMcpTool)).length,
    web_search: sessions.filter(s => s.uses_web_search || (s.tool_counts?.WebSearch ?? 0) > 0).length,
    web_fetch: sessions.filter(s => s.uses_web_fetch || (s.tool_counts?.WebFetch ?? 0) > 0).length,
    plan_mode: sessions.filter(s => (s.tool_counts?.EnterPlanMode ?? 0) > 0).length,
    git_commits: sessions.filter(s => (s.git_commits ?? 0) > 0).length,
  }

  const feature_adoption: Record<string, { sessions: number; pct: number }> = {}
  for (const [key, count] of Object.entries(featureSessions)) {
    feature_adoption[key] = { sessions: count, pct: totalSessions > 0 ? count / totalSessions : 0 }
  }

  // ── Version + branch info, versions keyed by rowKey(harness, version) ──────
  const versionData = new Map<string, { sessions: Set<string>; dates: string[] }>()
  const branchTurns = new Map<string, number>()

  for (const { session: s, git_branches } of records) {
    if (s.cc_version) {
      const key = rowKey(s.harness, s.cc_version)
      if (!versionData.has(key)) {
        versionData.set(key, { sessions: new Set(), dates: [] })
      }
      const vd = versionData.get(key)!
      vd.sessions.add(s.session_id)
      vd.dates.push(s.start_time)
    }
    for (const [branch, lines] of Object.entries(git_branches)) {
      branchTurns.set(branch, (branchTurns.get(branch) ?? 0) + lines)
    }
  }

  const versions: VersionRecord[] = [...versionData.entries()]
    .map(([key, data]) => {
      const { harness, name: version } = splitHarnessRowKey(key)
      const sortedDates = data.dates.sort()
      return {
        harness,
        version,
        session_count: data.sessions.size,
        first_seen: sortedDates[0] ?? '',
        last_seen: sortedDates[sortedDates.length - 1] ?? '',
      }
    })
    .sort((a, b) => b.last_seen.localeCompare(a.last_seen))

  const branches = [...branchTurns.entries()]
    .map(([branch, turns]) => ({ branch, turns }))
    .sort((a, b) => b.turns - a.turns)
    .slice(0, 15)

  const result: ToolsAnalytics = {
    tools,
    mcp_servers,
    feature_adoption,
    versions,
    branches,
    error_categories: errorCategories,
    total_tool_calls: totalToolCalls,
    total_errors: totalErrors,
  }

  return NextResponse.json(result)
}
