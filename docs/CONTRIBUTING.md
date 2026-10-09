# Contributing to Claude Code Lens

Thanks for helping improve `cc-lens`. This project reads private local Claude Code, Codex CLI and Copilot CLI data, so contributions should preserve the local-first, no-telemetry model.

## Development Setup

Requirements:

- Node.js 24 or newer
- npm
- Harness data in `~/.claude/`, `~/.codex/` or `~/.copilot/` for realistic local testing

Install and run:

```bash
npm install
npm run dev
```

Open the local URL shown by Next.js, usually <http://localhost:3000>.

Build and lint before opening a PR:

```bash
npm run lint
npx tsc --noEmit
npx vitest run
npm run build
```

## Project Structure

- `app/`: Next.js app routes and API routes
- `components/`: shared UI and dashboard components
- `lib/harness/`: one adapter per harness (`claude/`, `codex/`, `copilot/`) implementing `HarnessAdapter` (`lib/harness/types.ts`)
- `lib/harness/session-store.ts`: lists and parses every harness's sessions, cached by file path and mtime
- `lib/harness/claude/reader.ts`: Claude session parsing plus the Claude-only readers (history, todos, plans, memory, settings, workspace)
- `lib/replay-parser.ts`: Claude session JSONL replay parsing
- `lib/session-ledger.ts`: per-turn token ledger, metrics and time windows
- `lib/pricing.ts`: token and cost estimation
- `types/claude.ts`, `types/harness.ts`: shared app types
- `bin/cli.js`: published `cc-lens` CLI entrypoint

## Contribution Guidelines

- Keep the app local-first. Do not add hosted services, telemetry, analytics, or external upload paths.
- Treat `~/.claude/`, `~/.codex/` and `~/.copilot/` content as private user data.
- Bind local servers to loopback by default unless the user explicitly opts into another host.
- Prefer small PRs with a clear user-facing outcome.
- Add focused tests when changing parsing, pricing, import/export, or filesystem behavior.
- Preserve compatibility with missing, partial, or malformed harness files.
- Avoid broad refactors unless they directly support the change.

## Testing Changes Manually

For parser or filesystem changes, test at least these cases:

- default `~/.claude/`, `~/.codex/` and `~/.copilot/`
- custom `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `COPILOT_HOME`
- each harness directory missing in turn
- empty projects directory
- malformed JSONL line
- sessions with tool calls, compaction, and cache tokens

Example custom profile run:

```bash
CLAUDE_CONFIG_DIR=~/.claude-work npm run dev
```

## Pull Request Checklist

- [ ] The change keeps user data local.
- [ ] `npm run lint` passes.
- [ ] `npx tsc --noEmit` and `npx vitest run` pass.
- [ ] `npm run build` passes.
- [ ] User-facing behavior is documented when relevant.
- [ ] Screenshots or short recordings are included for visible UI changes.
- [ ] Parser/filesystem changes handle missing or malformed local files.

## Reporting Security Issues

Please do not open a public issue for vulnerabilities involving private data exposure. See [SECURITY.md](SECURITY.md) for reporting guidance.
