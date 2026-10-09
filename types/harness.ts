/** The coding-agent CLIs whose sessions cc-tap reads */
export const HARNESSES = ['claude', 'codex', 'copilot'] as const

export type Harness = (typeof HARNESSES)[number]

export const HARNESS_LABELS: Record<Harness, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  copilot: 'Copilot CLI',
}

/** Each harness's hue for charts; HarnessBadge uses the matching Tailwind classes (amber, emerald, violet) */
export const HARNESS_COLORS: Record<Harness, string> = {
  claude: '#f59e0b',
  codex: '#10b981',
  copilot: '#8b5cf6',
}

/** GET /api/harnesses */
export interface HarnessesResponse {
  /** Harnesses with a reader whose dir exists */
  detected: Harness[]
  /** Each harness's dir when it exists on disk */
  dirs: Record<Harness, string | null>
}

export function isHarness(x: unknown): x is Harness {
  return typeof x === 'string' && (HARNESSES as readonly string[]).includes(x)
}
