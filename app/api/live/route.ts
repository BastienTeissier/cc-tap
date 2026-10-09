import { NextResponse } from 'next/server'
import { readLiveSessions } from '@/lib/harness/claude/reader'

export const dynamic = 'force-dynamic'

export async function GET() {
  const live = await readLiveSessions()
  return NextResponse.json({ live, total: live.length })
}
