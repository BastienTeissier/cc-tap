import { NextResponse } from 'next/server'
import { claudeTranscriptOr404 } from '@/lib/harness/claude-only'
import { parseAgentTimeline } from '@/lib/agent-timeline'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const jsonlPath = await claudeTranscriptOr404(id)
  if (typeof jsonlPath !== 'string') return jsonlPath

  const timeline = await parseAgentTimeline(jsonlPath, id)
  return NextResponse.json(timeline)
}
