import { isHarness, type Harness } from '@/types/harness'

/** Harnesses selected by `?h=` (comma list). null = no filter; unknown values are dropped, so all-unknown → []. */
export function harnessesFromSearch(search: string): Harness[] | null {
  const raw = new URLSearchParams(search).get('h')
  if (!raw) return null
  return raw.split(',').map(v => v.trim()).filter(isHarness)
}

/**
 * An API URL carrying the page's raw `?h=` value, unchanged when there is none.
 * Forwarded as-is so the API parses it like the page did: all-unknown stays [] (not "all").
 */
export function withHarnessParam(base: string, raw: string | null): string {
  if (!raw) return base
  return `${base}${base.includes('?') ? '&' : '?'}h=${encodeURIComponent(raw)}`
}

export function harnessesToSearch(search: string, hs: Harness[] | null): string {
  const p = new URLSearchParams(search)
  if (hs) p.set('h', hs.join(','))
  else p.delete('h')
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** True when the item's harness is selected (null filter = everything) */
export function matchesHarness(item: { harness: Harness }, hs: Harness[] | null): boolean {
  return !hs || hs.includes(item.harness)
}

/** Items whose harness is selected (null filter = everything) */
export function filterByHarness<T extends { harness: Harness }>(items: T[], hs: Harness[] | null): T[] {
  return hs ? items.filter(i => matchesHarness(i, hs)) : items
}

/** The selection after clicking `h`: from "all", the click picks `h` alone; otherwise it toggles `h`. Empty or full means all (null). */
export function nextHarnesses(selected: Harness[] | null, detected: Harness[], h: Harness): Harness[] | null {
  if (selected === null) return [h]
  const next = selected.includes(h) ? selected.filter(x => x !== h) : [...selected, h]
  const all = next.length === 0 || detected.every(d => next.includes(d))
  return all ? null : detected.filter(d => next.includes(d))
}
