import { mapPool } from '@/lib/jsonl'
import { adapters } from '@/lib/harness/registry'
import type { HarnessAdapter, ParsedSession, SessionFileEntry, SessionRecord } from '@/lib/harness/types'

// Reading every session file on every request is the dominant cost at scale
// (thousands of files × hundreds of KB each). Cache parsed sessions by file path,
// keyed on mtime — completed sessions never change, so warm requests only
// re-parse files that were touched since the last scan.

interface CacheEntry {
  mtimeMs: number
  promise: Promise<SessionRecord | null>
}

const sessionCache = new Map<string, CacheEntry>()

/** Parse (or reuse cached); the cache stores the in-flight promise so concurrent
 *  requests for the same file dedupe to one parse. */
function cachedParse(adapter: HarnessAdapter, entry: SessionFileEntry): Promise<SessionRecord | null> {
  const cached = sessionCache.get(entry.path)
  if (cached && cached.mtimeMs === entry.mtimeMs) return cached.promise
  // Failed parses are evicted so a transient read error doesn't hide the
  // session until the file's mtime happens to change again.
  const promise = adapter.parseSession(entry).then(record => {
    if (!record) sessionCache.delete(entry.path)
    return record
  }, err => {
    sessionCache.delete(entry.path)
    throw err
  })
  sessionCache.set(entry.path, { mtimeMs: entry.mtimeMs, promise })
  return promise
}

async function listOrEmpty(adapter: HarnessAdapter): Promise<SessionFileEntry[]> {
  try {
    return await adapter.listSessionFiles()
  } catch {
    return []
  }
}

/**
 * Every session of every detected harness, newest first, each with its ledger and
 * rate-limit hits, for the routes that slice or inspect them.
 */
export async function getAllSessionRecords(): Promise<SessionRecord[]> {
  const listed = await Promise.all(adapters().map(async a => ({ adapter: a, entries: await listOrEmpty(a) })))

  // Evict entries for sessions that no longer exist
  const seen = new Set(listed.flatMap(l => l.entries.map(e => e.path)))
  for (const key of sessionCache.keys()) {
    if (!seen.has(key)) sessionCache.delete(key)
  }

  const now = Date.now()
  const results: SessionRecord[] = []
  for (const { adapter, entries } of listed) {
    const parsed = await mapPool(entries, 16, async entry => ({ entry, record: await cachedParse(adapter, entry) }))
    const records = adapter.finishSessions
      ? await adapter.finishSessions(parsed, now)
      : parsed.flatMap(p => (p.record ? [p.record] : []))
    results.push(...records)
  }

  results.sort((a, b) => new Date(b.session.start_time).getTime() - new Date(a.session.start_time).getTime())
  return results
}

/** Every session of every detected harness, newest first */
export async function getAllParsedSessions(): Promise<ParsedSession[]> {
  return (await getAllSessionRecords()).map(r => r.session)
}

export async function getSessions(): Promise<ParsedSession[]> {
  return getAllParsedSessions()
}

/** The file of a session, from whichever detected harness holds it */
export async function findSessionEntry(sessionId: string): Promise<SessionFileEntry | null> {
  for (const adapter of adapters()) {
    const entry = (await listOrEmpty(adapter)).find(e => e.session_id === sessionId)
    if (entry) return entry
  }
  return null
}
