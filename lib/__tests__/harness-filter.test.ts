import { describe, it, expect } from 'vitest'
import { harnessesFromSearch, harnessesToSearch, filterByHarness, withHarnessParam, nextHarnesses } from '@/lib/harness-filter'

describe('harnessesFromSearch', () => {
  it('reads no filter when h is absent or empty', () => {
    expect(harnessesFromSearch('')).toBeNull()
    expect(harnessesFromSearch('?h=')).toBeNull()
  })

  it('drops unknown harnesses, leaving none when all are unknown', () => {
    expect(harnessesFromSearch('?h=claude,foo')).toEqual(['claude'])
    expect(harnessesFromSearch('?h=foo')).toEqual([])
  })
})

describe('harnessesToSearch', () => {
  it('sets and removes h while keeping the time window', () => {
    const withH = harnessesToSearch('?from=1&to=2', ['claude', 'codex'])
    expect(new URLSearchParams(withH).get('h')).toBe('claude,codex')
    expect(new URLSearchParams(withH).get('from')).toBe('1')
    expect(harnessesFromSearch(withH)).toEqual(['claude', 'codex'])
    expect(harnessesToSearch(withH, null)).toBe('?from=1&to=2')
    expect(harnessesToSearch('?h=codex', null)).toBe('')
  })
})

describe('filterByHarness', () => {
  const items = [{ harness: 'claude' as const }, { harness: 'codex' as const }]

  it('keeps everything without a filter', () => {
    expect(filterByHarness(items, null)).toEqual(items)
  })

  it('keeps nothing with an empty filter', () => {
    expect(filterByHarness(items, [])).toEqual([])
  })

  it('keeps only the selected harnesses', () => {
    expect(filterByHarness(items, ['codex'])).toEqual([{ harness: 'codex' }])
  })
})

describe('withHarnessParam', () => {
  it('leaves the URL alone when the page has no filter', () => {
    expect(withHarnessParam('/api/costs', null)).toBe('/api/costs')
    expect(withHarnessParam('/api/costs', '')).toBe('/api/costs')
  })

  it('appends h with ? or & depending on the URL', () => {
    expect(withHarnessParam('/api/costs', 'claude,codex')).toBe('/api/costs?h=claude%2Ccodex')
    expect(withHarnessParam('/api/costs?range=30d', 'codex')).toBe('/api/costs?range=30d&h=codex')
  })

  it('keeps an all-unknown filter empty on the API side, not "all"', () => {
    const url = new URL(withHarnessParam('/api/costs', 'foo'), 'http://localhost')
    expect(harnessesFromSearch(url.search)).toEqual([])
  })
})

describe('nextHarnesses', () => {
  const detected = ['claude', 'codex', 'copilot'] as const
  const next = (selected: Parameters<typeof nextHarnesses>[0], h: Parameters<typeof nextHarnesses>[2]) =>
    nextHarnesses(selected, [...detected], h)

  it('keeps only the clicked harness when all are selected', () => {
    expect(next(null, 'codex')).toEqual(['codex'])
  })

  it('toggles a harness once a filter is set, in detected order', () => {
    expect(next(['codex'], 'claude')).toEqual(['claude', 'codex'])
    expect(next(['claude', 'codex'], 'codex')).toEqual(['claude'])
  })

  it('clears the filter when nothing or everything ends up selected', () => {
    expect(next(['codex'], 'codex')).toBeNull()
    expect(next(['claude', 'codex'], 'copilot')).toBeNull()
  })
})
