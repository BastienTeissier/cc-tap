'use client'

import { useCallback, useMemo } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { harnessesFromSearch, harnessesToSearch, withHarnessParam } from '@/lib/harness-filter'
import type { Harness } from '@/types/harness'

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
  const rawHarnesses = searchParams.get('h')

  const setHarnesses = useCallback((hs: Harness[] | null) => {
    router.replace(`${pathname}${harnessesToSearch(search, hs)}`, { scroll: false })
  }, [router, pathname, search])

  const apiQuery = useCallback((base: string) => withHarnessParam(base, rawHarnesses), [rawHarnesses])

  return { harnesses, setHarnesses, apiQuery }
}
