import { NextResponse } from 'next/server'
import { HARNESSES, type Harness, type HarnessesResponse } from '@/types/harness'
import { detectedHarnesses } from '@/lib/harness/registry'
import { existingHarnessDir } from '@/lib/harness/dirs'

export const dynamic = 'force-dynamic'

export async function GET() {
  const body: HarnessesResponse = {
    detected: detectedHarnesses(),
    dirs: Object.fromEntries(HARNESSES.map(h => [h, existingHarnessDir(h)])) as Record<Harness, string | null>,
  }
  return NextResponse.json(body)
}
