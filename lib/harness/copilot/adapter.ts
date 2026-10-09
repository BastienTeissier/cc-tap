import fs from 'fs/promises'
import path from 'path'
import type { HarnessAdapter, SessionFileEntry } from '@/lib/harness/types'
import { dirSize, existingHarnessDir, harnessDir } from '@/lib/harness/dirs'
import { categorizeTool } from '@/lib/tool-categories'
import { parseCopilotSession } from './reader'
import { parseCopilotReplay } from './replay'
import { lastUsageMs } from './usage-db'

/** Copilot CLI: ~/.copilot/session-state/<id>/events.jsonl, tokens in ~/.copilot/session-store.db */
export const copilotAdapter: HarnessAdapter = {
  harness: 'copilot',
  configDir: () => existingHarnessDir('copilot'),

  async listSessionFiles() {
    const root = path.join(harnessDir('copilot'), 'session-state')
    let dirs
    try {
      dirs = await fs.readdir(root, { withFileTypes: true })
    } catch {
      return []
    }
    // A session's tokens land in the DB: its latest row must invalidate the cached parse too
    const lastUsage = lastUsageMs()
    const entries = await Promise.all(dirs.filter(d => d.isDirectory()).map(async (d): Promise<SessionFileEntry | null> => {
      const filePath = path.join(root, d.name, 'events.jsonl')
      try {
        const stat = await fs.stat(filePath)
        return { harness: 'copilot', session_id: d.name, path: filePath, mtimeMs: Math.max(stat.mtimeMs, lastUsage.get(d.name) ?? 0) }
      } catch {
        return null // no events yet, or vanished
      }
    }))
    return entries.filter((e): e is SessionFileEntry => e !== null)
  },

  parseSession: (entry) => parseCopilotSession(entry.path, entry.session_id),
  parseReplay: (entry) => parseCopilotReplay(entry.path, entry.session_id),
  categorizeTool: (name) => categorizeTool(name, 'copilot'),
  storageBytes: () => dirSize(harnessDir('copilot')),
}
