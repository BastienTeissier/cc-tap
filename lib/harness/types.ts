import type { Harness } from '@/types/harness'
import type { ReplayData, SessionMeta } from '@/types/claude'
import type { TurnLedger } from '@/lib/session-ledger'
import type { CostState } from '@/lib/reported-cost'
import type { ToolCategory } from '@/lib/tool-categories'

/** A 5h-window limit hit recorded in the transcript: an assistant line with
 *  `error: "rate_limit"` and `quotaLimits: { status: "rejected",
 *  rateLimitType: "five_hour", resetsAt }` (undocumented, observed locally). */
export interface RateLimitHit {
  /** ms, when the request was rejected */
  ts: number
  /** ms, when the window resets */
  resets_at: number
}

export interface ParsedSession extends SessionMeta {
  cwd?: string
  slug_name?: string
  ai_title?: string
  /** The harness CLI's version (Claude Code's `version` for Claude sessions) */
  cc_version?: string
  git_branch?: string
  /** Branch → transcript lines recorded on it ("HEAD" excluded) */
  git_branches: Record<string, number>
  has_compaction: boolean
  has_thinking: boolean
}

/** What the parser keeps per session: the public session plus the
 *  server-side working data that never reaches an API payload. */
export interface SessionRecord {
  session: ParsedSession
  /** Per-turn record; the session's counters are this ledger summed */
  ledger: TurnLedger
  /** Five-hour limit rejections, for /api/usage-windows */
  rate_limit_hits: RateLimitHit[]
  /** The transcript's last cost-state line, and whether a model call followed it: what
   *  reported_cost is re-derived from once the sub-agents are folded in */
  cost_state?: { state: CostState | null; callsAfter: boolean }
}

/** One session file a harness keeps on disk */
export interface SessionFileEntry {
  harness: Harness
  session_id: string
  /** Absolute path; the session cache key */
  path: string
  mtimeMs: number
  cwd?: string
  /** The project's slug: Claude's project dir name, pathToSlug(cwd) elsewhere */
  slug?: string
}

/** What every harness reader implements; lib/harness/session-store.ts drives it */
export interface HarnessAdapter {
  harness: Harness
  /** The harness's root dir, or null when it is absent on disk */
  configDir(): string | null
  listSessionFiles(): Promise<SessionFileEntry[]>
  /** Parse one file; cached by path + mtime in the session store */
  parseSession(entry: SessionFileEntry): Promise<SessionRecord | null>
  /** Uncached step over every parsed file of a listing, for data that changes without
   *  the file's mtime changing (Claude: sub-agent transcripts, slug → cwd). Default: drop nulls. */
  finishSessions?(parsed: Array<{ entry: SessionFileEntry; record: SessionRecord | null }>, now: number): Promise<SessionRecord[]>
  parseReplay(entry: SessionFileEntry): Promise<ReplayData>
  categorizeTool(name: string): ToolCategory
  /** Bytes under configDir, for Settings and the overview */
  storageBytes(): Promise<number>
}
