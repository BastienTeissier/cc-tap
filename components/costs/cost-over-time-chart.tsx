'use client'

import { useMemo } from 'react'
import { AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from 'recharts'
import { formatCost } from '@/lib/decode'
import { modelLabel } from '@/lib/model-label'
import { HARNESS_LABELS, isHarness, type Harness } from '@/types/harness'
import type { DailyCost } from '@/types/claude'

// Same hues as HarnessBadge
const HARNESS_COLORS: Record<Harness, string> = {
  claude: '#f59e0b',
  codex: '#10b981',
  copilot: '#8b5cf6',
}

const MODEL_COLORS: Record<string, string> = {
  'claude-fable-5-1':       '#ec4899',
  'claude-fable-5':         '#a21caf',
  'claude-opus-5-5':        '#b91c1c',
  'claude-opus-5':          '#ef4444',
  'claude-opus-4-8':        '#fb923c',
  'claude-opus-4-7':        '#f97316',
  'claude-opus-4-6':        '#d97706',
  'claude-opus-4-5-20251101': '#a78bfa',
  'claude-sonnet-5-5':      '#1e40af',
  'claude-sonnet-5':        '#2563eb',
  'claude-sonnet-4-6':      'var(--viz-sky)',
  'claude-haiku-4-5':       '#34d399',
}

// Longest key first so claude-fable-5-1-* takes the 5.1 colour, not Fable 5's
const MODEL_COLOR_KEYS = Object.keys(MODEL_COLORS).sort((a, b) => b.length - a.length)

function colorForModel(m: string): string {
  for (const key of MODEL_COLOR_KEYS) {
    if (m === key || m.startsWith(`${key}-`)) return MODEL_COLORS[key]
  }
  return '#7a8494'
}

function shortModel(m: string): string {
  return modelLabel(m) ?? m
}

interface Props {
  daily: DailyCost[]
  window: Window
  onWindowChange: (window: Window) => void
}

export type CostWindow = 30 | 90 | 'all'
type Window = CostWindow

export function CostOverTimeChart({ daily, window, onWindowChange }: Props) {
  // One series per model; per harness instead once the range mixes harnesses
  const { data, series, byHarness } = useMemo(() => {
    const sorted = [...daily].sort((a, b) => a.date.localeCompare(b.date))
    const sliced = sorted
    const harnessSet = new Set<string>()
    for (const d of sliced) Object.keys(d.by_harness ?? {}).forEach(h => harnessSet.add(h))
    const byHarness = harnessSet.size > 1
    const keySet = new Set<string>()
    for (const d of sliced) Object.keys((byHarness ? d.by_harness : d.costs) ?? {}).forEach(k => keySet.add(k))
    const series = [...keySet]
    return {
      data: sliced.map(d => {
        const values: Record<string, number | undefined> = byHarness ? d.by_harness : d.costs
        return {
          date: d.date.slice(5), // MM-DD
          ...Object.fromEntries(series.map(k => [k, values[k] ?? 0])),
          total: d.total,
        }
      }),
      series,
      byHarness,
    }
  }, [daily])
  const colorFor = (k: string) => (byHarness && isHarness(k) ? HARNESS_COLORS[k] : colorForModel(k))
  const labelFor = (k: string) => (byHarness && isHarness(k) ? HARNESS_LABELS[k] : shortModel(k))

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[13px] font-bold text-muted-foreground uppercase tracking-widest">Cost Over Time</h3>
        <div className="flex gap-1">
          {([30, 90, 'all'] as Window[]).map(w => (
            <button
              key={w}
              onClick={() => onWindowChange(w)}
              className={`px-2 py-0.5 rounded text-[12px] transition-colors ${window === w ? 'bg-primary text-black font-bold' : 'text-muted-foreground hover:text-foreground border border-border'}`}
            >
              {w === 'all' ? 'All' : `${w}d`}
            </button>
          ))}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} tickLine={false} axisLine={false} tickFormatter={v => `$${v.toFixed(2)}`} width={48} />
          <Tooltip
            contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 12 }}
            formatter={(val: number | undefined, name?: string) => [formatCost(val ?? 0), labelFor(name ?? '')]}
          />
          {series.map(k => (
            <Area
              key={k}
              type="monotone"
              dataKey={k}
              stackId="1"
              stroke={colorFor(k)}
              fill={colorFor(k) + '30'}
              strokeWidth={1.5}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
