'use client'

import { useCallback, useMemo } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { harnessesFromSearch, harnessesToSearch } from '@/lib/harness-filter'
import type { Harness } from '@/types/harness'

/** An API URL with the harness filter appended (unchanged when no filter is set) */
export function withHarnessQuery(base: string, harnesses: Harness[] | null): string {
  if (!harnesses) return base
  return `${base}${base.includes('?') ? '&' : '?'}h=${harnesses.join(',')}`
}

/**
 * The page's `?h=` harness filter. Pages build their SWR keys through `apiQuery`,
 * so the API applies the same filter server-side.
 */
export function useHarnessFilter() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const search = searchParams.toString()

  const harnesses = useMemo(() => harnessesFromSearch(search), [search])

  const setHarnesses = useCallback((hs: Harness[] | null) => {
    router.replace(`${pathname}${harnessesToSearch(search, hs)}`, { scroll: false })
  }, [router, pathname, search])

  const apiQuery = useCallback((base: string) => withHarnessQuery(base, harnesses), [harnesses])

  return { harnesses, setHarnesses, apiQuery }
}
