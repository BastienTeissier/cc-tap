# Known Limitations

`cc-lens` reads local Claude Code, Codex CLI and Copilot CLI files directly. That makes it private and useful, but it also means the app depends on file formats that can change.

## Data Accuracy

- Cost values are estimates, not billing records, except Copilot's: those are the AI units Copilot billed, at an assumed $0.01 each.
- Pricing comes from `lib/pricing.ts` and may lag provider pricing changes.
- Some older sessions may not include model, usage, branch, or compaction metadata.
- Session duration is inferred from timestamps in local files.
- Project language, line, and file-change counts depend on what Claude Code recorded.

## Import and Export

- Export files can contain sensitive local workflow data. Treat `.cclens.json` files as private.
- Import is preview-only and does not write merged sessions back into `~/.claude/`.
- Redacted export is not implemented yet.

## Compatibility

- The primary source is `~/.claude/projects/<slug>/*.jsonl`.
- `~/.claude/usage-data/session-meta/` is used as a fallback where available.
- If Claude Code changes its local file layout, some panels may show partial data until `cc-lens` is updated.
- Windows support is intended, but path handling needs more real-world testing.

## Codex CLI and Copilot CLI

- Live Capture and the Raw API tab are Claude-only.
- History, todos, plans, memory, settings and workspace pages read Claude Code files only, and so does the overview's live sessions panel.
- The Agents tab is Claude-only. Copilot sub-agent calls are counted in tokens and cost, without a timeline.
- Codex rollouts written before Sept 2025 have no session metadata and are skipped.
- Codex compaction markers have not been observed yet, so Codex sessions may never show a compaction.
- Copilot tokens come from `session-store.db`. Without it, a session lists with no tokens, and its cost from the last usage checkpoint applies to the whole session, not to date ranges.
- Copilot's AI-unit price ($0.01) comes from GitHub's billing docs, not from the local files.

## Runtime

- The packaged CLI binds to `127.0.0.1` by default.
- Setting `HOSTNAME=0.0.0.0` makes the dashboard reachable from your local network.
- Large histories can take longer to scan on cold start, although parsed sessions are cached by file modification time.

## Not Yet Built

- Demo mode.
- Parser test suite.
- Replay search and replay export.
- Local pricing overrides.
- Team aggregate mode.
