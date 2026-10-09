# Compatibility

This project tracks the local data files of Claude Code, Codex CLI and Copilot CLI. Compatibility is best-effort because those files are not a stable public API.

## Supported Runtime

- Node.js 24 or newer (required by the built-in `node:sqlite` module).
- npm.
- macOS and Linux are the most-tested environments.
- Windows is supported in the CLI and docs, but needs more broad testing.

## Harness Directories

Each harness is read from its own directory. A harness whose directory is missing is skipped, and the CLI banner shows it as `not found`.

| Harness | Directory | Override |
| --- | --- | --- |
| Claude Code | `~/.claude` | `CLAUDE_CONFIG_DIR` |
| Codex CLI | `~/.codex` | `CODEX_HOME` |
| Copilot CLI | `~/.copilot` | `COPILOT_HOME` |

All three are read-only: `cc-lens` never writes to a harness directory or database.

## Supported Claude Code Data

`cc-lens` currently reads:

- `~/.claude/projects/<slug>/*.jsonl`
- `~/.claude/stats-cache.json`
- `~/.claude/usage-data/session-meta/`
- `~/.claude/history.jsonl`
- `~/.claude/todos/`
- `~/.claude/plans/`
- `~/.claude/projects/*/memory/`
- `~/.claude/settings.json`

You can point `cc-lens` at another Claude Code config directory:

```bash
CLAUDE_CONFIG_DIR=~/.claude-work npx cc-lens
```

## Supported Codex CLI Data

- `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
- `~/.codex/archived_sessions/rollout-*.jsonl`

One `{timestamp, type, payload}` record per line. `cc-lens` uses:

- `session_meta`: id, cwd, CLI version, git branch. Rollouts written without it (before Sept 2025) are skipped.
- `turn_context`: the model for the responses that follow, and `model_context_window` for the Context tab.
- `response_item`: user messages, tool calls (`function_call`, `custom_tool_call`, `web_search_call`), tool outputs and reasoning.
- `event_msg` of type `token_count`: `info.last_token_usage` is one response's usage; repeats of the same running total are skipped. `rate_limits.primary` at 100% counts as a limit hit.

## Supported Copilot CLI Data

- `~/.copilot/session-state/<id>/events.jsonl`: one event per line. `cc-lens` uses `session.start`, `session.model_change`, `user.message`, `assistant.turn_start`, `assistant.message`, `assistant.turn_end`, `tool.execution_start`, `tool.execution_complete` and `session.usage_checkpoint`.
- `~/.copilot/session-state/<id>/workspace.yaml`: cwd and branch.
- `~/.copilot/session-store.db`, table `assistant_usage_events` (schema v8), opened read-only. One row per billed call, with its tokens, model, sub-agent and AI units. `turn_index` is always 0, so the nth main-agent row is joined to the nth `assistant.turn_start`.

Without the database, sessions still list from their events, without tokens; their cost comes from the last usage checkpoint.

## Token Fields

Every harness is mapped to Claude's token fields:

| cc-lens field | Claude Code | Codex CLI | Copilot CLI |
| --- | --- | --- | --- |
| input | `input_tokens` | `input_tokens − cached_input_tokens` | `input_tokens − cache_read_tokens − cache_write_tokens` |
| output | `output_tokens` | `output_tokens` (includes reasoning) | `output_tokens` (includes reasoning) |
| cache read | `cache_read_input_tokens` | `cached_input_tokens` | `cache_read_tokens` |
| cache write | `cache_creation_input_tokens` | `cache_write_input_tokens` | `cache_write_tokens` |

## Costs

- **Claude Code**: the cost Claude Code reports when present, else the pricing table.
- **Codex CLI**: the pricing table (OpenAI per-MTok rates). An unknown OpenAI id is charged at `gpt-5.5` and marked `est.`.
- **Copilot CLI**: the AI units Copilot billed, at $0.01 each (one GitHub AI credit). Set `"copilot.aiu_usd"` in `~/.cc-lens/pricing.json` to change the rate, or to `null` to price Copilot from the token table instead. Premium requests are shown on the Costs page.

## Compatibility Policy

- Missing files should produce empty states, not crashes.
- Malformed JSONL lines should be skipped.
- New Claude Code fields should be ignored until `cc-lens` uses them.
- Old sessions should still appear when enough metadata exists to identify the session.

## Reporting Compatibility Issues

Open a bug report and include:

- `cc-lens` version
- operating system
- Node.js version
- which harness (Claude Code, Codex CLI, Copilot CLI) and its version
- whether you use `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `COPILOT_HOME`
- which page is wrong or empty
- a redacted example of the affected local file shape, if safe to share

Do not paste private prompts, source code, command output, secrets, or full session transcripts into public issues.
