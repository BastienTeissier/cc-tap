import { describe, it, expect, afterAll } from 'vitest'

// Point user overrides at a path that doesn't exist so the developer's real
// ~/.cc-lens/pricing.json can't leak into assertions
const previousConfigDir = process.env.CC_LENS_CONFIG_DIR
process.env.CC_LENS_CONFIG_DIR = '/nonexistent-cc-lens-test'

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.CC_LENS_CONFIG_DIR
  else process.env.CC_LENS_CONFIG_DIR = previousConfigDir
})

import type { TurnUsage } from '@/types/claude'
import {
  getPricing,
  hasKnownPricing,
  pricedAs,
  unpricedModels,
  FALLBACK_MODEL,
  estimateCostFromUsage,
  estimateTotalCostFromModel,
  cacheEfficiency,
} from '@/lib/pricing'

const MTOK = 1_000_000

describe('getPricing', () => {
  it('returns exact rates for current models', () => {
    expect(getPricing('claude-opus-4-8').input * MTOK).toBeCloseTo(5)
    expect(getPricing('claude-fable-5').input * MTOK).toBeCloseTo(10)
    expect(getPricing('claude-sonnet-4-6').output * MTOK).toBeCloseTo(15)
    expect(getPricing('claude-haiku-4-5').input * MTOK).toBeCloseTo(1)
  })

  it('prices the Claude 5 generation directly instead of via prefix or fallback', () => {
    // Fable 5.1 has a reduced cache-read rate; must not inherit Fable 5's $1.00
    expect(getPricing('claude-fable-5-1').cacheRead * MTOK).toBeCloseTo(0.25)
    expect(getPricing('claude-fable-5-1').input * MTOK).toBeCloseTo(10)
    expect(getPricing('claude-fable-5').cacheRead * MTOK).toBeCloseTo(1)
    expect(getPricing('claude-opus-5').input * MTOK).toBeCloseTo(5)
    expect(getPricing('claude-sonnet-5').input * MTOK).toBeCloseTo(2)
    expect(getPricing('claude-sonnet-5').output * MTOK).toBeCloseTo(10)
    expect(hasKnownPricing('claude-sonnet-5')).toBe(true)
  })

  it('prices the 5.5 releases on their own entries, not through the 5 prefix', () => {
    // Opus 5.5 is cheaper than Opus 5; the claude-opus-5 prefix would charge $5 / $25
    expect(getPricing('claude-opus-5-5').input * MTOK).toBeCloseTo(4)
    expect(getPricing('claude-opus-5-5').output * MTOK).toBeCloseTo(20)
    expect(getPricing('claude-opus-5-5').cacheRead * MTOK).toBeCloseTo(0.2)
    expect(getPricing('claude-opus-5-5-20260901').input * MTOK).toBeCloseTo(4)
    expect(getPricing('claude-sonnet-5-5').input * MTOK).toBeCloseTo(2)
    expect(getPricing('claude-sonnet-5-5').output * MTOK).toBeCloseTo(10)
  })

  it('resolves date-suffixed IDs to the most specific prefix', () => {
    // claude-opus-4-5-20251101 must hit the 4.5 entry ($5), not legacy claude-opus-4
    expect(getPricing('claude-opus-4-5-20251101').input * MTOK).toBeCloseTo(5)
    expect(getPricing('claude-haiku-4-5-20251001').input * MTOK).toBeCloseTo(1)
    // claude-fable-5-1-* must hit the 5.1 entry ($0.25 cache read), not claude-fable-5 ($1.00)
    expect(getPricing('claude-fable-5-1-20260901').cacheRead * MTOK).toBeCloseTo(0.25)
    expect(getPricing('claude-fable-5-20260601').cacheRead * MTOK).toBeCloseTo(1)
    expect(getPricing('claude-opus-5-20260801').input * MTOK).toBeCloseTo(5)
    expect(getPricing('claude-sonnet-5-20260801').input * MTOK).toBeCloseTo(2)
  })

  it('resolves legacy Opus 4 date-suffixed IDs to legacy rates', () => {
    // claude-opus-4-20250514 is legacy $15/$75 — must NOT match claude-opus-4-7 etc.
    expect(getPricing('claude-opus-4-20250514').input * MTOK).toBeCloseTo(15)
    expect(getPricing('claude-opus-4-20250514').output * MTOK).toBeCloseTo(75)
  })

  it('falls back to current Opus rates for unknown models', () => {
    expect(getPricing('some-future-model').input * MTOK).toBeCloseTo(5)
  })
})

