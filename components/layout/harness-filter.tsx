'use client'

import useSWR from 'swr'
import { useHarnessFilter } from '@/hooks/use-harness-filter'
import { HARNESS_LABELS, type Harness, type HarnessesResponse } from '@/types/harness'
import { cn } from '@/lib/utils'

const fetcher = (url: string) => fetch(url).then(r => r.json())

/**
 * One toggle per detected harness, writing `?h=`. Nothing selected and everything
 * selected both mean "all", so either clears the param. Hidden with a single harness.
 */
export function HarnessFilter() {
  const { data } = useSWR<HarnessesResponse>('/api/harnesses', fetcher, { revalidateOnFocus: false })
  const { harnesses, setHarnesses } = useHarnessFilter()
  const detected = data?.detected ?? []
  if (detected.length < 2) return null

  const selected = harnesses ?? detected
  function toggle(h: Harness) {
    const next = selected.includes(h) ? selected.filter(x => x !== h) : [...selected, h]
    const all = next.length === 0 || detected.every(d => next.includes(d))
    setHarnesses(all ? null : detected.filter(d => next.includes(d)))
  }

  return (
    <div role="group" aria-label="Harness filter" className="hidden sm:flex items-center rounded-md border border-border p-0.5">
      {detected.map(h => (
        <button
          key={h}
          type="button"
          aria-pressed={selected.includes(h)}
          title={HARNESS_LABELS[h]}
          onClick={() => toggle(h)}
          className={cn(
            'px-2 py-0.5 text-xs rounded transition-colors',
            selected.includes(h) ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {h}
        </button>
      ))}
    </div>
  )
}
