import { NextResponse } from 'next/server'
import { getAllParsedSessions } from '@/lib/harness/session-store'
import { harnessesFromSearch, filterByHarness } from '@/lib/harness-filter'
import type { Harness } from '@/types/harness'
import { redactSessions } from '@/lib/redact'
import type { TeamExportPayload, RedactionLevel } from '@/types/claude'

export const dynamic = 'force-dynamic'

interface TeamExportRequest {
  memberName?: string
  memberEmail?: string
  machine?: string
  redaction?: RedactionLevel
  dateRange?: { from?: string; to?: string }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as TeamExportRequest

  const name = (body.memberName ?? '').trim()
  if (!name) {
    return NextResponse.json({ error: 'memberName is required' }, { status: 400 })
  }
  const redaction: RedactionLevel = body.redaction === 'titles' ? 'titles' : 'metrics'

  const sessions = filterByHarness(await getAllParsedSessions(), harnessesFromSearch(new URL(req.url).search))

  // Date strings come from the UI as yyyy-MM-dd in the user's local timezone;
  // build local-day boundaries (no trailing Z) so midnight-adjacent sessions
  // land in the day the user actually saw them.
  const fromMs = body.dateRange?.from ? new Date(body.dateRange.from + 'T00:00:00').getTime() : null
  const toMs = body.dateRange?.to ? new Date(body.dateRange.to + 'T23:59:59.999').getTime() : null
  if (fromMs !== null && Number.isNaN(fromMs)) {
    return NextResponse.json({ error: 'invalid dateRange.from' }, { status: 400 })
  }
  if (toMs !== null && Number.isNaN(toMs)) {
    return NextResponse.json({ error: 'invalid dateRange.to' }, { status: 400 })
  }
  if (fromMs !== null && toMs !== null && fromMs > toMs) {
    return NextResponse.json({ error: 'dateRange.from is after dateRange.to' }, { status: 400 })
  }
  const filtered = sessions.filter(s => {
    if (!s.start_time) return true
    const t = new Date(s.start_time).getTime()
    if (fromMs !== null && t < fromMs) return false
    if (toMs !== null && t > toMs) return false
    return true
  })

  const ccVersions = Array.from(
    new Set(filtered.map(s => s.cc_version).filter((v): v is string => Boolean(v)))
  ).sort()

  const versionsByHarness: Partial<Record<Harness, string[]>> = {}
  for (const s of filtered) {
    if (!s.cc_version) continue
    const versions = (versionsByHarness[s.harness] ??= [])
    if (!versions.includes(s.cc_version)) versions.push(s.cc_version)
  }
  for (const versions of Object.values(versionsByHarness)) versions.sort()

  const payload: TeamExportPayload = {
    kind: 'cclens-team-export',
    // 1.1.0: sessions carry `harness`; harnesses and versions_by_harness added
    version: '1.1.0',
    exportedAt: new Date().toISOString(),
    member: {
      name,
      ...(body.memberEmail?.trim() ? { email: body.memberEmail.trim() } : {}),
      ...(body.machine?.trim() ? { machine: body.machine.trim() } : {}),
    },
    redaction,
    cc_versions: ccVersions,
    harnesses: [...new Set(filtered.map(s => s.harness))],
    versions_by_harness: versionsByHarness,
    sessions: redactSessions(filtered, redaction),
  }

  return NextResponse.json(payload)
}
