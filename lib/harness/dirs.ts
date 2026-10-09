import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import type { Harness } from '@/types/harness'

const DIRS: Record<Harness, { env: string; fallback: string }> = {
  claude: { env: 'CLAUDE_CONFIG_DIR', fallback: '.claude' },
  codex: { env: 'CODEX_HOME', fallback: '.codex' },
  copilot: { env: 'COPILOT_HOME', fallback: '.copilot' },
}

/** The harness's root dir: its env override, else the default under the home dir. Read on every call. */
export function harnessDir(h: Harness): string {
  return process.env[DIRS[h].env] ?? path.join(os.homedir(), DIRS[h].fallback)
}

/** harnessDir when it exists on disk, else null */
export function existingHarnessDir(h: Harness): string | null {
  const dir = harnessDir(h)
  return fs.existsSync(dir) ? dir : null
}

/** Bytes under a dir, recursively; unreadable entries count as 0 */
export async function dirSize(dirPath: string): Promise<number> {
  let total = 0
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true })
    await Promise.all(
      entries.map(async e => {
        const full = path.join(dirPath, e.name)
        if (e.isDirectory()) {
          total += await dirSize(full)
        } else {
          try {
            const stat = await fsp.stat(full)
            total += stat.size
          } catch { /* skip */ }
        }
      })
    )
  } catch { /* skip inaccessible dirs */ }
  return total
}
