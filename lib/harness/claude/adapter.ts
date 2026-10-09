import fs from 'fs/promises'
import path from 'path'
import type { HarnessAdapter, SessionFileEntry } from '@/lib/harness/types'
import { existingHarnessDir } from '@/lib/harness/dirs'
import { parseSessionReplay } from '@/lib/replay-parser'
import { categorizeTool } from '@/lib/tool-categories'
import {
  finishClaudeSessions,
  getClaudeStorageBytes,
  listProjectEntries,
  listProjectSlugs,
  parseSessionFile,
} from './reader'

/** Transcripts with a `<session>/` folder next to them, from the latest listing */
let withSessionDir = new Set<string>()

/** Claude Code: ~/.claude/projects/<slug>/<session>.jsonl */
export const claudeAdapter: HarnessAdapter = {
  harness: 'claude',
  configDir: () => existingHarnessDir('claude'),

  async listSessionFiles() {
    const entries: SessionFileEntry[] = []
    const sessionDirs = new Set<string>()
    await Promise.all((await listProjectSlugs()).map(async (slug) => {
      const { files, dirs } = await listProjectEntries(slug)
      await Promise.all(files.map(async (filePath) => {
        try {
          const stat = await fs.stat(filePath)
          const sessionId = path.basename(filePath, '.jsonl')
          entries.push({
            harness: 'claude',
            session_id: sessionId,
            path: filePath,
            mtimeMs: stat.mtimeMs,
            slug,
          })
          if (dirs.has(sessionId)) sessionDirs.add(filePath)
        } catch { /* file vanished between readdir and stat */ }
      }))
    }))
    // Swapped whole, so a concurrent listing never sees a half-built set
    withSessionDir = sessionDirs
    return entries
  },

  parseSession: (entry) => parseSessionFile(entry.path, entry.session_id),
  finishSessions: (parsed, now) => finishClaudeSessions(parsed, now, p => withSessionDir.has(p)),
  parseReplay: (entry) => parseSessionReplay(entry.path, entry.session_id),
  categorizeTool,
  storageBytes: getClaudeStorageBytes,
}
