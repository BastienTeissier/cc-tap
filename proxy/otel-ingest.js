#!/usr/bin/env node
/* cc-lens OpenTelemetry ingester — capture without a proxy
 * Claude Code keeps talking to api.anthropic.com and writes each API call's
 * bodies itself (OTEL_LOG_RAW_API_BODIES=file:<dir>): <id>.request.json when a
 * request is sent, <request-id>.response.json + one index.jsonl line when its
 * response completes. This tails that index and records each call in the same
 * captures table + payload layout as the proxy, so the dashboard works as is.
 *
 * Optionally it also receives Claude Code's OTLP/HTTP JSON log events (default
 * :4318) to fill what the files lack: api_request → duration_ms, api_error →
 * status code of a call that failed for good.
 *
 * What this mode cannot see, by construction (see the OTel section of the README):
 * HTTP headers, the SSE stream itself (the response is the final message, and
 * is re-serialized here as a synthetic SSE stream), thinking text (Claude Code
 * writes "<REDACTED>"), the status of retried attempts, non-/v1/messages calls.
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const zlib = require('node:zlib')
const { parseRequestSummary, parseSseUsage, parseNonStreamUsage, gzipWrite, openStore } = require('./capture-store')

// Claude Code writes this placeholder instead of the real `cch=` hash in the bodies it logs.
const CCH_PLACEHOLDER = '00000'
const SYNTHETIC_SSE_NOTE = ': cc-tap otel-ingest: synthesized from the final message Claude Code logged, not the wire stream\n\n'
const ORPHAN_ERROR = 'no response recorded: attempt failed, was retried or aborted (OTel exports no status for it)'

// ─── pure helpers ────────────────────────────────────────────────────────────

/**
 * Re-serializes a final Messages API object as an SSE stream, one delta per
 * content block, so the dashboard's SSE view and reassembly keep working.
 * assembleSseMessage(messageToSse(m)) deep-equals m.
 */
function messageToSse(msg) {
  const { content = [], usage, ...rest } = msg
  const events = []
  const ev = (type, data) => events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  ev('message_start', { message: { ...rest, content: [], stop_reason: null, ...('stop_sequence' in msg && { stop_sequence: null }), usage: usage ?? {} } })
  content.forEach((block, index) => {
    switch (block.type) {
      case 'text':
        ev('content_block_start', { index, content_block: { ...block, text: '' } })
        ev('content_block_delta', { index, delta: { type: 'text_delta', text: block.text ?? '' } })
        break
      case 'thinking': {
        const { signature, ...shell } = block
        ev('content_block_start', { index, content_block: { ...shell, thinking: '' } })
        ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: block.thinking ?? '' } })
        if (signature !== undefined) ev('content_block_delta', { index, delta: { type: 'signature_delta', signature } })
        break
      }
      case 'tool_use':
        ev('content_block_start', { index, content_block: { ...block, input: {} } })
        ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } })
        break
      default:
        // server_tool_use, *_tool_result, redacted_thinking…: whole block up front.
        ev('content_block_start', { index, content_block: block })
    }
    ev('content_block_stop', { index })
  })
  const delta = { stop_reason: msg.stop_reason ?? null, ...('stop_sequence' in msg && { stop_sequence: msg.stop_sequence }) }
  ev('message_delta', { delta, usage: { output_tokens: usage?.output_tokens ?? 0 } })
  ev('message_stop', {})
  return SYNTHETIC_SSE_NOTE + events.join('')
}

