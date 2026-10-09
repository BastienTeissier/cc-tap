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

/** Claude Code: ~/.claude/projects/<slug>/<session>.jsonl */
export const claudeAdapter: HarnessAdapter = {
  harness: 'claude',
  configDir: () => existingHarnessDir('claude'),

  async listSessionFiles() {
    const entries: SessionFileEntry[] = []
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
            hasSessionDir: dirs.has(sessionId),
          })
        } catch { /* file vanished between readdir and stat */ }
      }))
    }))
    return entries
  },

  parseSession: (entry) => parseSessionFile(entry.path, entry.session_id),
  finishSessions: finishClaudeSessions,
  parseReplay: (entry) => parseSessionReplay(entry.path, entry.session_id),
  categorizeTool,
  storageBytes: getClaudeStorageBytes,
}
