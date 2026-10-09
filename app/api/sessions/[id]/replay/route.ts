import { NextResponse } from 'next/server'
import { findSessionEntry } from '@/lib/harness/session-store'
import { cachedReplay, gzipOf, replayEtag } from '@/lib/replay-cache'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const entry = await findSessionEntry(id)

  if (!entry) {
    return NextResponse.json({ error: 'Session JSONL not found' }, { status: 404 })
  }

  // A reader whose copy is current is told so, and the log is not even parsed
  const etag = await replayEtag(entry)
  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'no-cache' } })
  }

  const replay = await cachedReplay(entry)
  const headers = new Headers({
    'Content-Type': 'application/json',
    ETag: replay.etag,
    // Hold the body, but ask before using it: a live session grows under us
    'Cache-Control': 'no-cache',
    Vary: 'Accept-Encoding',
  })

  // 12 MB of replay is 2.3 MB compressed, and the bytes are made once per
  // version of the log, whoever asks for them.
  if ((req.headers.get('accept-encoding') ?? '').includes('gzip')) {
    const body = gzipOf(replay)
    headers.set('Content-Encoding', 'gzip')
    headers.set('Content-Length', String(body.byteLength))
    return new Response(body as unknown as BodyInit, { headers })
  }

  headers.set('Content-Length', String(replay.json.byteLength))
  return new Response(replay.json as unknown as BodyInit, { headers })
}
