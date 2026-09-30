import { Card, CardContent } from '@/components/ui/card'
import { Radio, Terminal } from 'lucide-react'

const RESUME_COMMAND = `OTEL_LOG_RAW_API_BODIES=file:$HOME/.cc-lens/otel-bodies claude --resume`

export function CapturesEmptyState({ available }: { available: boolean }) {
  if (!available) {
    return (
      <Card className="mx-auto max-w-2xl">
        <CardContent className="flex flex-col gap-3 py-10 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <Radio className="h-5 w-5 text-muted-foreground" />
          </div>
          <h3 className="text-base font-semibold">No API captures yet</h3>
          <p className="text-sm text-muted-foreground">
            Click <strong>Live Capture</strong> in the top bar, then <strong>Start</strong>, and run Claude Code
            with the command it shows. The requests and responses of that session will appear here.
          </p>
        </CardContent>
      </Card>
    )
  }
  return (
    <Card className="mx-auto max-w-2xl">
      <CardContent className="flex flex-col gap-3 py-10 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Terminal className="h-5 w-5 text-muted-foreground" />
        </div>
        <h3 className="text-base font-semibold">No captures for this session</h3>
        <p className="text-sm text-muted-foreground">
          Nothing was recorded for this session yet. With capture started from <strong>Live Capture</strong>,
          resume work in this session:
        </p>
        <pre className="mx-auto rounded-md bg-muted px-3 py-2 text-left text-xs font-mono text-muted-foreground">
          {RESUME_COMMAND}
        </pre>
        <p className="text-xs text-muted-foreground">
          In proxy mode, use the command from the Live Capture popover instead.
        </p>
      </CardContent>
    </Card>
  )
}
