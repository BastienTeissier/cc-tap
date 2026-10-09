import { NextResponse } from 'next/server'
import { getAllSessionRecords } from '@/lib/harness/session-store'
import { resolveProjectPath } from '@/lib/harness/claude/reader'
import { harnessesFromSearch, matchesHarness } from '@/lib/harness-filter'
import { sessionCost } from '@/lib/pricing'
import { pathToSlug, projectDisplayName } from '@/lib/decode'
import type { SessionWithFacet } from '@/types/claude'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params
  const hf = harnessesFromSearch(new URL(req.url).search)
  const projectPath = await resolveProjectPath(slug)
  const records = await getAllSessionRecords()
  // Any harness's session whose cwd encodes to this slug; Claude's recovered cwd covers
  // slugs whose path had characters the encoding loses
  let matched = records.filter(({ session: s }) =>
    s.project_path === projectPath || (!!s.project_path && pathToSlug(s.project_path) === slug)
  )

  if (matched.length === 0) {
    const lastSegment = projectPath.split('/').filter(Boolean).pop() ?? ''
    matched = records.filter(r =>
      r.session.project_path?.endsWith('/' + lastSegment)
    )
  }
  // Filtered only once the project is resolved: a project with no session of the selected
  // harness is empty, not whichever other project shares its last segment
  matched = matched.filter(r => matchesHarness(r.session, hf))
  const sessions = matched.map(r => r.session)

  const branchTurns = new Map<string, number>()
  for (const r of matched) {
    for (const [branch, lines] of Object.entries(r.git_branches)) {
      branchTurns.set(branch, (branchTurns.get(branch) ?? 0) + lines)
    }
  }

  const enrichedSessions: SessionWithFacet[] = sessions.map(s => ({
    ...s,
    estimated_cost: sessionCost(s),
    slug: s.slug_name,
    version: s.cc_version,
    has_compaction: s.has_compaction,
  }))

  // Aggregate tools
  const toolCounts: Record<string, number> = {}
  for (const s of sessions) {
    for (const [t, c] of Object.entries(s.tool_counts ?? {})) {
      toolCounts[t] = (toolCounts[t] ?? 0) + c
    }
  }

  // Cost per session (for chart)
  const costBySession = enrichedSessions.map(s => ({
    session_id: s.session_id,
    start_time: s.start_time,
    cost: s.estimated_cost,
    messages: (s.user_message_count ?? 0) + (s.assistant_message_count ?? 0),
  }))

  const branches = [...branchTurns.entries()]
    .map(([branch, turns]) => ({ branch, turns }))
    .sort((a, b) => b.turns - a.turns)

  return NextResponse.json({
    project_path: projectPath,
    display_name: projectDisplayName(projectPath),
    sessions: enrichedSessions.sort((a, b) => b.start_time.localeCompare(a.start_time)),
    tool_counts: toolCounts,
    cost_by_session: costBySession,
    branches,
  })
}
