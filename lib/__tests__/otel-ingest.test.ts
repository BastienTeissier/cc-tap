import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { assembleSseMessage, parseSseEvents } from '@/lib/sse'
import { messageToSse, otlpLogRecords, createIngester, ORPHAN_ERROR } from '@/proxy/otel-ingest'
import { openStore, parseSseUsage } from '@/proxy/capture-store'

// The final message Claude Code writes to <request-id>.response.json (thinking already redacted by CC).
const MESSAGE = {
  id: 'msg_tool',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-5',
  content: [
    { type: 'thinking', thinking: '<REDACTED>', signature: 'sig123' },
    { type: 'text', text: 'Running it.' },
    { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi', description: 'say hi' } },
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } },
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: { input_tokens: 1200, cache_creation_input_tokens: 300, cache_read_input_tokens: 800, output_tokens: 42, service_tier: 'standard' },
}

const SESSION = '7762d588-906e-4801-a31d-f6ae72cc41ad'

function requestBody(extra: Record<string, unknown> = {}) {
  return {
    model: 'claude-opus-5-5',
    stream: true,
    betas: ['claude-code-20250219'],
    metadata: { user_id: JSON.stringify({ device_id: 'dev1', account_uuid: 'acc1', session_id: SESSION }) },
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.285.17a; cc_entrypoint=sdk-cli; cch=00000;' }, { type: 'text', text: 'You are Claude Code' }],
    messages: [{ role: 'user', content: 'run echo' }],
    tools: [{ name: 'Bash' }, { name: 'Read' }],
    ...extra,
  }
}

describe('messageToSse', () => {
  it('round-trips through the dashboard SSE reassembly', () => {
    expect(assembleSseMessage(messageToSse(MESSAGE))).toEqual(MESSAGE)
  })

  it('omits stop_sequence when the message has none', () => {
    const { stop_sequence: _omit, ...noSeq } = MESSAGE
    void _omit
    expect(assembleSseMessage(messageToSse(noSeq))).toEqual(noSeq)
  })

  it('marks the stream as synthetic without adding an event', () => {
    const sse = messageToSse(MESSAGE)
    expect(sse.startsWith(': cc-tap otel-ingest')).toBe(true)
    const names = parseSseEvents(sse).map((e) => e.event)
    expect(names[0]).toBe('message_start')
    expect(names.at(-1)).toBe('message_stop')
    expect(parseSseEvents(sse).every((e) => !e.parseError)).toBe(true)
  })

  it('carries the usage the proxy would have parsed', () => {
    expect(parseSseUsage(Buffer.from(messageToSse(MESSAGE)))).toEqual({
      input_tokens: 1200, output_tokens: 42, cache_read_tokens: 800, cache_creation_tokens: 300,
    })
  })
})

describe('otlpLogRecords', () => {
  it('flattens OTLP JSON and turns int64 strings into numbers', () => {
    const recs = otlpLogRecords({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{
        timeUnixNano: '1790744245254000000',
        body: { stringValue: 'claude_code.api_request' },
        attributes: [
          { key: 'event.name', value: { stringValue: 'api_request' } },
          { key: 'duration_ms', value: { intValue: '90' } },
          { key: 'cost_usd', value: { doubleValue: 0.0073 } },
          { key: 'request_id', value: { stringValue: 'req_1' } },
        ],
      }] }] }],
    })
    expect(recs).toEqual([{ name: 'api_request', timeMs: 1790744245254, attrs: { 'event.name': 'api_request', duration_ms: 90, cost_usd: 0.0073, request_id: 'req_1' } }])
  })

  it('tolerates empty payloads', () => {
    expect(otlpLogRecords({})).toEqual([])
    expect(otlpLogRecords(null)).toEqual([])
  })
})