/** Flattens an OTLP/HTTP JSON logs payload into { name, attrs, timeMs } records. */
function otlpLogRecords(payload) {
  const out = []
  for (const rl of payload?.resourceLogs ?? []) {
    for (const sl of rl.scopeLogs ?? []) {
      for (const r of sl.logRecords ?? []) {
        const attrs = {}
        for (const kv of r.attributes ?? []) {
          const v = kv.value ?? {}
          const raw = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue
          // OTLP JSON encodes int64 as strings; numeric-looking values come back as numbers.
          attrs[kv.key] = v.intValue !== undefined ? Number(raw) : raw
        }
        const name = attrs['event.name'] ?? String(r.body?.stringValue ?? '').replace(/^claude_code\./, '')
        const timeMs = r.timeUnixNano ? Number(BigInt(r.timeUnixNano) / 1_000_000n) : Date.now()
        out.push({ name, attrs, timeMs })
      }
    }
  }
  return out
}

const idFromFile = (file, suffix) => (typeof file === 'string' && file.endsWith(suffix) ? path.basename(file, suffix) : null)

// ─── ingester ────────────────────────────────────────────────────────────────

/**
 * Stateful ingester over one bodies dir. Every write is an INSERT OR REPLACE
 * keyed by Claude Code's request_body_id, so replaying the whole index (e.g.
 * on restart) is idempotent and a later, better answer overwrites an earlier one.
 */
