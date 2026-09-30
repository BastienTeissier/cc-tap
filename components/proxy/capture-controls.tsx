'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'

// Live Capture has two modes. OTel (default): Claude Code keeps talking to
// api.anthropic.com and logs each call's bodies to a directory the ingester
// tails. Proxy (advanced): Claude Code is pointed at a local reverse proxy,
// which sees the wire traffic but changes how Claude Code behaves.

export interface OtelStatus {
  running: boolean
  pid?: number
  startedAt?: number
  bodiesDir: string
  command: string
}

export interface ProxyStatus {
  running: boolean
  pid?: number
  port?: number
  startedAt?: number
}

export type CaptureMode = 'otel' | 'proxy'

export function proxyCommand(port: number): string {
  return `ENABLE_TOOL_SEARCH=true ANTHROPIC_BASE_URL=http://localhost:${port} claude`
}

export const PROXY_CAVEAT =
  'A custom ANTHROPIC_BASE_URL changes how Claude Code behaves (auto-mode safeguards, beta headers, tool search off unless ENABLE_TOOL_SEARCH=true), so captures may not match a normal session.'

const fetcher = (url: string) => fetch(url).then(r => {
  if (!r.ok) throw new Error(`API error ${r.status}`)
  return r.json()
})

/** Status of both capture modes, polled, with start/stop actions. */
export function useCaptureStatus() {
  const { data: otel, mutate: mutateOtel } = useSWR<OtelStatus>('/api/otel/status', fetcher, { refreshInterval: 3000 })
  const { data: proxy, mutate: mutateProxy } = useSWR<ProxyStatus>('/api/proxy/status', fetcher, { refreshInterval: 3000 })
  async function act(mode: CaptureMode, action: 'start' | 'stop') {
    await fetch(`/api/${mode}/${action}`, { method: 'POST' })
    await (mode === 'otel' ? mutateOtel() : mutateProxy())
  }
  return { otel, proxy, act }
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="outline"
      size="icon"
      className="h-7 w-7 shrink-0"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch { /* ignore — clipboard may be blocked in some contexts */ }
      }}
      aria-label="Copy to clipboard"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  )
}

export function CommandSnippet({ command }: { command: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-xs font-mono" title={command}>{command}</code>
      <CopyButton text={command} />
    </div>
  )
}
