import type { Harness } from '@/types/harness'
import type { HarnessAdapter } from '@/lib/harness/types'
import { claudeAdapter } from '@/lib/harness/claude/adapter'

const ALL: HarnessAdapter[] = [claudeAdapter]

/** Adapters whose harness dir exists on disk */
export function adapters(): HarnessAdapter[] {
  return ALL.filter(a => a.configDir() !== null)
}

export function adapterFor(h: Harness): HarnessAdapter | undefined {
  return ALL.find(a => a.harness === h)
}

export function detectedHarnesses(): Harness[] {
  return adapters().map(a => a.harness)
}