function createIngester({ store, bodiesDir, orphanGraceMs = 120_000, log = () => {} }) {
  const indexPath = path.join(bodiesDir, 'index.jsonl')
  const updateDuration = store.db.prepare(`UPDATE captures SET duration_ms = ? WHERE request_id = ?`)

  let offset = 0
  let partial = ''
  const answered = new Set()          // request_body_ids with a response
  const orphaned = new Set()          // request_body_ids recorded without one
  const rowByServerId = new Map()     // API request-id → request_body_id
  const durationByServerId = new Map() // api_request events seen before their index line
  const bodiesBySession = new Map()   // session.id → request_body_ids, from api_request_body events

  function readRequest(bodyId) {
    const abs = path.join(bodiesDir, `${bodyId}.request.json`)
    try {
      return { buf: fs.readFileSync(abs), mtimeMs: fs.statSync(abs).mtimeMs }
    } catch {
      return null
    }
  }

  function baseRow(bodyId, req, sessionFallback) {
    const summary = parseRequestSummary(req.buf)
    const sessionId = summary.session_id ?? sessionFallback ?? null
    let hasBetas = false
    try { hasBetas = Array.isArray(JSON.parse(req.buf.toString('utf8')).betas) } catch { /* */ }
    const paths = store.bodyPathsFor(sessionId, bodyId)
    return {
      paths,
      summary,
      row: {
        request_id: bodyId,
        session_id: sessionId, account_uuid: summary.account_uuid, device_id: summary.device_id,
        cc_version: summary.cc_version, cc_entrypoint: summary.cc_entrypoint,
        cc_config_hash: summary.cc_config_hash === CCH_PLACEHOLDER ? null : summary.cc_config_hash,
        timestamp: Math.round(req.mtimeMs), // the file is written as the request is sent
        method: 'POST',
        // The SDK sends betas as ?beta=true + an anthropic-beta header; the logged body keeps them as `betas`.
        path: hasBetas ? '/v1/messages?beta=true' : '/v1/messages',
        model: summary.model, is_streaming: summary.is_streaming,
        system_blocks: summary.system_blocks, message_count: summary.message_count, tool_count: summary.tool_count,
        request_body_path: paths.reqRel,
        request_body_bytes: gzipWrite(paths.reqAbs, req.buf),
      },
    }
  }

  /** One index.jsonl line = one successful call. Returns false if its files are not readable yet. */
  function ingestEntry(entry) {
    const bodyId = idFromFile(entry.request_file, '.request.json')
    if (!bodyId || !entry.response_file) return true // nothing we can key on — skip
    const req = readRequest(bodyId)
    let resJson
    try { resJson = fs.readFileSync(path.join(bodiesDir, path.basename(entry.response_file)), 'utf8') } catch { resJson = null }
    if (!req || resJson === null) return false

    const { row, paths, summary } = baseRow(bodyId, req, entry.session_id)
    let resBuf
    let usage
    if (summary.is_streaming) {
      try {
        resBuf = Buffer.from(messageToSse(JSON.parse(resJson)), 'utf8')
      } catch {
        resBuf = Buffer.from(resJson, 'utf8')
      }
      usage = parseSseUsage(resBuf)
    } else {
      resBuf = Buffer.from(resJson, 'utf8')
      usage = parseNonStreamUsage(resBuf)
    }
    const endMs = Date.parse(entry.timestamp)
    const duration = durationByServerId.get(entry.request_id) ??
      (Number.isFinite(endMs) ? Math.max(0, endMs - row.timestamp) : null)

    store.insert({
      ...row,
      duration_ms: duration,
      status_code: 200, error: null,
      ...usage,
      response_body_path: paths.resRel,
      response_body_bytes: gzipWrite(paths.resAbs, resBuf),
    })
    answered.add(bodyId)
    orphaned.delete(bodyId)
    if (entry.request_id) {
      rowByServerId.set(entry.request_id, bodyId)
      durationByServerId.delete(entry.request_id)
    }
    log(`POST ${row.path} → 200 (otel, session=${row.session_id?.slice(0, 8) ?? '—'}, ${entry.query_source ?? '?'})`)
    return true
  }

  /** A request body with no response: a failed, retried or aborted attempt. */
  function recordOrphan(bodyId, { statusCode = null, error = ORPHAN_ERROR, durationMs = null, sessionId = null } = {}) {
    const req = readRequest(bodyId)
    if (!req) return
    const { row } = baseRow(bodyId, req, sessionId)
    store.insert({
      ...row,
      duration_ms: durationMs,
      status_code: statusCode, error,
      input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null,
      response_body_path: null, response_body_bytes: null,
    })
    orphaned.add(bodyId)
    log(`POST ${row.path} → ${statusCode ?? '?'} (otel, no response: ${error})`)
  }

  /** Reads whatever index.jsonl gained since the last call. */
  function pollIndex() {
    let size
    try { size = fs.statSync(indexPath).size } catch { return 0 }
    if (size < offset) { offset = 0; partial = '' } // truncated or replaced
    if (size === offset) return 0
    const fd = fs.openSync(indexPath, 'r')
    const buf = Buffer.alloc(size - offset)
    try { fs.readSync(fd, buf, 0, buf.length, offset) } finally { fs.closeSync(fd) }
    let consumed = offset - Buffer.byteLength(partial, 'utf8') // where `partial` starts
    const lines = (partial + buf.toString('utf8')).split('\n')
    partial = lines.pop() ?? ''
    let ingested = 0
    for (const line of lines) {
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1
      if (line.trim()) {
        let entry = null
        try { entry = JSON.parse(line) } catch { log(`skipping malformed index line: ${line.slice(0, 80)}`) }
        // Files not readable yet: stop here and retry this line on the next poll.
        if (entry && !ingestEntry(entry)) { partial = ''; offset = consumed; return ingested }
        if (entry) ingested++
      }
      consumed += lineBytes
    }
    offset = size
    return ingested
  }

  /** Records request bodies that never got a response within the grace period. */
  function sweepOrphans(now = Date.now()) {
    let files
    try { files = fs.readdirSync(bodiesDir) } catch { return }
    for (const f of files) {
      const bodyId = idFromFile(f, '.request.json')
      if (!bodyId || answered.has(bodyId) || orphaned.has(bodyId)) continue
      let mtimeMs
      try { mtimeMs = fs.statSync(path.join(bodiesDir, f)).mtimeMs } catch { continue }
      if (now - mtimeMs >= orphanGraceMs) recordOrphan(bodyId)
    }
  }

  /** Applies Claude Code's OTLP log events. */
  function handleOtlp(payload) {
    for (const { name, attrs } of otlpLogRecords(payload)) {
      const sessionId = attrs['session.id'] ?? null
      if (name === 'api_request_body' && attrs.request_body_id && sessionId) {
        const list = bodiesBySession.get(sessionId) ?? []
        list.push(attrs.request_body_id)
        bodiesBySession.set(sessionId, list.slice(-50))
      } else if (name === 'api_request' && attrs.request_id && typeof attrs.duration_ms === 'number') {
        const bodyId = rowByServerId.get(attrs.request_id)
        if (bodyId) updateDuration.run(attrs.duration_ms, bodyId)
        else durationByServerId.set(attrs.request_id, attrs.duration_ms)
      } else if (name === 'api_error' && sessionId) {
        // Emitted once per call that failed for good (after retries). It carries no
        // request_body_id: attribute it to the session's latest unanswered body.
        const bodyId = [...(bodiesBySession.get(sessionId) ?? [])].reverse().find(id => !answered.has(id))
        if (bodyId) {
          recordOrphan(bodyId, {
            statusCode: typeof attrs.status_code === 'number' ? attrs.status_code : 0,
            error: String(attrs.error ?? 'api_error'),
            durationMs: typeof attrs.duration_ms === 'number' ? attrs.duration_ms : null,
            sessionId,
          })
        }
      }
    }
  }

  return { pollIndex, sweepOrphans, handleOtlp }
}

