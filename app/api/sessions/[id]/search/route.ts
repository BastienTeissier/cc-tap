import { NextResponse } from 'next/server'
import { claudeTranscriptOr404 } from '@/app/api/sessions/[id]/claude-only'
import { searchToolCalls, type SearchScope } from '@/lib/tool-search'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const url = new URL(req.url)
  const q = url.searchParams.get('q') ?? ''
  const scope: SearchScope = url.searchParams.get('scope') === 'all' ? 'all' : 'input'

  const jsonlPath = await claudeTranscriptOr404(id)
  if (typeof jsonlPath !== 'string') return jsonlPath

  const result = await searchToolCalls(jsonlPath, id, q, scope)
  return NextResponse.json(result)
}
