import { NextResponse } from 'next/server'
import { findSessionEntry } from '@/lib/harness/session-store'

/**
 * The transcript of a Claude session, for the views only Claude records data for
 * (agents, tool search, workflows); otherwise the 404 such a view answers.
 */
export async function claudeTranscriptOr404(sessionId: string): Promise<string | NextResponse> {
  const entry = await findSessionEntry(sessionId)
  if (!entry) return NextResponse.json({ error: 'Session JSONL not found' }, { status: 404 })
  if (entry.harness !== 'claude') {
    return NextResponse.json({ error: `not available for ${entry.harness} sessions` }, { status: 404 })
  }
  return entry.path
}
