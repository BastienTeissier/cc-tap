import fs from 'fs/promises'
import path from 'path'
import type { HarnessAdapter, SessionFileEntry } from '@/lib/harness/types'
import { dirSize, existingHarnessDir, harnessDir } from '@/lib/harness/dirs'
import { categorizeTool } from '@/lib/tool-categories'
import { parseCodexSession } from './reader'
import { parseCodexReplay } from './replay'

// rollout-2026-10-01T10-00-00-<uuid>.jsonl
const ROLLOUT = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/** rollout-*.jsonl under dir, at most `depth` levels down */
async function findRollouts(dir: string, depth: number): Promise<string[]> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const nested = await Promise.all(entries.map(async (e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return depth > 0 ? findRollouts(full, depth - 1) : []
    return ROLLOUT.test(e.name) ? [full] : []
  }))
  return nested.flat()
}

/** Codex CLI: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl and ~/.codex/archived_sessions/rollout-*.jsonl */
export const codexAdapter: HarnessAdapter = {
  harness: 'codex',
  configDir: () => existingHarnessDir('codex'),

  async listSessionFiles() {
    const root = harnessDir('codex')
    const files = [
      ...await findRollouts(path.join(root, 'sessions'), 3),
      ...await findRollouts(path.join(root, 'archived_sessions'), 0),
    ]
    const entries = await Promise.all(files.map(async (filePath): Promise<SessionFileEntry | null> => {
      try {
        const stat = await fs.stat(filePath)
        return {
          harness: 'codex',
          session_id: ROLLOUT.exec(path.basename(filePath))![1],
          path: filePath,
          mtimeMs: stat.mtimeMs,
        }
      } catch {
        return null // file vanished between readdir and stat
      }
    }))
    return entries.filter((e): e is SessionFileEntry => e !== null)
  },

  parseSession: (entry) => parseCodexSession(entry.path, entry.session_id),
  parseReplay: (entry) => parseCodexReplay(entry.path, entry.session_id),
  categorizeTool: (name) => categorizeTool(name, 'codex'),
  storageBytes: () => dirSize(harnessDir('codex')),
}
