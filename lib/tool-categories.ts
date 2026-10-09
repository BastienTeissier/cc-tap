import type { Harness } from '@/types/harness'

export type ToolCategory =
  | 'file-io'
  | 'shell'
  | 'agent'
  | 'web'
  | 'planning'
  | 'todo'
  | 'skill'
  | 'mcp'
  | 'other'

const TOOL_CATEGORIES_BY_HARNESS: Record<Harness, Record<string, ToolCategory>> = {
  claude: {
    Read:           'file-io',
    Write:          'file-io',
    Edit:           'file-io',
    Glob:           'file-io',
    Grep:           'file-io',
    NotebookEdit:   'file-io',

    Bash:           'shell',

    Task:           'agent',
    Agent:          'agent',
    Workflow:       'agent',
    TaskCreate:     'agent',
    TaskUpdate:     'agent',
    TaskList:       'agent',
    TaskOutput:     'agent',
    TaskStop:       'agent',
    TaskGet:        'agent',

    WebSearch:      'web',
    WebFetch:       'web',

    EnterPlanMode:  'planning',
    ExitPlanMode:   'planning',
    AskUserQuestion:'planning',

    TodoWrite:      'todo',

    Skill:          'skill',
    ToolSearch:     'skill',
    ListMcpResourcesTool: 'skill',
    ReadMcpResourceTool:  'skill',
  },

  codex: {
    exec_command:   'shell',
    shell:          'shell',
    shell_command:  'shell',
    write_stdin:    'shell',

    apply_patch:    'file-io',
    read_file:      'file-io',
    view_image:     'file-io',

    update_plan:    'planning',

    web_search:     'web',
  },

  copilot: {},
}

/** Theme tokens from app/globals.css — work in light & dark */
export const CATEGORY_COLORS: Record<ToolCategory, string> = {
  'file-io':  'var(--viz-tool-file-io)',
  'shell':    'var(--viz-tool-shell)',
  'agent':    'var(--viz-tool-agent)',
  'web':      'var(--viz-tool-web)',
  'planning': 'var(--viz-tool-planning)',
  'todo':     'var(--viz-tool-todo)',
  'skill':    'var(--viz-tool-skill)',
  'mcp':      'var(--viz-tool-mcp)',
  'other':    'var(--viz-tool-other)',
}

/** Per-tool bar colors so Read / Write / Edit / … stay distinct on project cards */
const TOOL_BAR_OVERRIDES: Record<string, string> = {
  Read:         'var(--viz-tool-read)',
  Write:        'var(--viz-tool-write)',
  Edit:         'var(--viz-tool-edit)',
  Grep:         'var(--viz-tool-grep)',
  Glob:         'var(--viz-tool-glob)',
  NotebookEdit: 'var(--viz-tool-edit)',
}

export function categorizeTool(name: string, harness: Harness = 'claude'): ToolCategory {
  if (isMcpTool(name, harness)) return 'mcp'
  return TOOL_CATEGORIES_BY_HARNESS[harness][name] ?? 'other'
}

export function toolBarColor(toolName: string, harness: Harness = 'claude'): string {
  return TOOL_BAR_OVERRIDES[toolName] ?? CATEGORY_COLORS[categorizeTool(toolName, harness)]
}

/**
 * Alpha that works for both hex and `var(--…)` (unlike string concatenation).
 * @param opacityPercent 0–100 portion of the base color
 */
export function categoryColorMix(base: string, opacityPercent: number): string {
  return `color-mix(in srgb, ${base} ${opacityPercent}%, transparent)`
}

export const CATEGORY_LABELS: Record<ToolCategory, string> = {
  'file-io':  'File I/O',
  'shell':    'Shell',
  'agent':    'Agents',
  'web':      'Web',
  'planning': 'Planning',
  'todo':     'Todo',
  'skill':    'Skills',
  'mcp':      'MCP',
  'other':    'Other',
}

/** MCP tools are `mcp__<server>__<tool>`; Codex also names them `<server>__<tool>` */
export function isMcpTool(name: string, harness: Harness = 'claude'): boolean {
  return name.startsWith('mcp__') || (harness === 'codex' && name.includes('__'))
}

export function parseMcpTool(name: string, harness: Harness = 'claude'): { server: string; tool: string } | null {
  if (!isMcpTool(name, harness)) return null
  const parts = name.split('__')
  if (parts[0] === 'mcp') parts.shift()
  if (parts.length < 2 || !parts[0]) return null
  return {
    server: parts[0],
    tool:   parts.slice(1).join('__'),
  }
}

export function toolDisplayName(name: string): string {
  const mcp = parseMcpTool(name)
  if (mcp) return `${mcp.server} · ${mcp.tool}`
  return name
}

export const TOOL_ICONS: Record<ToolCategory, string> = {
  'file-io':  '📄',
  'shell':    '⚡',
  'agent':    '🤖',
  'web':      '🌐',
  'planning': '📋',
  'todo':     '✅',
  'skill':    '🎯',
  'mcp':      '🔌',
  'other':    '🔧',
}
