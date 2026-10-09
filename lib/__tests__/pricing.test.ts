import { describe, it, expect, afterAll, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

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
  vendorOf,
  pricingNote,
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

  it('falls back to current Opus rates for unknown Claude models', () => {
    expect(getPricing('claude-future-model').input * MTOK).toBeCloseTo(5)
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

  it('prices a missing model at the Claude fallback, not at zero', () => {
    expect(pricedAs('')).toBe(FALLBACK_MODEL)
    expect(getPricing('').input * MTOK).toBeCloseTo(5)
  })
})

describe('1-hour cache writes', () => {
  // A main-thread turn: Claude Code writes it to the 1-hour cache
  const usage: TurnUsage = {
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: MTOK,
    cache_creation: { ephemeral_5m_input_tokens: 250_000, ephemeral_1h_input_tokens: 750_000 },
  }

  it('cost 2× input, the 5-minute ones 1.25×', () => {
    expect(getPricing('claude-fable-5-1').cacheWrite1h * MTOK).toBeCloseTo(20)
    expect(getPricing('claude-opus-5-5').cacheWrite1h * MTOK).toBeCloseTo(8)
    expect(estimateCostFromUsage('claude-fable-5-1', usage)).toBeCloseTo(0.25 * 12.5 + 0.75 * 20)
  })

  it('are priced from the per-model totals too', () => {
    const cost = estimateTotalCostFromModel('claude-fable-5-1', {
      inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: MTOK,
      cacheCreation1hInputTokens: 750_000, costUSD: 0, webSearchRequests: 0,
    })
    expect(cost).toBeCloseTo(0.25 * 12.5 + 0.75 * 20)
  })

  it('without a TTL split, are all 5-minute ones, as before', () => {
    expect(estimateCostFromUsage('claude-fable-5-1', { ...usage, cache_creation: undefined })).toBeCloseTo(12.5)
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

describe('OpenAI models', () => {
  const usage = (u: Partial<TurnUsage>): TurnUsage => ({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...u })

  it('tells the vendor from the model id', () => {
    expect(vendorOf('claude-opus-5-5')).toBe('anthropic')
    for (const m of ['gpt-5.5', 'gpt-5.3-codex', 'o3', 'o4-mini', 'codex-mini-latest', 'gpt-5.6-terra']) expect(vendorOf(m)).toBe('openai')
    for (const m of ['llama-x', 'o9', 'o3x']) expect(vendorOf(m)).toBe('unknown')
  })

  it('prices an unknown GPT at the OpenAI fallback, never at Claude rates', () => {
    expect(pricedAs('gpt-9')).toBe('gpt-5.5')
    expect(pricedAs('gpt-5.2-codex')).toBe('gpt-5.2')
    expect(pricedAs('gpt-5.1-codex-mini')).toBe('gpt-5.1-codex-mini')
    expect(pricedAs('claude-sonnet-6')).toBe(FALLBACK_MODEL)
  })

  it('flags an OpenAI id that borrows another entry as an estimate', () => {
    const u = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, webSearchRequests: 0 }
    expect(unpricedModels({ 'gpt-4.1-nano': u, 'gpt-5.2-codex': u, 'gpt-5-2025-08-07': u, 'gpt-5.5': u })).toEqual([
      { model: 'gpt-4.1-nano', priced_as: 'gpt-4.1' },
      { model: 'gpt-5.2-codex', priced_as: 'gpt-5.2' },
    ])
  })

  it('leaves a model of an unknown vendor unpriced, at no cost', () => {
    const u = { inputTokens: MTOK, outputTokens: MTOK, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, webSearchRequests: 0 }
    expect(unpricedModels({ 'llama-x': u })).toEqual([{ model: 'llama-x', priced_as: '' }])
    expect(estimateTotalCostFromModel('llama-x', u)).toBe(0)
  })

  it('charges cache reads at the cached-input rate and cache writes as input', () => {
    expect(estimateCostFromUsage('gpt-5.5', usage({ cache_read_input_tokens: MTOK }))).toBeCloseTo(0.5)
    expect(estimateCostFromUsage('gpt-5.5', usage({ input_tokens: MTOK }))).toBeCloseTo(5)
    expect(estimateCostFromUsage('gpt-5.5', usage({
      cache_creation_input_tokens: MTOK,
      cache_creation: { ephemeral_5m_input_tokens: MTOK / 2, ephemeral_1h_input_tokens: MTOK / 2 },
    }))).toBeCloseTo(5)
  })

  it('takes an OpenAI entry from pricing.json over the default', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-lens-pricing-'))
    await fs.writeFile(path.join(dir, 'pricing.json'), JSON.stringify({ 'gpt-5.5': { input: 1, output: 2, cacheWrite: 1, cacheRead: 0.1 } }))
    const previous = process.env.CC_LENS_CONFIG_DIR
    process.env.CC_LENS_CONFIG_DIR = dir
    try {
      vi.resetModules()
      const fresh = await import('@/lib/pricing')
      expect(fresh.getPricing('gpt-5.5').input * MTOK).toBeCloseTo(1)
      expect(fresh.getPricing('gpt-5.5').cacheRead * MTOK).toBeCloseTo(0.1)
    } finally {
      process.env.CC_LENS_CONFIG_DIR = previous
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('pricingNote', () => {
  it('words borrowed rates as an estimate and no rates as unpriced', () => {
    expect(pricingNote('gpt-4.1')).toEqual({ label: 'est.', text: 'charged at gpt-4.1 rates' })
    expect(pricingNote('')).toEqual({ label: 'unpriced', text: 'unpriced, counted as $0' })
  })
})

/** A fresh pricing module reading `file` as ~/.cc-lens/pricing.json */
async function withPricingFile<T>(file: Record<string, unknown>, run: (p: typeof import('@/lib/pricing')) => T): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-lens-pricing-'))
  await fs.writeFile(path.join(dir, 'pricing.json'), JSON.stringify(file))
  const previous = process.env.CC_LENS_CONFIG_DIR
  process.env.CC_LENS_CONFIG_DIR = dir
  try {
    vi.resetModules()
    return run(await import('@/lib/pricing'))
  } finally {
    process.env.CC_LENS_CONFIG_DIR = previous
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('Copilot AI units', () => {
  it('prices AI units at $0.01 by default', async () => {
    const { copilotCostUSD, AIU_USD } = await import('@/lib/pricing')
    expect(AIU_USD).toBe(0.01)
    expect(copilotCostUSD(21_278_710_000)).toBeCloseTo(0.2127871)
  })

  it('takes the rate from pricing.json, without reading it as a model', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await withPricingFile({ 'copilot.aiu_usd': 0.02 }, (p) => {
        expect(p.copilotCostUSD(2e9)).toBeCloseTo(0.04)
        expect(p.getPricing('gpt-5.5').input).toBeGreaterThan(0)
      })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('leaves Copilot to the token table when the rate is null', async () => {
    await withPricingFile({ 'copilot.aiu_usd': null }, (p) => {
      expect(p.aiuRate()).toBeNull()
      expect(p.copilotCostUSD(2e9)).toBeNull()
    })
  })
})