// ─── main ────────────────────────────────────────────────────────────────────

function main() {
  const bodiesDir = path.resolve(process.env.CC_LENS_OTEL_BODIES_DIR || path.join(os.homedir(), '.cc-lens', 'otel-bodies'))
  const otlpPort = Number(process.env.CC_LENS_OTLP_PORT ?? 4318)
  const orphanGraceMs = Number(process.env.CC_LENS_OTEL_ORPHAN_GRACE_MS || 120_000)
  fs.mkdirSync(bodiesDir, { recursive: true })

  const store = openStore()
  const log = msg => process.stderr.write(`[cc-lens-otel] ${msg}\n`)
  const ingester = createIngester({ store, bodiesDir, orphanGraceMs, log })

  const tick = () => {
    try {
      if (ingester.pollIndex() > 0) store.enforceRetention()
    } catch (err) {
      log(`poll failed: ${err.message}`)
    }
  }
  tick()
  const pollTimer = setInterval(tick, 500)
  const sweepTimer = setInterval(() => ingester.sweepOrphans(), 15_000)

  let server = null
  if (otlpPort > 0) {
    server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        // Only logs matter; accept metrics/traces too so a shared endpoint doesn't error.
        if (req.method === 'POST' && req.url?.startsWith('/v1/logs')) {
          try {
            let body = Buffer.concat(chunks)
            if (req.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body)
            if (!(req.headers['content-type'] || '').includes('json')) {
              res.writeHead(415, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: 'set OTEL_EXPORTER_OTLP_PROTOCOL=http/json' }))
              return
            }
            tick() // ingest index lines first, so api_request can find its row
            ingester.handleOtlp(JSON.parse(body.toString('utf8')))
          } catch (err) {
            log(`bad OTLP payload: ${err.message}`)
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      })
    })
    server.listen(otlpPort, '127.0.0.1')
  }

  log(`bodies dir   = ${bodiesDir}`)
  log(`inspector.db = ${store.dbPath}`)
  log(`Run Claude Code with:`)
  log(`  CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_LOG_RAW_API_BODIES=file:${bodiesDir}`)
  if (server) {
    log(`  OTEL_LOGS_EXPORTER=otlp OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:${otlpPort}/v1/logs`)
  }

  const shutdown = () => {
    clearInterval(pollTimer)
    clearInterval(sweepTimer)
    try { server?.close() } catch { /* */ }
    try { store.close() } catch { /* */ }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

if (require.main === module) main()

module.exports = { messageToSse, otlpLogRecords, createIngester, CCH_PLACEHOLDER, ORPHAN_ERROR }
