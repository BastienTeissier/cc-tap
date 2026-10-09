import { describe, it, expect } from 'vitest'
import { categorizeTool, isMcpTool, parseMcpTool } from '@/lib/tool-categories'

describe('categorizeTool', () => {
  it('maps Codex tools', () => {
    expect(categorizeTool('exec_command', 'codex')).toBe('shell')
    expect(categorizeTool('apply_patch', 'codex')).toBe('file-io')
    expect(categorizeTool('update_plan', 'codex')).toBe('planning')
    expect(categorizeTool('mcp__gh__x', 'codex')).toBe('mcp')
    expect(categorizeTool('gh__x', 'codex')).toBe('mcp')
  })

  it('maps Copilot tools', () => {
    expect(categorizeTool('view', 'copilot')).toBe('file-io')
    expect(categorizeTool('rg', 'copilot')).toBe('file-io')
    expect(categorizeTool('bash', 'copilot')).toBe('shell')
    expect(categorizeTool('task', 'copilot')).toBe('agent')
    expect(categorizeTool('github-mcp-server-get_file', 'copilot')).toBe('mcp')
    expect(categorizeTool('github-mcp-server-get_file')).toBe('other')
  })

  it('keeps Claude names to Claude', () => {
    expect(categorizeTool('Bash')).toBe('shell')
    expect(categorizeTool('Bash', 'codex')).toBe('other')
    expect(categorizeTool('gh__x')).toBe('other')
  })

  it('files unknown tools under other', () => {
    expect(categorizeTool('nope')).toBe('other')
    expect(categorizeTool('nope', 'codex')).toBe('other')
    expect(categorizeTool('nope', 'copilot')).toBe('other')
  })
})

describe('parseMcpTool', () => {
  it('splits both MCP name forms', () => {
    expect(parseMcpTool('mcp__github__search')).toEqual({ server: 'github', tool: 'search' })
    expect(parseMcpTool('django_inspector__analyze', 'codex')).toEqual({ server: 'django_inspector', tool: 'analyze' })
    expect(parseMcpTool('github-mcp-server-get_file', 'copilot')).toEqual({ server: 'github-mcp-server', tool: 'get_file' })
    expect(parseMcpTool('mcp__x')).toBeNull()
    expect(isMcpTool('django_inspector__analyze')).toBe(false)
  })
})
