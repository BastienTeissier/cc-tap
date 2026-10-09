import { isHarness, type Harness } from '@/types/harness'

/** Map key of a per-(harness, name) aggregate row; the NUL separator appears in neither part */
export const harnessRowKey = (harness: Harness, name: string) => `${harness}\u0000${name}`

export function splitHarnessRowKey(key: string): { harness: Harness; name: string } {
  const [harness, name] = key.split('\u0000')
  return { harness: isHarness(harness) ? harness : 'claude', name }
}