describe('createIngester', () => {
  let tmp: string
  let bodies: string
  let store: ReturnType<typeof openStore>

  const otlp = (name: string, attrs: Record<string, string | number>) => ({
    resourceLogs: [{ scopeLogs: [{ logRecords: [{
      body: { stringValue: `claude_code.${name}` },
      attributes: Object.entries({ 'event.name': name, 'session.id': SESSION, ...attrs }).map(([key, v]) => ({
        key, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v },
      })),
    }] }] }],
  })
  const rows = () => store.db.prepare('SELECT * FROM captures ORDER BY timestamp, request_id').all() as Record<string, unknown>[]
  const writeRequest = (id: string, body = requestBody(), mtime?: Date) => {
    const p = path.join(bodies, `${id}.request.json`)
    fs.writeFileSync(p, JSON.stringify(body))
    if (mtime) fs.utimesSync(p, mtime, mtime)
  }
  const appendIndex = (entry: Record<string, unknown>) =>
    fs.appendFileSync(path.join(bodies, 'index.jsonl'), JSON.stringify(entry) + '\n')
  const answer = (bodyId: string, requestId: string, msg = MESSAGE) => {
    fs.writeFileSync(path.join(bodies, `${requestId}.response.json`), JSON.stringify(msg))
    appendIndex({
      timestamp: new Date(Date.now() + 1000).toISOString(), session_id: SESSION, query_source: 'sdk', model: msg.model,
      request_id: requestId, message_id: msg.id, request_file: `${bodyId}.request.json`, response_file: `${requestId}.response.json`,
    })
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-lens-otel-'))
    bodies = path.join(tmp, 'bodies')
    fs.mkdirSync(bodies)
    store = openStore({ root: path.join(tmp, 'root') })
  })
  afterEach(() => {
    store.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('records an index line as a capture the dashboard can read', () => {
    writeRequest('body-1')
    answer('body-1', 'req_1')
    const ing = createIngester({ store, bodiesDir: bodies })
    expect(ing.pollIndex()).toBe(1)

    const [r] = rows()
    expect(r).toMatchObject({
      request_id: 'body-1', session_id: SESSION, account_uuid: 'acc1', device_id: 'dev1',
      cc_version: '2.1.285.17a', cc_entrypoint: 'sdk-cli', cc_config_hash: null,
      method: 'POST', path: '/v1/messages?beta=true', model: 'claude-opus-5-5', is_streaming: 1,
      status_code: 200, error: null,
      input_tokens: 1200, output_tokens: 42, cache_read_tokens: 800, cache_creation_tokens: 300,
      system_blocks: 2, message_count: 1, tool_count: 2,
      request_body_path: path.join(SESSION, 'body-1.req.json.gz'),
      response_body_path: path.join(SESSION, 'body-1.res.gz'),
    })
    const res = zlib.gunzipSync(fs.readFileSync(path.join(store.payloadsDir, r.response_body_path as string))).toString()
    expect(assembleSseMessage(res)).toEqual(MESSAGE)
    const req = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(store.payloadsDir, r.request_body_path as string))).toString())
    expect(req).toEqual(requestBody())
  })

  it('stores a non-streaming response as JSON', () => {
    writeRequest('body-ns', requestBody({ stream: false }))
    answer('body-ns', 'req_ns')
    createIngester({ store, bodiesDir: bodies }).pollIndex()
    const [r] = rows()
    expect(r.is_streaming).toBe(0)
    const res = zlib.gunzipSync(fs.readFileSync(path.join(store.payloadsDir, r.response_body_path as string))).toString()
    expect(JSON.parse(res)).toEqual(MESSAGE)
  })

  it('only reads new lines, waits for a partial line, and is idempotent on replay', () => {
    const ing = createIngester({ store, bodiesDir: bodies })
    writeRequest('body-1')
    answer('body-1', 'req_1')
    expect(ing.pollIndex()).toBe(1)
    expect(ing.pollIndex()).toBe(0)

    writeRequest('body-2')
    fs.writeFileSync(path.join(bodies, 'req_2.response.json'), JSON.stringify(MESSAGE))
    const line = JSON.stringify({ timestamp: new Date().toISOString(), request_id: 'req_2', request_file: 'body-2.request.json', response_file: 'req_2.response.json' })
    fs.appendFileSync(path.join(bodies, 'index.jsonl'), line.slice(0, 20))
    expect(ing.pollIndex()).toBe(0)
    fs.appendFileSync(path.join(bodies, 'index.jsonl'), line.slice(20) + '\n')
    expect(ing.pollIndex()).toBe(1)
    expect(rows()).toHaveLength(2)

    // A fresh ingester replays the whole index onto the same rows.
    expect(createIngester({ store, bodiesDir: bodies }).pollIndex()).toBe(2)
    expect(rows()).toHaveLength(2)
  })

  it('retries a line whose response file is not written yet', () => {
    const ing = createIngester({ store, bodiesDir: bodies })
    writeRequest('body-1')
    appendIndex({ timestamp: new Date().toISOString(), request_id: 'req_1', request_file: 'body-1.request.json', response_file: 'req_1.response.json' })
    expect(ing.pollIndex()).toBe(0)
    fs.writeFileSync(path.join(bodies, 'req_1.response.json'), JSON.stringify(MESSAGE))
    expect(ing.pollIndex()).toBe(1)
  })

  it('takes duration_ms from the api_request event, before or after the index line', () => {
    const ing = createIngester({ store, bodiesDir: bodies })
    writeRequest('body-1')
    answer('body-1', 'req_1')
    ing.pollIndex()
    ing.handleOtlp(otlp('api_request', { request_id: 'req_1', duration_ms: 90 }))
    expect(rows()[0].duration_ms).toBe(90)

    ing.handleOtlp(otlp('api_request', { request_id: 'req_2', duration_ms: 13 }))
    writeRequest('body-2')
    answer('body-2', 'req_2')
    ing.pollIndex()
    expect(rows().find((r) => r.request_id === 'body-2')?.duration_ms).toBe(13)
  })

  it('records unanswered request bodies after the grace period', () => {
    const ing = createIngester({ store, bodiesDir: bodies, orphanGraceMs: 60_000 })
    writeRequest('attempt-1', requestBody(), new Date(Date.now() - 120_000))
    writeRequest('attempt-2')
    answer('attempt-2', 'req_ok')
    ing.pollIndex()
    ing.sweepOrphans()
    const r = rows().find((x) => x.request_id === 'attempt-1')
    expect(r).toMatchObject({ status_code: null, error: ORPHAN_ERROR, response_body_path: null, session_id: SESSION })
    expect(rows()).toHaveLength(2)
  })

  it('attributes api_error to the session’s latest unanswered body', () => {
    const ing = createIngester({ store, bodiesDir: bodies })
    writeRequest('a1')
    writeRequest('a2')
    ing.handleOtlp(otlp('api_request_body', { request_body_id: 'a1' }))
    ing.handleOtlp(otlp('api_request_body', { request_body_id: 'a2' }))
    ing.handleOtlp(otlp('api_error', { error: 'api_error', status_code: 500, duration_ms: 16, attempt: 2 }))
    expect(rows()).toEqual([expect.objectContaining({ request_id: 'a2', status_code: 500, error: 'api_error', duration_ms: 16 })])
  })
})