describe('hasKnownPricing', () => {
  it('is true for known and prefixed models, false for unknown', () => {
    expect(hasKnownPricing('claude-opus-4-8')).toBe(true)
    expect(hasKnownPricing('claude-opus-4-5-20251101')).toBe(true)
    expect(hasKnownPricing('some-future-model')).toBe(false)
  })

  it('is false for a release that only borrows a prefix entry', () => {
    // claude-opus-5-9 matches claude-opus-5 by prefix, but that entry prices Opus 5
    expect(hasKnownPricing('claude-opus-5-9')).toBe(false)
    expect(hasKnownPricing('claude-sonnet-6')).toBe(false)
    expect(hasKnownPricing('claude-opus-4-20250514')).toBe(true)
    expect(hasKnownPricing('claude-opus-5-5-20260901')).toBe(true)
  })
})

describe('unpricedModels', () => {
  it('lists only the models charged at another entry, skipping <synthetic>', () => {
    const u = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, webSearchRequests: 0 }
    expect(unpricedModels({ 'claude-opus-5-5': u, 'claude-opus-5-9': u, 'claude-sonnet-6': u, '<synthetic>': u })).toEqual([
      { model: 'claude-opus-5-9', priced_as: 'claude-opus-5' },
      { model: 'claude-sonnet-6', priced_as: FALLBACK_MODEL },
    ])
    expect(unpricedModels(undefined)).toEqual([])
  })
})

describe('pricedAs', () => {
  it('names the entry whose rates were used', () => {
    expect(pricedAs('claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(pricedAs('claude-opus-4-5-20251101')).toBe('claude-opus-4-5')
    expect(pricedAs('claude-opus-5-9')).toBe('claude-opus-5')
    expect(pricedAs('claude-sonnet-6')).toBe(FALLBACK_MODEL)
  })
})

describe('estimateCostFromUsage', () => {
  it('sums all four token buckets at per-token rates', () => {
    const cost = estimateCostFromUsage('claude-opus-4-8', {
      input_tokens: MTOK,
      output_tokens: MTOK,
      cache_creation_input_tokens: MTOK,
      cache_read_input_tokens: MTOK,
    })
    // 5 + 25 + 6.25 + 0.50
    expect(cost).toBeCloseTo(36.75)
  })

  it('treats missing fields as zero', () => {
    expect(estimateCostFromUsage('claude-opus-4-8', {} as TurnUsage)).toBe(0)
  })
})

describe('estimateTotalCostFromModel', () => {
  it('matches the per-usage estimator', () => {
    const cost = estimateTotalCostFromModel('claude-sonnet-4-6', {
      inputTokens: MTOK,
      outputTokens: MTOK,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      costUSD: 0,
      webSearchRequests: 0,
    })
    expect(cost).toBeCloseTo(18) // 3 + 15
  })
})

describe('cacheEfficiency', () => {
  it('computes savings, hit rate, and counterfactual cost', () => {
    const result = cacheEfficiency('claude-opus-4-8', {
      inputTokens: MTOK,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: MTOK,
      costUSD: 0,
      webSearchRequests: 0,
    })
    expect(result.savedUSD).toBeCloseTo(4.5) // (5 - 0.5) per MTok
    expect(result.hitRate).toBeCloseTo(0.5)
    expect(result.wouldHavePaidUSD).toBeCloseTo(10)
  })

  it('returns zero hit rate with no context tokens', () => {
    const result = cacheEfficiency('claude-opus-4-8', {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      costUSD: 0,
      webSearchRequests: 0,
    })
    expect(result.hitRate).toBe(0)
  })
})
