import { NextResponse } from 'next/server'
import { HARNESSES, type Harness } from '@/types/harness'
import { detectedHarnesses } from '@/lib/harness/registry'
import { existingHarnessDir } from '@/lib/harness/dirs'

export const dynamic = 'force-dynamic'

export interface HarnessesResponse {
  /** Harnesses with a reader whose dir exists */
  detected: Harness[]
  /** Each harness's dir when it exists on disk */
  dirs: Record<Harness, string | null>
}

export async function GET() {
  const body: HarnessesResponse = {
    detected: detectedHarnesses(),
    dirs: Object.fromEntries(HARNESSES.map(h => [h, existingHarnessDir(h)])) as Record<Harness, string | null>,
  }
  return NextResponse.json(body)
}
