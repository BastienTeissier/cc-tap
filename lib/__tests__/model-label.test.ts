import { describe, it, expect } from 'vitest'
import { modelLabel, modelShortId, parseModel } from '@/lib/model-label'

describe('modelLabel', () => {
  it('reads point releases instead of the major they start with', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelLabel('claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1')
    expect(modelLabel('claude-opus-5')).toBe('Opus 5')
    expect(modelLabel('claude-sonnet-5')).toBe('Sonnet 5')
    expect(modelLabel('claude-opus-4-8')).toBe('Opus 4.8')
    expect(modelLabel('claude-haiku-4-5')).toBe('Haiku 4.5')
  })

  it('ignores date, context and platform decorations', () => {
    expect(modelLabel('claude-opus-5-5[1m]')).toBe('Opus 5.5')
    expect(modelLabel('claude-opus-4-5-20251101')).toBe('Opus 4.5')
    expect(modelLabel('claude-opus-4-20250514')).toBe('Opus 4')
    expect(modelLabel('claude-opus-4-5@20251101')).toBe('Opus 4.5')
    expect(modelLabel('us.anthropic.claude-sonnet-5-5-v1:0')).toBe('Sonnet 5.5')
  })

  it('labels models this file has never heard of', () => {
    expect(modelLabel('claude-sonnet-6')).toBe('Sonnet 6')
    expect(modelLabel('claude-opus-6-1')).toBe('Opus 6.1')
    expect(modelLabel('claude-mythos-5-1')).toBe('Mythos 5.1')
  })

  it('reads pre-4 ids with the version first', () => {
    expect(modelLabel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
    expect(modelLabel('claude-3-opus-20240229')).toBe('Opus 3')
  })

  it('returns null for anything else', () => {
    expect(modelLabel('<synthetic>')).toBeNull()
    expect(modelLabel('gpt-5')).toBeNull()
    expect(modelLabel('claude-opusx-1')).toBeNull()
    expect(parseModel('')).toBeNull()
  })
})

describe('modelShortId', () => {
  it('keeps the claude- prefix and dots the version', () => {
    expect(modelShortId('claude-opus-5-5')).toBe('claude-opus-5.5')
    expect(modelShortId('claude-sonnet-5-5-20260901')).toBe('claude-sonnet-5.5')
    expect(modelShortId('claude-opus-5')).toBe('claude-opus-5')
    expect(modelShortId('<synthetic>')).toBeNull()
  })
})
