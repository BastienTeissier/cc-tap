/** The coding-agent CLIs whose sessions cc-tap reads */
export const HARNESSES = ['claude', 'codex', 'copilot'] as const

export type Harness = (typeof HARNESSES)[number]

export const HARNESS_LABELS: Record<Harness, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  copilot: 'Copilot CLI',
}

export function isHarness(x: unknown): x is Harness {
  return typeof x === 'string' && (HARNESSES as readonly string[]).includes(x)
}
