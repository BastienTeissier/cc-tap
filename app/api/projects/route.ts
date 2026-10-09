import { NextResponse } from 'next/server'
import { getAllSessionRecords } from '@/lib/harness/session-store'
import { listProjectSlugs, resolveProjectPath } from '@/lib/harness/claude/reader'
import { harnessesFromSearch, matchesHarness } from '@/lib/harness-filter'
import { sessionCost } from '@/lib/pricing'
import { pathToSlug, projectDisplayName } from '@/lib/decode'
import type { ProjectSummary } from '@/types/claude'
import type { SessionRecord } from '@/lib/harness/types'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const hf = harnessesFromSearch(new URL(req.url).search)
  const [all, slugDirs] = await Promise.all([getAllSessionRecords(), listProjectSlugs()])
  const records = all.filter(r => matchesHarness(r.session, hf))

  // Claude's project dirs name the slug of their recovered cwd; every other project
  // (any harness) gets pathToSlug(cwd), so one repo is one card across harnesses
  const pathToSlugMap = new Map<string, string>()
  await Promise.all(
    slugDirs.map(async (slug) => {
      const resolved = await resolveProjectPath(slug)
      pathToSlugMap.set(resolved, slug)
    })
  )

  // Group sessions by project_path
  const byPath = new Map<string, SessionRecord['session'][]>()
  const branchesByPath = new Map<string, Set<string>>()
  for (const { session: s, git_branches } of records) {
    const pp = s.project_path ?? ''
    if (!byPath.has(pp)) byPath.set(pp, [])
    byPath.get(pp)!.push(s)
    if (!branchesByPath.has(pp)) branchesByPath.set(pp, new Set())
    for (const branch of Object.keys(git_branches)) branchesByPath.get(pp)!.add(branch)
  }

  const projects: ProjectSummary[] = []

  for (const [projectPath, sessionList] of byPath.entries()) {
    const slug = pathToSlugMap.get(projectPath) ?? pathToSlug(projectPath)

    const totalMessages = sessionList.reduce(
      (s, m) => s + (m.user_message_count ?? 0) + (m.assistant_message_count ?? 0), 0
    )
    const totalDuration = sessionList.reduce((s, m) => s + (m.duration_minutes ?? 0), 0)
    const totalLinesAdded = sessionList.reduce((s, m) => s + (m.lines_added ?? 0), 0)
    const totalLinesRemoved = sessionList.reduce((s, m) => s + (m.lines_removed ?? 0), 0)
    const totalFilesModified = sessionList.reduce((s, m) => s + (m.files_modified ?? 0), 0)
    const gitCommits = sessionList.reduce((s, m) => s + (m.git_commits ?? 0), 0)
    const gitPushes = sessionList.reduce((s, m) => s + (m.git_pushes ?? 0), 0)
    const inputTokens = sessionList.reduce((s, m) => s + (m.input_tokens ?? 0), 0)
    const outputTokens = sessionList.reduce((s, m) => s + (m.output_tokens ?? 0), 0)

    // Same per-model pricing as /api/sessions and /api/costs, so a project's
    // total is the sum of what its sessions show
    const estimatedCost = sessionList.reduce((sum, s) => sum + sessionCost(s), 0)

    const languages: Record<string, number> = {}
    for (const s of sessionList) {
      for (const [lang, count] of Object.entries(s.languages ?? {})) {
        languages[lang] = (languages[lang] ?? 0) + count
      }
    }

    const toolCounts: Record<string, number> = {}
    for (const s of sessionList) {
      for (const [tool, count] of Object.entries(s.tool_counts ?? {})) {
        toolCounts[tool] = (toolCounts[tool] ?? 0) + count
      }
    }

    const byHarness: ProjectSummary['by_harness'] = {}
    for (const s of sessionList) {
      const h = byHarness[s.harness] ?? { sessions: 0, estimated_cost: 0 }
      h.sessions += 1
      h.estimated_cost += sessionCost(s)
      byHarness[s.harness] = h
    }

    const sortedDates = sessionList.map(s => s.start_time).sort()

    projects.push({
      slug,
      project_path: projectPath,
      display_name: projectDisplayName(projectPath),
      session_count: sessionList.length,
      total_messages: totalMessages,
      total_duration_minutes: totalDuration,
      total_lines_added: totalLinesAdded,
      total_lines_removed: totalLinesRemoved,
      total_files_modified: totalFilesModified,
      git_commits: gitCommits,
      git_pushes: gitPushes,
      estimated_cost: estimatedCost,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      languages,
      tool_counts: toolCounts,
      last_active: sortedDates[sortedDates.length - 1] ?? '',
      first_active: sortedDates[0] ?? '',
      uses_mcp: sessionList.some(s => s.uses_mcp),
      uses_task_agent: sessionList.some(s => s.uses_task_agent),
      branches: [...(branchesByPath.get(projectPath) ?? [])].slice(0, 10),
      by_harness: byHarness,
    })
  }

  return NextResponse.json({
    projects: projects.sort((a, b) => b.last_active.localeCompare(a.last_active)),
  })
}
