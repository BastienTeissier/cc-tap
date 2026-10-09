// Compatibility shim while the routes move to lib/harness/*: the Claude-only
// readers come from the Claude adapter, the session listing from the
// harness-agnostic session store. Removed once nothing imports it.
import { findSessionEntry } from '@/lib/harness/session-store'

export * from '@/lib/harness/claude/reader'
export { getAllSessionRecords, getAllParsedSessions, getSessions } from '@/lib/harness/session-store'
export { getAllParsedSessions as readSessionsFromProjectJSONL } from '@/lib/harness/session-store'

/** The transcript path of a Claude session */
export async function findSessionJSONL(sessionId: string): Promise<string | null> {
  const entry = await findSessionEntry(sessionId)
  return entry?.harness === 'claude' ? entry.path : null
}
