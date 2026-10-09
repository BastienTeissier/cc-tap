import { HARNESS_LABELS, type Harness } from '@/types/harness'
import { cn } from '@/lib/utils'

// Tailwind needs literal class names: these match HARNESS_COLORS in types/harness.ts
const COLORS: Record<Harness, string> = {
  claude: 'bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/30',
  codex: 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 border-emerald-500/30',
  copilot: 'bg-violet-500/20 text-violet-700 dark:text-violet-400 border-violet-500/30',
}

/** The CLI that recorded a session, as a small colored tag */
export function HarnessBadge({ harness, count, className }: { harness: Harness; count?: number; className?: string }) {
  return (
    <span
      title={HARNESS_LABELS[harness]}
      className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[12px] font-medium border whitespace-nowrap', COLORS[harness], className)}
    >
      {harness}
      {count !== undefined && <span className="ml-1 tabular-nums opacity-70">{count}</span>}
    </span>
  )
}
