import { isHarness, type Harness } from '@/types/harness'

/** Harnesses selected by `?h=` (comma list). null = no filter; unknown values are dropped, so all-unknown → []. */
export function harnessesFromSearch(search: string): Harness[] | null {
  const raw = new URLSearchParams(search).get('h')
  if (!raw) return null
  return raw.split(',').map(v => v.trim()).filter(isHarness)
}

export function harnessesToSearch(search: string, hs: Harness[] | null): string {
  const p = new URLSearchParams(search)
  if (hs) p.set('h', hs.join(','))
  else p.delete('h')
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** Items whose harness is selected (null filter = everything) */
export function filterByHarness<T extends { harness: Harness }>(items: T[], hs: Harness[] | null): T[] {
  return hs ? items.filter(i => hs.includes(i.harness)) : items
}
