import { describe, it, expect } from 'vitest'
import { harnessesFromSearch, harnessesToSearch, filterByHarness } from '@/lib/harness-filter'

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
