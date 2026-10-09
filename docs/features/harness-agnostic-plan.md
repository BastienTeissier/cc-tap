# Implementation Plan: Harness-agnostic cc-tap (Claude Code + Codex CLI + Copilot CLI)

## 1. Feature Description

**Objective**: cc-tap reads sessions from Claude Code, Codex CLI and Copilot CLI and shows them in one merged dashboard. Each session carries a `harness` tag; a harness filter (`?h=claude,codex`) applies on every page. Costs are USD-equivalent across harnesses. Claude Code stays the reference; nothing visible changes for Claude-only users.

**Key Capabilities**:
- **CAN** auto-detect `~/.claude`, `~/.codex`, `~/.copilot` (env overrides `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, new `COPILOT_HOME`); CLI banner lists detected harnesses.
- **CAN** list/replay Codex sessions from `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` and `archived_sessions/` (same parser).
- **CAN** list/replay Copilot sessions from `~/.copilot/session-state/<id>/events.jsonl` + `workspace.yaml`; per-call token usage from `session-store.db` table `assistant_usage_events` (read-only `node:sqlite`, like `lib/inspector-db.ts`).
- **CAN** show core analytics for all harnesses: overview, sessions list, session replay, projects, costs, tools, activity, insights, wrapped, digest, team export/import.
- **CAN** filter every page by harness via URL param `?h=` (comma list; absent = all). API routes read it server-side (same pattern as `?from&to` in `lib/time-window.ts`).
- **CAN** break down cost/model charts and project cards by harness.
- **CAN** price OpenAI models (Codex) from a built-in table; Copilot cost from `token_details_json` nano-AIU prices + premium requests column. Both overridable via `~/.cc-lens/pricing.json`.
- **CAN** categorize tools per harness (per-harness map); raw tool names kept, rendered with harness badge.
- **CAN** export/import `.cclens.json` and `.cclens-team.json` with `harness` field; files without it read as `claude`.
- **CANNOT** live-capture Codex/Copilot traffic (proxy, Raw API tab stay Claude-only).
- **CANNOT** show history/todos/plans/memory/settings pages for Codex/Copilot (Claude-only; other harnesses contribute nothing → existing empty states).
- **CANNOT** show Agents/Context/Search tabs for a session unless its adapter yields the data (hidden otherwise).
- **CANNOT** rename package/dirs: `cc-tap`, `~/.cc-lens/`, `CC_LENS_*` stay.
- **CANNOT** write to any harness dir or DB (read-only everywhere).

**Business Rules**:
- `harness ∈ {'claude','codex','copilot'}`; set by the adapter that parsed the file, never inferred later.
- Project identity = `cwd` (`project_path`); slug = `pathToSlug(cwd)` (`lib/decode.ts`) → equals Claude's dir name, so one card per repo across harnesses with per-harness breakdown.
- Harness filter: `?h=` absent or empty → all harnesses; unknown values ignored; all values unknown → empty result (not "all").
- Cost: every harness → USD. Codex: OpenAI per-MTok table (input / cached input / output). Copilot: AIU from `token_details_json.costPerBatch` × tokens; USD = AIU × rate from GitHub docs (**rate to verify before phase 6**; if unpublished, Copilot cost column shows premium requests and `cost_usd = 0`, flagged "unpriced" like `UnpricedModel`).
- Pricing fallback is vendor-aware: unknown `claude-*` → `claude-opus-4-8`; unknown `gpt-*`/`o*` → OpenAI fallback (cheapest-known-frontier, see unresolved Q); any other unknown → `UnpricedModel` warning (never silently priced as Opus).
- Model labels: `modelLabel` returns raw id for non-Claude models; harness badge supplies vendor context.
- Token field names keep Claude semantics everywhere (`cacheCreationInputTokens`, `cacheReadInputTokens`); adapters map (Codex `cached_input_tokens` → cacheRead, `cache_write_input_tokens` → cacheCreation; Copilot `cache_read_tokens`/`cache_write_tokens`). Documented in `docs/COMPATIBILITY.md`.
- Copilot per-call usage: `turn_index` is always 0 in schema v8 (verified), so rows are joined to turns by chronological order (`ORDER BY created_at`, nth main-agent row ↔ nth `assistant.turn_start`); `reasoning_tokens` assumed ⊂ `output_tokens` (same vendor semantics as Codex; verify once a session with known totals is available). Utility model calls (`gpt-4o-mini`, `*-utility`) counted in `model_usage` under their own model id, not folded into main model.
- Codex `turn_context.model` is the model for all `response_item`s until next `turn_context`; `event_msg.token_count.info.last_token_usage` = usage of the completed call (`info` null → skip). `model_context_window` feeds the Context tab limit when present.
- Codex compaction: best-effort (`event_msg` payload types indicating context compaction, e.g. `context_compacted` — **verify name**); `has_compaction=false` if marker absent. Codex has no sub-agents → `agent_count=0`.
- Copilot sub-agents: `assistant_usage_events.agent_id` ≠ main → folded into `agent_model_usage` (same shape as Claude). `task` tool = `uses_task_agent`.
- Insights/digest run over all harnesses. Premium-model detection uses per-harness tier map (`claude-opus*`/`claude-fable*`, `gpt-5.5`, `gpt-5.6-terra` = premium; economy suggestion per harness). No new insight types.
- Claude `stats-cache.json` stays Claude-only input to activity/stats; other harnesses contribute via sessions only.
- `getClaudeStorageBytes` → per-harness dir sizes, summed in Settings/Workspace.
- Mtime cache keyed by absolute file path; Copilot session mtime = max(`events.jsonl`, `session-store.db`) (DB rows may arrive after events).
- Delivery in 7 PRs; app works after each (see §5).

**Visual Design**:
- No Figma. Harness badge: same pattern as `components/sessions/session-badges.tsx` (span, colored bg). Colors: claude amber, codex emerald, copilot violet.
- Harness filter: pill toggle group in `components/layout/top-bar.tsx` (left of refresh), writes `?h=`; hidden when only one harness detected.
- Cost charts: stacked by harness (`components/costs/cost-over-time-chart.tsx`); model donut groups by harness ring label.
- Project card: harness chips with session counts.
- CLI banner: `Harnesses: claude (~/.claude), codex (~/.codex), copilot (not found)`.

---
## 2. Data Model

No database. Entities = TypeScript types + on-disk JSON contracts. ⚪ reuse, 🟢 new.

### Creation of New Entities

- 🟢 `Harness` (`types/harness.ts`): `type Harness = 'claude' | 'codex' | 'copilot'`; `HARNESSES` const tuple; `isHarness(x)` guard; `HARNESS_LABELS` (`Claude Code`, `Codex CLI`, `Copilot CLI`).
- 🟢 `HarnessAdapter` (`lib/harness/types.ts`):
  ```ts
  interface HarnessAdapter {
    harness: Harness
    /** resolved root dir (env override or default); null when absent on disk */
    configDir(): string | null
    /** every session file: path + stable session id + project cwd when known from the path/metadata */
    listSessionFiles(): Promise<SessionFileEntry[]>
    parseSession(entry: SessionFileEntry): Promise<SessionRecord | null>
    parseReplay(entry: SessionFileEntry): Promise<ReplayData>
    /** raw tool name → ToolCategory for this harness */
    categorizeTool(name: string): ToolCategory
    /** bytes under configDir, for Settings/Workspace */
    storageBytes(): Promise<number>
  }
  interface SessionFileEntry { harness: Harness; session_id: string; path: string; mtimeMs: number; cwd?: string; slug?: string }
  ```
  Registry `lib/harness/registry.ts`: `adapters(): HarnessAdapter[]` (only those with `configDir() !== null`), `adapterFor(h)`, `detectedHarnesses(): Harness[]`.
- 🟢 `HarnessFilter` (`lib/harness-filter.ts`): `harnessesFromSearch(search: string): Harness[] | null` (null = all; `?h=` parsed, unknown dropped, all-unknown → `[]`), `harnessesToSearch(search, hs)`, `matchesHarness(s: {harness}, f)`. Mirrors ⚪ `lib/time-window.ts` `windowFromSearch`/`windowToSearch`.
- 🟢 `CopilotUsageRow` (`lib/harness/copilot/usage-db.ts`): projection of `assistant_usage_events` `{session_id, turn_index, agent_id, parent_tool_call_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_nano_aiu, request_multiplier, created_at, token_details_json}`.
- 🟢 `CopilotCost` on `SessionMeta` (optional, Copilot only): `copilot?: { aiu: number; premium_requests: number }`. AIU = `total_nano_aiu / 1e9` summed over rows; premium = last `session.usage_checkpoint.totalPremiumRequests` in events.
- 🟢 Pricing vendor split (`lib/pricing.ts`): `DEFAULT_PRICING_PER_MTOK` gains `gpt-*` entries (same `ModelPricing` shape; `cacheWrite` = input since OpenAI has no write surcharge, `cacheRead` = cached-input price). 🟢 `vendorOf(model): 'anthropic' | 'openai' | 'unknown'` (prefix `claude-` / `gpt-`,`o1`,`o3`,`o4`,`codex`). 🟢 `FALLBACK_BY_VENDOR = { anthropic: 'claude-opus-4-8', openai: <TBD, see Q> }`.
- 🟢 Context limits: `DEFAULT_CONTEXT_LIMITS` gains OpenAI entries (`gpt-5.5`, `gpt-5.3-codex` …, values to verify); Codex adapter overrides per-session from `token_count.info.model_context_window` when present (`ReplayData.context_window?`).
- 🟢 Model tiers (`lib/model-tiers.ts`): `PREMIUM_MODELS` prefixes per vendor and `ECONOMY_MODEL_BY_VENDOR` used by `lib/insights.ts` instead of the single `ECONOMY_MODEL`.

### Modification of Existing Entities

- ⚪ `SessionMeta` (`types/claude.ts`): add `harness: Harness` (required; import path defaults old payloads to `'claude'`). Add `copilot?: CopilotCost`. No other field changes; Claude-only fields stay as-is (adapters emit zeros/empties: `git_commits`, `lines_added`, `user_interruptions`, `tool_error_categories` best-effort).
- ⚪ `ParsedSession` (`lib/claude-reader.ts` → moves to `lib/harness/types.ts`): `cc_version` kept name, documented as "harness CLI version" (Codex `session_meta.cli_version`, Copilot `session.start.copilotVersion`). `slug_name` = `pathToSlug(cwd)` for non-Claude.
- ⚪ `SessionRecord`: unchanged shape. `rate_limit_hits` filled by Codex from `event_msg.token_count.rate_limits.primary.used_percent === 100` (best-effort; else `[]`). `cost_state` Claude-only (`undefined` elsewhere).
- ⚪ `SessionWithFacet`: inherits `harness`; `version` (cc_version) semantics widened.
- ⚪ `ReplayData`: add `harness: Harness`, `context_window?: number`. `ReplayTurn` unchanged: `uuid` = Codex `response_item` id / `ordinal`, Copilot event `id`; `parentUuid` = Copilot `parentId`, Codex previous turn id; `turn_duration_ms` from Codex `task_started/complete` delta, Copilot `assistant.turn_start/end`. `ToolCall.input` = parsed `arguments` JSON. `thinking_text` = Codex `reasoning` summary / Copilot `reasoning` event.
- ⚪ `CompactionEvent`: `trigger: 'auto' | 'manual'` kept; Codex marker → `'auto'`, `pre_tokens` = last `total_token_usage.total_tokens` before marker. Copilot: none (no marker found).
- ⚪ `ModelUsage`: unchanged. Mapping documented in `docs/COMPATIBILITY.md`: Codex `cached_input_tokens`→`cacheReadInputTokens`, `cache_write_input_tokens`→`cacheCreationInputTokens`, `reasoning_output_tokens` ⊂ `output_tokens` (verified: not added twice). Copilot `cache_read_tokens`/`cache_write_tokens`/`reasoning_tokens` same rule.
- ⚪ `ProjectSummary`: add `by_harness: Partial<Record<Harness, { sessions: number; estimated_cost: number }>>`; `branches` from Claude JSONL walk + Codex `turn_context`/`session_meta.git` + Copilot `workspace.yaml.branch`.
- ⚪ `ModelCostBreakdown`: add `harness: Harness` (one row per `(harness, model)`; same model id under two harnesses = two rows). `DailyCost`: add `by_harness: Partial<Record<Harness, number>>`. `ProjectCost`: unchanged.
- ⚪ `CostAnalytics`: add `copilot_premium_requests?: number`, `harnesses: Harness[]` (present in range).
- ⚪ `ToolsAnalytics` rows: add `harness` per tool entry (aggregate key `(harness, name)`).
- ⚪ `TeamExportPayload`: `version: '1.1.0'`; `cc_versions` kept (name) + 🟢 `harnesses: Harness[]`; sessions carry `harness`. Reader (`lib/team-reader.ts`) accepts `1.0.0` → sessions get `harness: 'claude'`.
- ⚪ `ExportPayload` (`app/api/export/route.ts`): `version: '1.1.0'`; sessions carry `harness`. `app/api/import/route.ts`: `harness ??= 'claude'` on each session.
- ⚪ `TeamMemberSummary`: add `by_harness: Partial<Record<Harness, number>>` (session counts). `TeamAnalytics.version_skew`: entries become `{ harness, version, members }`.
- ⚪ `lib/redact.ts` whitelist: add `harness`, `copilot`.
- ⚪ `StatsCache`, `LiveSession`, `UsageWindow`, `HistoryEntry`, inspector types: unchanged (Claude-only).
- ⚪ `UnpricedModel`: unchanged; now also produced for unknown-vendor models (`priced_as: ''` → UI shows "unpriced" instead of "priced as X").

### Relationships

- `HarnessAdapter` 1→N `SessionFileEntry` 1→1 `SessionRecord` (cached by `entry.path` + `mtimeMs` in ⚪ `sessionCache`, moved to `lib/harness/session-store.ts`).
- `SessionRecord.session.harness` === producing adapter's `harness` (invariant, asserted in tests).
- `ProjectSummary` groups `SessionMeta` by `project_path`; `slug = pathToSlug(project_path)`; N harnesses per project.
- `ModelCostBreakdown` keyed `(harness, model)`; `ModelUsage` keyed `model` only inside a session (session already has one harness).
- Copilot: `SessionFileEntry.session_id` = folder name = `assistant_usage_events.session_id` = `workspace.yaml.id`; usage rows joined to events by chronological order (`turn_index` is always 0; nth main-agent row ↔ nth `assistant.turn_start`).
- Codex: one file = one session; `session_meta.payload.id` = session id; `cwd` from `session_meta.payload.cwd` (fallback latest `turn_context.cwd`).
- Pricing: `model` → `vendorOf` → table entry or vendor fallback or `UnpricedModel`.
- Filter: `?h=` → `Harness[] | null` → applied after `getSessions()` and before range slicing in every API route (same place `windowFromSearch` is applied).

---
## 3. Architecture

Grouped by layer. ⚪ existing (moved/edited), 🟢 new. Phase (P1–P7) matches §5.

### Files to Modify:

#### A. `lib/harness/types.ts` 🟢 (P1)
**Purpose**: adapter contract.
**Changes**: `HarnessAdapter`, `SessionFileEntry` (§2). Move ⚪ `ParsedSession`, `SessionRecord`, `RateLimitHit` here from `lib/claude-reader.ts` (re-export from old path to keep imports working).
**Why**: one contract every reader implements; routes stop importing Claude-specific module.

#### B. `lib/harness/registry.ts` 🟢 (P1)
**Purpose**: harness discovery.
**Changes**: `adapters()` = `[claudeAdapter, codexAdapter, copilotAdapter].filter(a => a.configDir() !== null)` (P1 ships Claude only). `detectedHarnesses()`, `adapterFor(h)`. Dir resolution: `CLAUDE_CONFIG_DIR ?? ~/.claude`, `CODEX_HOME ?? ~/.codex`, `COPILOT_HOME ?? ~/.copilot`; `null` when `fs.existsSync` false.
**Why**: single place for env/dir rules; banner and Settings read the same list.

#### C. `lib/harness/session-store.ts` 🟢 (P1)
**Purpose**: harness-agnostic session cache + listing (today's `getAllSessionRecords` core).
**Changes**: move ⚪ `sessionCache`, `foldedCache` eviction, `mapPool(…,16)`, in-flight dedupe, sort-by-start_time from `lib/claude-reader.ts:417-505`. Loop over `adapters()`: `entries = flat(await a.listSessionFiles())`; cache key `entry.path`; parse via `a.parseSession(entry)`. Exports `getAllSessionRecords()`, `getAllParsedSessions()`, `getSessions()`, `findSessionEntry(sessionId): Promise<SessionFileEntry | null>` (replaces `findSessionJSONL` for routes).
**Why**: cache/concurrency logic is harness-neutral; adapters only parse.

#### D. `lib/harness/claude/adapter.ts` 🟢 + `lib/harness/claude/reader.ts` ⚪ (P1)
**Purpose**: Claude adapter = today's code.
**Changes**: `reader.ts` = `lib/claude-reader.ts` minus the listing core (C). Keeps `parseSessionFile`, `foldAgentUsage`, `listProjectSlugs`, `listProjectEntries`, `resolveProjectPath`, `readStatsCache`, `readLiveSessions`, `readPlans/Tasks/History/Skills/Plugins/ConfigDir/Settings/Memories`. `parseSessionFile` sets `harness: 'claude'`, `git_branches` (branch → line count; today's per-line `gitBranch` walk in `app/api/projects/route.ts:33-49` and `app/api/tools/route.ts:98-125` folded into the single streaming pass). `adapter.ts`: `listSessionFiles()` = slugs × JSONL files + `hasSessionDir`; `parseSession` = `parseSessionFile` + `foldAgentUsage`; `parseReplay` = ⚪ `lib/replay-parser.ts`; `categorizeTool` = ⚪ `lib/tool-categories.ts`; `storageBytes` = ⚪ `getClaudeStorageBytes`.
**Why**: zero behaviour change in P1; Claude-only readers (plans, memory…) stay exported from here for the Claude-only pages.

#### E. `lib/claude-reader.ts` ⚪ (P1)
**Purpose**: compatibility shim.
**Changes**: re-export everything from D + C (`getSessions`, `findSessionJSONL` → wraps `findSessionEntry` and returns `.path` when `harness==='claude'`). Delete in P7.
**Why**: keeps 30 import sites compiling in P1; routes migrate in P2.

#### F. `lib/harness-filter.ts` 🟢 (P2)
**Purpose**: `?h=` parsing/serialising (§2).
**Changes**: `harnessesFromSearch`, `harnessesToSearch`, `filterByHarness(sessions, f)`. Pattern ⚪ `lib/time-window.ts:33-51`.
**Why**: identical semantics on client and server.

#### G. `hooks/use-harness-filter.ts` 🟢 + `components/layout/harness-filter.tsx` 🟢 + `components/layout/top-bar.tsx` ⚪ (P2)
**Purpose**: UI filter.
**Changes**: hook reads `useSearchParams().get('h')` → `Harness[] | null`, `setHarnesses(hs)` → `router.replace(pathname + harnessesToSearch(search, hs))`; `apiQuery(base)` helper appends `h=` to an API URL. Pill group component (toggle per detected harness, from `/api/harnesses`). Top bar renders it left of refresh when `detected.length > 1`.
**Why**: every page keeps building its own SWR URL (pattern ⚪ `app/costs/page.tsx:28`); hook makes the append one line per page.

#### H. `app/api/harnesses/route.ts` 🟢 (P2)
**Purpose**: `{ detected: Harness[], dirs: Record<Harness, string | null> }`.
**Why**: filter pills + Settings page + CLI banner share one source.

#### I. API routes ⚪ (P2) — `app/api/{sessions,sessions/[id],costs,tools,projects,projects/[slug],projects/trends,activity,stats,insights,digest,wrapped,usage-windows,export,export/team}/route.ts`
**Purpose**: apply filter, emit harness dimensions.
**Changes**:
- all: `const hf = harnessesFromSearch(req.nextUrl.search)`; `sessions = filterByHarness(await getSessions(), hf)` before range filtering. Import from `@/lib/harness/session-store` instead of `@/lib/claude-reader`.
- `sessions`: `SessionWithFacet.harness` passthrough (`toSessionWithFacet`).
- `sessions/[id]`: unchanged apart from import.
- `costs`: `modelUsage` keyed `${harness}\u0000${model}` → `ModelCostBreakdown.harness`; `DailyCost.by_harness`; `copilot_premium_requests` = Σ `s.copilot?.premium_requests`; `harnesses` = distinct.
- `tools`: key `(harness,name)`; `category = adapterFor(harness).categorizeTool(name)`; version/branch block (`:94-125`) replaced by `s.cc_version`/`s.git_branches` from sessions (no JSONL walk). `versions` records gain `harness`.
- `projects`: branches from `s.git_branches` (no walk); `slug = pathToSlug(project_path)` for every harness (`pathToSlugMap` only used for Claude cwd override); `by_harness`.
- `projects/[slug]`: resolve slug → sessions by `pathToSlug(s.project_path) === slug` (works for all harnesses; Claude's `resolveProjectPath` kept as fallback for slugs with lossy path chars).
- `activity`/`stats`: `readStatsCache()` only when `hf` is null or includes `'claude'`; `storageBytes` = Σ `adapters().storageBytes()`.
- `export`: `version: '1.1.0'`. `export/team`: `version: '1.1.0'`, `harnesses`, `cc_versions` unchanged.
- `import`: `s.harness ??= 'claude'`.
- `usage-windows`: unchanged (rate_limit_hits from any adapter).
**Why**: filter semantics identical everywhere; charts need the dimension in the payload rather than client re-aggregation.

#### J. `app/api/sessions/[id]/{replay,agents,agents/[agentId],search,workflows/[runId]}/route.ts` ⚪ (P2)
**Purpose**: route per-session reads through adapters.
**Changes**: `const entry = await findSessionEntry(id)`; 404 when null. `replay`: `cachedReplay(entry, id)` (⚪ `lib/replay-cache.ts` takes `SessionFileEntry`, etag from `entry.mtimeMs`+size; parse via `adapterFor(entry.harness).parseReplay(entry)`). `agents`/`search`/`workflows`: `if (entry.harness !== 'claude') return 404 { error: 'not available for <harness>' }` (Claude-only sub-agent/scan code untouched); P5 Copilot agents best-effort via `agent_id` is in `agent_model_usage` only, not in these routes.
**Why**: replay is the one per-session view promised for all harnesses.

#### K. `lib/pricing.ts` ⚪ (P4, P6)
**Changes**: P4: OpenAI entries in `DEFAULT_PRICING_PER_MTOK` (`gpt-5.5`, `gpt-5.3-codex`, `gpt-5-codex`, `gpt-5`, `gpt-5-mini`, `gpt-4.1`, `gpt-4o-mini` … values from openai.com/pricing at implementation time, cached-input as `cacheRead`, `cacheWrite = input`). `vendorOf(model)`; `pricedAs` → prefix within same vendor else `FALLBACK_BY_VENDOR[vendor]`; unknown vendor → `UnpricedModel{priced_as:''}` and `costUSD` contribution 0. `hasKnownPricing` unchanged. P6: `copilotCostUSD(row)` = `total_nano_aiu / 1e9 * AIU_USD` (constant + override key `"copilot.aiu_usd"` in `pricing.json`; `null` → unpriced).
**Why**: stops pricing GPT at Opus rates; keeps the user override file as the single escape hatch.

#### L. `lib/context-limits.ts` ⚪ (P4)
**Changes**: OpenAI entries (`gpt-5.5`: 400k?, `gpt-5.3-codex`: 400k? — verify); `contextLimit(model, table, override?: number)` where override = `ReplayData.context_window`.
**Why**: Context tab for Codex sessions uses the window Codex itself reported.

#### M. `lib/model-label.ts` ⚪ (P3)
**Changes**: `parseModel` returns `null` for non-`claude-` ids; `modelLabel`/`modelShortId` return the raw id then. `components/costs/model-token-table.tsx`, `model-breakdown-donut.tsx`, `cost-over-time-chart.tsx`, `turn-cards.tsx` prefix the harness badge when `harness !== 'claude'`.
**Why**: avoid mangling `gpt-5.6-terra` through Claude regexes.

#### N. `lib/model-tiers.ts` 🟢 + `lib/insights.ts` ⚪ (P4)
**Changes**: `ECONOMY_MODEL_BY_VENDOR = { anthropic: 'claude-sonnet-5-5', openai: 'gpt-5-mini' }` (verify); `detectPremiumModelOnLightSessions` picks economy model by `vendorOf(model)`; threshold stays `$4/MTok input`.
**Why**: insight must not suggest Sonnet for a Codex session.

#### O. `lib/tool-categories.ts` ⚪ (P3, P5)
**Changes**: `TOOL_CATEGORIES` → `TOOL_CATEGORIES_BY_HARNESS: Record<Harness, Record<string, ToolCategory>>`. Codex: `exec_command`/`shell`→bash, `apply_patch`→edit, `read_file`/`view_image`→read, `update_plan`→planning, `web_search`→web, `mcp__*`/`<srv>__<tool>`→mcp. Copilot: `view`→read, `rg`/`glob`→search, `bash`→bash, `apply_patch`/`create`/`edit`→edit, `web_fetch`→web, `task`→agent, `skill`→skill, `github-mcp-server-*`→mcp. `categorizeTool(name, harness='claude')`; `isMcpTool(name, harness)`.
**Why**: per-harness map decided in §1.

#### P. `lib/harness/codex/{adapter,reader,replay}.ts` 🟢 (P3)
**Changes**: `listSessionFiles`: walk `sessions/YYYY/MM/DD/rollout-*.jsonl` + flat `archived_sessions/rollout-*.jsonl` (verified layout) (`session_id` = uuid suffix of filename; verified against `session_meta.payload.id` on parse). `reader.ts`: one `readJSONLLines` pass → `LedgerBuilder` (⚪ `lib/session-ledger.ts`): `turn_context` sets current model; `event_msg.token_count` with `info.last_token_usage` → `addTurn({ts, model, input: input_tokens - cached_input_tokens, cacheRead: cached_input_tokens, cacheWrite: cache_write_input_tokens, output: output_tokens, toolCalls})` (verified on real data: `input_tokens` includes `cached_input_tokens`, `output_tokens` includes `reasoning_output_tokens`, `total_tokens = input + output`); `response_item.function_call|custom_tool_call` → `tool_counts`; `function_call_output` with error text → `tool_errors`; `message role=user` → `addUser`, `first_prompt`, `user_message_timestamps`; `rate_limits.primary.used_percent >= 100` → `rate_limit_hits`; compaction marker → `has_compaction`; `reasoning` items → `has_thinking`; `git_branches` from `turn_context`/`session_meta.git.branch` if present; `cc_version = cli_version`; `cwd` → `project_path`, `slug_name = pathToSlug(cwd)`. `replay.ts`: items → `ReplayTurn[]` (user message / assistant message+function_calls grouped per turn_id), `tool_results` from `function_call_output`, `usage` from the turn's `token_count`, `compactions`, `context_window`.
**Why**: same ledger → `sliceSession`, metrics, insights work unchanged.

#### Q. `lib/harness/copilot/{adapter,reader,replay,usage-db}.ts` 🟢 (P5, P6)
**Changes**: `listSessionFiles`: `session-state/*/events.jsonl` (+ `workspace.yaml` for `cwd`, `branch`; parse minimal YAML by line regex, no dep); `mtimeMs = max(events, session-store.db)`. `usage-db.ts`: lazy `DatabaseSync(path, {readOnly:true})` pattern ⚪ `lib/inspector-db.ts:14-22`; `usageFor(sessionId): CopilotUsageRow[]` prepared statement `WHERE session_id = ? ORDER BY created_at`; `null` DB → sessions parsed from events only (tokens 0, flagged unpriced). `reader.ts`: events pass → user/assistant counts, `tool_counts` from `tool.execution_start.toolName`, `tool_errors` from `tool.execution_complete.success=false`, `first_prompt`, timestamps, `turn_duration` from turn_start/end, `has_thinking` from `reasoning`, `uses_task_agent` from `task` tool, `cc_version = copilotVersion`; ledger turns from DB rows (`ts = created_at`, `isAgent = agent_id !== main`, agents → `agent_model_usage`), `copilot = { aiu, premium_requests }`. `replay.ts`: `user.message` / `assistant.message` (+`toolRequests`) / `tool.execution_complete` → `ReplayTurn`, `usage` joined by row order ↔ turn order.
**Why**: events give structure, DB gives tokens; both read-only.

#### R. `lib/redact.ts` ⚪ (P2) — add `harness`, `copilot` to whitelist. `lib/team-reader.ts` ⚪ (P2) — accept `1.0.0`→default harness, `by_harness` per member, `version_skew` harness-aware.

#### S. Components ⚪/🟢 (P2, P6)
- 🟢 `components/ui/harness-badge.tsx` (pattern ⚪ `components/sessions/session-badges.tsx`).
- ⚪ `components/sessions/session-table.tsx`: badge column; no client-side harness filter (URL param already applied server-side).
- ⚪ `app/sessions/[id]/page.tsx`: badge in header; hide `agents`/`context`/`raw` tabs when `session.harness !== 'claude'` except `context` when `replay.context_window` or Claude.
- ⚪ `components/costs/cost-over-time-chart.tsx`: stack by `by_harness` when >1 harness; `model-token-table.tsx`: harness column + premium-requests column when `copilot_premium_requests` > 0 (P6).
- ⚪ `components/overview/model-breakdown-donut.tsx`: label `${harness}: ${modelLabel}`.
- ⚪ `components/projects/*card*`: harness chips from `by_harness`.
- ⚪ `components/tools/*`: badge next to raw tool name.
- ⚪ `app/settings/page.tsx`: "Harnesses" block from `/api/harnesses`.
- ⚪ every page under `app/*/page.tsx` + `app/overview-client.tsx` + `components/overview/live-sessions-panel.tsx` (excluded: live is Claude-only): wrap SWR key with `apiQuery(...)` from G.

#### T. `bin/cli.js` ⚪ (P2) — banner: one line per harness from registry (`claude ~/.claude`, `codex ~/.codex`, `copilot not found`); env-origin note per dir. `digest` subcommand unchanged (uses `getAllParsedSessions`).

#### U. Docs ⚪ (P7) — `README.md`, `docs/COMPATIBILITY.md` (per-harness file list, event types, field mapping table), `docs/LIMITATIONS.md` (no live capture/local pages for Codex/Copilot, AIU rate caveat, Copilot DB optional), `docs/CHANGELOG.md`, `docs/CONTRIBUTING.md` (project structure: `lib/harness/*`), `docs/TEAM.md` (export 1.1.0).

#### V. Tests — see §4. Fixtures under `lib/__tests__/fixtures/{codex,copilot}/` (synthetic).

---
## 4. Test Plan

vitest, `include: ['lib/**/*.test.ts']` → route tests live in `lib/__tests__/api-*.test.ts` and call the exported `GET`/`POST` handlers directly (no config change). Fixture pattern ⚪ `lib/__tests__/claude-reader.test.ts:79-110` (tmp dir, env var, dynamic import after env setup). New fixtures: `lib/__tests__/fixtures/{codex,copilot}/` synthetic, modeled on the real files seen in exploration. Tests only for added behaviour; existing suites must stay green at every phase.

### Unit Tests

**P1 — seam (`lib/__tests__/harness-registry.test.ts`, `session-store.test.ts`)**
- `registry_detects_only_existing_dirs`: tmp dirs for claude only → `detectedHarnesses()` = `['claude']`; `configDir('codex')` null.
- `registry_honors_env_overrides`: `CODEX_HOME`, `COPILOT_HOME`, `CLAUDE_CONFIG_DIR` set → `configDir()` returns them.
- `claude_sessions_carry_harness_claude`: every record from the Claude fixture has `session.harness === 'claude'`.
- `git_branches_counted_in_single_pass`: Claude fixture with lines `gitBranch: main ×2, feat ×1, HEAD ×1` → `git_branches = { main: 2, feat: 1 }`.
- `session_store_caches_by_path_and_mtime`: second call → parser spy not called; touching mtime → called once.
- `claude_reader_shim_reexports`: `import('@/lib/claude-reader')` exposes `getSessions`, `findSessionJSONL` (P1 only; deleted in P7).

**P2 — filter & dimensions (`harness-filter.test.ts`, `redact.test.ts` additions, `team.test.ts` additions)**
- `harnesses_from_search_absent_is_null`: `''` → `null`; `?h=` → `null`.
- `harnesses_from_search_drops_unknown`: `?h=claude,foo` → `['claude']`; `?h=foo` → `[]`.
- `harnesses_to_search_roundtrip`: keeps `from`/`to`, sets/deletes `h`.
- `filter_by_harness_null_keeps_all`, `filter_by_harness_empty_keeps_none`.
- `redact_keeps_harness_and_copilot`: both levels preserve the two fields.
- `team_export_v1_defaults_to_claude`: payload `version '1.0.0'` without `harness` → every session `harness === 'claude'`.
- `team_version_skew_keyed_by_harness`: members on claude 2.1 and codex 0.9 → two skew rows.

**P3 — Codex (`codex-reader.test.ts`, `codex-replay.test.ts`)**
- `lists_sessions_and_archived`: fixture `sessions/2026/10/01/rollout-…-A.jsonl` + `archived_sessions/rollout-…-B.jsonl` → 2 entries, both `harness 'codex'`.
- `session_id_from_session_meta`: `session_id === session_meta.payload.id`.
- `cwd_and_slug`: `project_path === session_meta.payload.cwd`, `slug_name === pathToSlug(cwd)`.
- `ledger_from_token_count`: 2 `token_count` lines with `last_token_usage` (input 1000/cached 400/write 100/output 50) → `input_tokens 1200` (uncached part), `cache_read_input_tokens 800`, `cache_creation_input_tokens 200`, `output_tokens 100`.
- `token_count_with_null_info_skipped`.
- `model_follows_turn_context`: `turn_context model gpt-5.5` then `gpt-5.3-codex` → `model_usage` has both keys with the right tokens.
- `tool_counts_from_function_calls`: `exec_command ×2`, `apply_patch ×1`, `mcp__github__search ×1` → `tool_counts`, `uses_mcp true`.
- `tool_error_from_output`: `function_call_output` with `"error"`/non-zero exit → `tool_errors 1`.
- `first_prompt_and_user_timestamps`: from `message role=user input_text`.
- `rate_limit_hit_at_100_percent`: `rate_limits.primary.used_percent 100` → one `rate_limit_hits` entry with `resets_at`.
- `cli_version_as_cc_version`.
- `replay_turns_grouped_by_turn`: user turn, assistant turn with `tool_calls[0].name === 'exec_command'`, `tool_results[0]` from `function_call_output`, `usage` attached.
- `replay_context_window_from_token_count`: `model_context_window 400000` → `context_window`.
- `malformed_line_is_skipped`: one bad JSON line → session still parsed.

**P4 — pricing (`pricing.test.ts` additions, `context-limits.test.ts`, `insights.test.ts`)**
- `vendor_of`: `claude-*`→anthropic, `gpt-5.5`/`gpt-5.3-codex`/`o3`→openai, `gpt-5.6-terra`→openai, `llama-x`→unknown.
- `priced_as_stays_within_vendor`: unknown `gpt-9` → openai fallback, not `claude-opus-4-8`.
- `unknown_vendor_is_unpriced`: `unpricedModels({ 'llama-x': … })` → `[{model:'llama-x', priced_as:''}]`; cost 0.
- `openai_cache_read_rate`: `estimateCostFromUsage('gpt-5.5', {cache_read 1M})` = table cached-input price; `cacheWrite` priced as input.
- `pricing_json_overrides_openai`.
- `context_limit_override_wins`: `contextLimit('gpt-5.5', table, 400_000)` = 400_000.
- `insight_economy_model_by_vendor`: Codex light session on `gpt-5.5` → suggestion names `gpt-5-mini`, not Sonnet.

**P5 — Copilot (`copilot-reader.test.ts`, `copilot-usage-db.test.ts`, `copilot-replay.test.ts`)**
- `lists_session_state_dirs`: fixture with 2 dirs (one without `workspace.yaml`) → 2 entries, `cwd` from yaml or `session.start.context.cwd`.
- `mtime_is_max_of_events_and_db`.
- `usage_db_missing_yields_null`: no `session-store.db` → sessions parsed, tokens 0, `unpriced`.
- `usage_rows_for_session`: tmp SQLite created with `DatabaseSync` in test (`assistant_usage_events` DDL from schema v8) → rows ordered by `created_at`.
- `ledger_from_usage_rows`: 2 main rows + 1 `agent_id` row → `model_usage` totals, `agent_model_usage` only the agent row, `agent_count 1`.
- `reasoning_not_double_counted`: `output_tokens` = row `output_tokens` (reasoning not added on top).
- `tool_counts_and_errors_from_events`: `tool.execution_start view ×2, bash ×1`; `tool.execution_complete success=false ×1`.
- `uses_task_agent_from_task_tool`.
- `copilot_cost_fields`: `copilot.aiu` = Σ `total_nano_aiu`/1e9; `premium_requests` = last checkpoint.
- `copilot_version_as_cc_version`.
- `replay_joins_usage_by_turn_order`: 2nd assistant turn gets the 2nd main-agent row's usage; `tool_calls` from `toolRequests`, `tool_results` from `execution_complete`.
- `workspace_yaml_minimal_parser`: `cwd`, `branch`, `repository` extracted; quoted values unquoted.

**P6 — Copilot cost (`pricing.test.ts`)**
- `copilot_cost_usd_from_aiu`: `AIU_USD` set → `costUSD = aiu × rate`.
- `copilot_cost_null_rate_is_unpriced`: override `"copilot.aiu_usd": null` → cost 0, flagged.

**Tool categories (`tool-categories.test.ts`, P3/P5)**
- `codex_categories`: `exec_command`→bash, `apply_patch`→edit, `mcp__gh__x`→mcp, `gh__x`→mcp.
- `copilot_categories`: `view`→read, `rg`→search, `task`→agent, `github-mcp-server-get_file`→mcp.
- `unknown_tool_is_other` for each harness.
- `model_label_raw_for_non_claude`: `modelLabel('gpt-5.6-terra') === 'gpt-5.6-terra'`.

### Integration Tests (route handlers, `lib/__tests__/api-*.test.ts`)

Each builds a tmp home with Claude + Codex (+ Copilot from P5) fixtures, sets the three env vars, dynamic-imports the route.

- `api_sessions_mixed_harnesses`: `GET /api/sessions` → sessions from both fixtures, each with `harness`; sorted by `start_time` desc.
- `api_sessions_filter_h`: `?h=codex` → only codex; `?h=foo` → `[]`; `?h=` → all.
- `api_sessions_filter_and_window`: `?h=codex&from&to` → slice applied after harness filter.
- `api_costs_rows_per_harness_model`: Claude `claude-sonnet-5-5` + Codex `gpt-5.5` → 2 `models` rows with `harness`; `daily[].by_harness` sums equal `daily[].cost`.
- `api_costs_premium_requests` (P6): Copilot fixture → `copilot_premium_requests` > 0.
- `api_tools_keyed_by_harness`: same raw name `bash` from claude and copilot → 2 rows with different `harness`, categories per harness map.
- `api_tools_no_jsonl_walk`: `versions` built from `cc_version` (spy: `readJSONLLines` not called).
- `api_projects_one_card_per_cwd`: Claude + Codex sessions on same cwd → one `ProjectSummary`, `by_harness` has both, `branches` union, `slug === pathToSlug(cwd)`.
- `api_projects_slug_detail_cross_harness`: `GET /api/projects/<slug>` → sessions from both harnesses.
- `api_activity_stats_cache_only_for_claude`: `?h=codex` → `readStatsCache` not called; `storageBytes` = Σ dirs.
- `api_replay_codex`: `GET /api/sessions/<codexId>/replay` → 200, `harness 'codex'`, turns; ETag changes when file grows.
- `api_replay_copilot` (P5): 200, usage on assistant turns.
- `api_agents_non_claude_404`: `GET /api/sessions/<codexId>/agents` → 404 with message.
- `api_export_version_and_harness`: `/api/export` → `version '1.1.0'`, sessions carry `harness`.
- `api_import_defaults_harness`: POST v1.0.0 payload → `sessions_to_add[].harness === 'claude'`.
- `api_export_team_harnesses`: POST → `harnesses` lists both, `version '1.1.0'`.
- `api_harnesses_endpoint`: `{ detected: ['claude','codex'], dirs }`.
- `api_insights_digest_wrapped_mixed`: each returns 200 with counts covering both harnesses (smoke, no per-field assertions).

### Manual checks (per phase, `docs/CONTRIBUTING.md` test cases section)
- P1: `npm run build && npm test`; open every page with real `~/.claude`; no diff vs `main` in Overview/Costs totals.
- P2: `?h=claude` on each page keeps totals; pills hidden with one harness.
- P3/P5: real `~/.codex` / `~/.copilot` → sessions listed, replay opens, no console errors; totals vs `codex`/`copilot` own usage display where available.
- P4/P6: Costs page shows no "priced as claude-opus" for GPT models.

---
## 5. To Do List

Seven phases = seven PRs. App builds, tests green, no regression after each. Test names refer to §4.

### Phase 1 — Claude behind the seam (no visible change)

- [ ] **Create harness types**
  - File: `types/harness.ts`
  - `Harness`, `HARNESSES`, `isHarness`, `HARNESS_LABELS`.
- [ ] **Create adapter contract**
  - File: `lib/harness/types.ts`
  - `HarnessAdapter`, `SessionFileEntry`; move `ParsedSession`, `SessionRecord`, `RateLimitHit` here.
- [ ] **Add `harness` + `git_branches` to session types**
  - File: `types/claude.ts`
  - `SessionMeta.harness: Harness`; `ParsedSession.git_branches: Record<string, number>`.
- [ ] **Create registry**
  - File: `lib/harness/registry.ts`
  - Dir resolution for 3 harnesses; `adapters()`, `adapterFor`, `detectedHarnesses`. Only Claude adapter registered this phase.
- [ ] **Move Claude parser**
  - File: `lib/harness/claude/reader.ts` (from `lib/claude-reader.ts`)
  - `parseSessionFile` sets `harness: 'claude'`; count `gitBranch` per line into `git_branches` (reuse existing line loop at `:176`).
- [ ] **Create Claude adapter**
  - File: `lib/harness/claude/adapter.ts`
  - `listSessionFiles` from `listProjectSlugs`/`listProjectEntries` (+`hasSessionDir`); `parseSession` = parse + `foldAgentUsage`; `parseReplay` → `parseSessionReplay`; `categorizeTool`, `storageBytes`.
- [ ] **Create session store**
  - File: `lib/harness/session-store.ts`
  - Move cache/eviction/`mapPool`/sort from `getAllSessionRecords`; iterate `adapters()`; `findSessionEntry`.
- [ ] **Shim old module**
  - File: `lib/claude-reader.ts`
  - Re-export from reader + store; `findSessionJSONL` = `findSessionEntry` path when claude.
- [ ] **Drop JSONL re-walks**
  - Files: `app/api/projects/route.ts`, `app/api/tools/route.ts`
  - Branches/versions from `s.git_branches` / `s.cc_version`; delete `readJSONLLines` loops.
- [ ] **Write tests**
  - File: `lib/__tests__/harness-registry.test.ts` — `registry_detects_only_existing_dirs`, `registry_honors_env_overrides`.
  - File: `lib/__tests__/session-store.test.ts` — `claude_sessions_carry_harness_claude`, `git_branches_counted_in_single_pass`, `session_store_caches_by_path_and_mtime`, `claude_reader_shim_reexports`.
  - File: `lib/__tests__/api-tools.test.ts` — `api_tools_no_jsonl_walk`.
- [ ] **Verify**
  - `npm test`, `npm run build`; Overview/Costs/Projects/Tools totals identical to `main` on real `~/.claude`.

### Phase 2 — Harness field, filter, dimensions, exports

- [ ] **Filter helpers**
  - File: `lib/harness-filter.ts`
  - `harnessesFromSearch`, `harnessesToSearch`, `filterByHarness`.
- [ ] **Harnesses endpoint**
  - File: `app/api/harnesses/route.ts`
- [ ] **Apply filter in routes**
  - Files: `app/api/{sessions,sessions/[id],costs,tools,projects,projects/[slug],projects/trends,activity,stats,insights,digest,wrapped,usage-windows,export,export/team}/route.ts`
  - Read `?h=`, `filterByHarness` after `getSessions()`; switch imports to `@/lib/harness/session-store`.
- [ ] **Harness dimensions in payloads**
  - File: `app/api/costs/route.ts` — rows keyed `(harness, model)`, `DailyCost.by_harness`, `harnesses`.
  - File: `app/api/tools/route.ts` — rows keyed `(harness, name)`, `adapterFor(h).categorizeTool`.
  - File: `app/api/projects/route.ts` — `slug = pathToSlug(project_path)`, `by_harness`.
  - File: `app/api/projects/[slug]/route.ts` — match by `pathToSlug`.
  - File: `app/api/activity/route.ts`, `app/api/stats/route.ts` — stats-cache only when claude in filter; Σ `storageBytes`.
  - File: `types/claude.ts` — `ProjectSummary.by_harness`, `ModelCostBreakdown.harness`, `DailyCost.by_harness`, `CostAnalytics.harnesses/copilot_premium_requests`, `ReplayData.harness/context_window`, `TeamExportPayload.harnesses`, `TeamMemberSummary.by_harness`, `TeamAnalytics.version_skew`.
- [ ] **Per-session routes via adapter**
  - File: `lib/replay-cache.ts` — accept `SessionFileEntry`; parse via `adapterFor(entry.harness).parseReplay`.
  - Files: `app/api/sessions/[id]/{replay,agents,agents/[agentId],search,workflows/[runId]}/route.ts` — `findSessionEntry`; non-claude → 404 on agents/search/workflows.
- [ ] **Exports / imports / team**
  - File: `app/api/export/route.ts` — `version '1.1.0'`.
  - File: `app/api/import/route.ts` — `harness ??= 'claude'`.
  - File: `app/api/export/team/route.ts` — `version '1.1.0'`, `harnesses`.
  - File: `lib/team-reader.ts` — default harness for `1.0.0`, `by_harness`, harness-aware skew.
  - File: `lib/redact.ts` — whitelist `harness`, `copilot`.
- [ ] **UI: hook, pills, badge**
  - File: `hooks/use-harness-filter.ts` — `useHarnessFilter()`, `apiQuery`.
  - File: `components/layout/harness-filter.tsx`; `components/layout/top-bar.tsx` — render when >1 detected.
  - File: `components/ui/harness-badge.tsx`.
  - Files: all `app/*/page.tsx`, `app/overview-client.tsx` — SWR keys through `apiQuery`.
  - File: `components/sessions/session-table.tsx` — badge column.
  - File: `app/sessions/[id]/page.tsx` — badge; hide agents/raw tabs for non-claude; context tab only if claude or `context_window`.
  - File: `components/costs/cost-over-time-chart.tsx` — stack by harness when >1.
  - File: `components/costs/model-token-table.tsx`, `components/overview/model-breakdown-donut.tsx` — harness label.
  - File: `components/projects/*` — harness chips.
  - File: `components/tools/*` — badge.
  - File: `app/settings/page.tsx` — Harnesses block.
- [ ] **CLI banner**
  - File: `bin/cli.js` — per-harness line from registry.
- [ ] **Write tests**
  - File: `lib/__tests__/harness-filter.test.ts` — `harnesses_from_search_absent_is_null`, `harnesses_from_search_drops_unknown`, `harnesses_to_search_roundtrip`, `filter_by_harness_null_keeps_all`, `filter_by_harness_empty_keeps_none`.
  - File: `lib/__tests__/team.test.ts` — `team_export_v1_defaults_to_claude`, `team_version_skew_keyed_by_harness`; `redact_keeps_harness_and_copilot`.
  - File: `lib/__tests__/api-sessions.test.ts` — `api_sessions_filter_h`, `api_sessions_filter_and_window`.
  - File: `lib/__tests__/api-export.test.ts` — `api_export_version_and_harness`, `api_import_defaults_harness`, `api_export_team_harnesses`, `api_harnesses_endpoint`.
  - File: `lib/__tests__/api-projects.test.ts` — `api_activity_stats_cache_only_for_claude` (in `api-stats.test.ts`).
- [ ] **Verify**
  - `?h=claude` keeps totals on every page; `?h=foo` → empty states; pills hidden with one harness; `.cclens.json` from `main` imports.

### Phase 3 — Codex adapter

- [ ] **Fixtures**
  - Dir: `lib/__tests__/fixtures/codex/` — `sessions/2026/10/01/rollout-…-A.jsonl` (session_meta, 2 turn_context models, user/assistant messages, function_call + output, custom_tool_call, mcp call, reasoning, 2 token_count incl. one `info: null`, rate_limits 100%), `archived_sessions/rollout-…-B.jsonl` (flat), one malformed line.
- [ ] **Codex reader**
  - File: `lib/harness/codex/reader.ts` — single `readJSONLLines` pass → `LedgerBuilder`, counts, flags, `rate_limit_hits`, `git_branches`, `cc_version`, `project_path`, `slug_name`.
- [ ] **Codex replay**
  - File: `lib/harness/codex/replay.ts` — `ReplayTurn[]`, `compactions`, `context_window`.
- [ ] **Codex adapter + registry**
  - File: `lib/harness/codex/adapter.ts` — walk `sessions/**` + `archived_sessions/**`; `categorizeTool` from map.
  - File: `lib/harness/registry.ts` — register.
- [ ] **Tool categories per harness**
  - File: `lib/tool-categories.ts` — `TOOL_CATEGORIES_BY_HARNESS`, `categorizeTool(name, harness)`, `isMcpTool(name, harness)`.
- [ ] **Model label passthrough**
  - File: `lib/model-label.ts` — raw id for non-claude.
- [ ] **Write tests**
  - File: `lib/__tests__/codex-reader.test.ts` — `lists_sessions_and_archived`, `session_id_from_session_meta`, `cwd_and_slug`, `ledger_from_token_count`, `token_count_with_null_info_skipped`, `model_follows_turn_context`, `tool_counts_from_function_calls`, `tool_error_from_output`, `first_prompt_and_user_timestamps`, `rate_limit_hit_at_100_percent`, `cli_version_as_cc_version`, `malformed_line_is_skipped`.
  - File: `lib/__tests__/codex-replay.test.ts` — `replay_turns_grouped_by_turn`, `replay_context_window_from_token_count`.
  - File: `lib/__tests__/tool-categories.test.ts` — `codex_categories`, `unknown_tool_is_other`; `lib/__tests__/model-label.test.ts` — `model_label_raw_for_non_claude`.
  - Files: `lib/__tests__/api-sessions.test.ts` — `api_sessions_mixed_harnesses`; `api-costs.test.ts` — `api_costs_rows_per_harness_model`; `api-tools.test.ts` — `api_tools_keyed_by_harness`; `api-projects.test.ts` — `api_projects_one_card_per_cwd`, `api_projects_slug_detail_cross_harness`; `api-replay.test.ts` — `api_replay_codex`, `api_agents_non_claude_404`; `api-insights.test.ts` — `api_insights_digest_wrapped_mixed`.
- [ ] **Verify**
  - Real `~/.codex`: sessions listed with badge, replay opens, project card merges with Claude on same repo. (Costs still priced as Opus → expected until P4; note in PR.)

### Phase 4 — OpenAI pricing + context limits

- [ ] **Verify values** (blocking): OpenAI per-MTok prices + context windows for `gpt-5.5`, `gpt-5.3-codex`, `gpt-5-codex`, `gpt-5`, `gpt-5-mini`, `gpt-4.1`, `gpt-4o-mini`.
- [ ] **Vendor-aware pricing**
  - File: `lib/pricing.ts` — OpenAI entries, `vendorOf`, `FALLBACK_BY_VENDOR`, `pricedAs` within vendor, unknown vendor → unpriced.
  - File: `components/costs/unpriced-models-alert.tsx` — render "unpriced" when `priced_as === ''`.
- [ ] **Context limits**
  - File: `lib/context-limits.ts` — OpenAI entries; `contextLimit(..., override?)`.
  - File: `components/sessions/context/context-tab.tsx` — pass `replay.context_window`.
- [ ] **Insights tiers**
  - File: `lib/model-tiers.ts`; `lib/insights.ts` — economy model by vendor.
- [ ] **Write tests**
  - File: `lib/__tests__/pricing.test.ts` — `vendor_of`, `priced_as_stays_within_vendor`, `unknown_vendor_is_unpriced`, `openai_cache_read_rate`, `pricing_json_overrides_openai`.
  - File: `lib/__tests__/context-limits.test.ts` — `context_limit_override_wins`.
  - File: `lib/__tests__/insights.test.ts` — `insight_economy_model_by_vendor`.
- [ ] **Verify**
  - Costs page: no "priced as claude-opus" for GPT; Codex session cost ≈ tokens × published rates.

### Phase 5 — Copilot adapter

- [ ] **Check retention** (blocking): confirm `session-state/<id>/` survives Copilot session close/archive; if deleted, fall back to DB `sessions` table for listing and note in LIMITATIONS.
- [ ] **Fixtures**
  - Dir: `lib/__tests__/fixtures/copilot/` — 2 `session-state/<id>/events.jsonl` (+1 `workspace.yaml`), DDL script to build `session-store.db` in test from schema v8 (`sessions`, `assistant_usage_events`).
- [ ] **Usage DB**
  - File: `lib/harness/copilot/usage-db.ts` — lazy read-only `DatabaseSync` (pattern `lib/inspector-db.ts`), `usageFor(sessionId)`.
- [ ] **Copilot reader**
  - File: `lib/harness/copilot/reader.ts` — events pass + DB rows → ledger/agents/`copilot{aiu,premium_requests}`; minimal YAML reader for `workspace.yaml`.
- [ ] **Copilot replay**
  - File: `lib/harness/copilot/replay.ts`.
- [ ] **Copilot adapter + registry**
  - File: `lib/harness/copilot/adapter.ts` — list `session-state/*/events.jsonl`, mtime max rule; `COPILOT_HOME`.
  - File: `lib/harness/registry.ts` — register.
  - File: `lib/tool-categories.ts` — Copilot map.
- [ ] **Write tests**
  - File: `lib/__tests__/copilot-usage-db.test.ts` — `usage_db_missing_yields_null`, `usage_rows_for_session`.
  - File: `lib/__tests__/copilot-reader.test.ts` — `lists_session_state_dirs`, `mtime_is_max_of_events_and_db`, `ledger_from_usage_rows`, `reasoning_not_double_counted`, `tool_counts_and_errors_from_events`, `uses_task_agent_from_task_tool`, `copilot_cost_fields`, `copilot_version_as_cc_version`, `workspace_yaml_minimal_parser`.
  - File: `lib/__tests__/copilot-replay.test.ts` — `replay_joins_usage_by_turn_order`.
  - File: `lib/__tests__/tool-categories.test.ts` — `copilot_categories`.
  - File: `lib/__tests__/api-replay.test.ts` — `api_replay_copilot`.
- [ ] **Verify**
  - Real `~/.copilot`: sessions listed, tokens non-zero when DB present, replay shows tool calls; agents tab hidden.

### Phase 6 — Copilot cost

- [ ] **Verify AIU→USD** (blocking): GitHub docs for Copilot CLI AIU pricing. If unpublished → `AIU_USD = null`, premium requests column only.
- [ ] **Cost**
  - File: `lib/pricing.ts` — `AIU_USD`, `copilotCostUSD`, override key `copilot.aiu_usd`; `sessionCost` uses it for `harness === 'copilot'`.
  - File: `app/api/costs/route.ts` — `copilot_premium_requests`.
  - File: `components/costs/model-token-table.tsx` — premium-requests column when >0.
- [ ] **Write tests**
  - File: `lib/__tests__/pricing.test.ts` — `copilot_cost_usd_from_aiu`, `copilot_cost_null_rate_is_unpriced`.
  - File: `lib/__tests__/api-costs.test.ts` — `api_costs_premium_requests`.
- [ ] **Verify**: Copilot session cost matches `aiu × rate`; unpriced banner when rate null.

### Phase 7 — Docs + cleanup

- [ ] **Delete shim** — `lib/claude-reader.ts`; fix any remaining imports; drop `claude_reader_shim_reexports` test.
- [ ] **Docs**
  - Files: `README.md`, `docs/COMPATIBILITY.md` (per-harness files, event types, token field mapping table), `docs/LIMITATIONS.md`, `docs/CHANGELOG.md`, `docs/CONTRIBUTING.md`, `docs/TEAM.md`.
  - `package.json` description.
- [ ] **Verify**: `npm run build`, `npm test`, fresh-clone smoke with each harness dir absent in turn (no crash, banner says "not found").

---
## 6. Context: Current System Architecture

### Session reading (`lib/claude-reader.ts`)
- Current behavior: module-level `CLAUDE_DIR` (`CLAUDE_CONFIG_DIR ?? ~/.claude`). `getAllSessionRecords()` lists `projects/<slug>/*.jsonl`, stats mtime, parses with `mapPool(…,16)` into `SessionRecord { session: ParsedSession, ledger: TurnLedger, rate_limit_hits, cost_state }`, caches the in-flight promise by file path + mtime, folds `<session>/subagents/*.jsonl`, builds slug→cwd, sorts by `start_time` desc. Same module also reads stats-cache, live sessions, plans, tasks, history, skills, plugins, settings, memories, storage size.
- Current limitations: one dir, one format, `harness` concept absent; listing + parsing + Claude-only readers all in one 970-line module; `projects` and `tools` routes re-stream every JSONL for branches/versions.

### Per-turn ledger (`lib/session-ledger.ts`, `lib/time-window.ts`)
- Current behavior: `LedgerBuilder.addTurn/growTurn/addUser/appendAgent/build` → typed arrays; `ledgerMetrics`, `sliceSession`, `windowFromSearch(?from&to)` applied server-side in `app/api/sessions/route.ts`.
- Current limitations: none for this feature; harness-neutral already (model is a string index).

### Pricing / labels / limits (`lib/pricing.ts`, `lib/model-label.ts`, `lib/context-limits.ts`, `lib/insights.ts`)
- Current behavior: Claude-only tables; `pricedAs` longest-prefix else `claude-opus-4-8`; `~/.cc-lens/pricing.json` + `context.json` overrides; `modelLabel` regex over opus|sonnet|haiku|fable|mythos; insights compare against `claude-sonnet-5-5`.
- Current limitations: any unknown id (e.g. `gpt-5.5`) priced as Opus silently; labels mangle non-Claude ids.

### Tool categories (`lib/tool-categories.ts`)
- Current behavior: single `TOOL_CATEGORIES` map of Claude names; `categorizeTool`, `isMcpTool` (`mcp__srv__tool`).
- Current limitations: Codex/Copilot names (`exec_command`, `view`, `rg`, `github-mcp-server-*`) → `other`.

### API routes (`app/api/**`)
- Current behavior: `force-dynamic`; each route calls `getSessions()`/`getAllParsedSessions()`/`getAllSessionRecords()` then aggregates; per-session routes resolve a JSONL path via `findSessionJSONL(id)`; replay cached by path+etag (`lib/replay-cache.ts`, 3 entries, gzip).
- Current limitations: 30 import sites on `@/lib/claude-reader`; no shared filter beyond `?from&to` (sessions only) and `?range` (costs, trends).

### UI (`app/*/page.tsx`, `components/**`)
- Current behavior: client pages, each builds its own SWR key (`/api/costs?range=…`); `TopBar` holds search/refresh/live-capture; `SessionTable` client-side checkbox filters; badges via spans in `session-badges.tsx`; session page tabs replay/agents/context/raw.
- Current limitations: no harness dimension anywhere; tabs always rendered.

### Exports / team (`app/api/{export,import,export/team}`, `lib/team-reader.ts`, `lib/redact.ts`)
- Current behavior: `.cclens.json` v1.0.0 `{stats, sessions, facets, history}`; `.cclens-team.json` v1.0.0 `{member, cc_versions, sessions}` under `CC_LENS_TEAM_DIR ?? ~/.cc-lens/team`; `redactSession` explicit whitelist.
- Current limitations: no `harness`; whitelist drops unknown fields.

### CLI (`bin/cli.js`)
- Current behavior: banner prints Claude config dir; `digest` subcommand; opens browser on free port.
- Current limitations: single-dir banner.

### Live capture / inspector (`proxy/server.js`, `lib/inspector-db.ts`, `lib/proxy-control.ts`)
- Current behavior: Anthropic-only proxy writing `~/.cc-lens/inspector.db` (read-only `DatabaseSync` on read side).
- Current limitations: out of scope; stays Claude-only. Its lazy read-only SQLite open is the pattern for Copilot's DB.

### Key Files
| File | Purpose |
|------|---------|
| `lib/claude-reader.ts` | Claude listing + parsing + Claude-only readers (to be split) |
| `lib/session-ledger.ts` | Per-turn ledger, metrics, slicing (reused as-is) |
| `lib/time-window.ts` | `?from&to` parse/serialise (pattern for `?h=`) |
| `lib/replay-parser.ts`, `lib/replay-cache.ts` | Claude replay + cache (cache becomes entry-based) |
| `lib/pricing.ts` | Pricing tables, fallback, overrides |
| `lib/context-limits.ts` | Context windows per model |
| `lib/model-label.ts` | Claude id → label |
| `lib/tool-categories.ts` | Tool → category map |
| `lib/insights.ts` | Premium-model insight (economy model constant) |
| `lib/decode.ts` | `pathToSlug` / `slugToPath` |
| `lib/redact.ts`, `lib/team-reader.ts` | Export whitelist, team import/aggregate |
| `lib/inspector-db.ts` | Read-only `node:sqlite` pattern |
| `lib/jsonl.ts` | `readJSONLLines`, `mapPool` |
| `types/claude.ts` | All payload types |
| `app/api/sessions/route.ts` | Session list + `windowFromSearch` slicing |
| `app/api/costs/route.ts` | Cost aggregation by model/day/project |
| `app/api/tools/route.ts`, `app/api/projects/route.ts` | Aggregations with JSONL re-walks |
| `app/api/sessions/[id]/replay/route.ts` | Replay via `findSessionJSONL` + cache |
| `app/sessions/[id]/page.tsx` | Session detail tabs |
| `components/layout/top-bar.tsx` | Global controls (filter host) |
| `components/sessions/session-badges.tsx` | Badge styling pattern |
| `bin/cli.js` | Banner, digest |
| `lib/__tests__/claude-reader.test.ts` | Fixture/env/dynamic-import test pattern |
| `docs/COMPATIBILITY.md`, `docs/LIMITATIONS.md` | Supported-files contract |

---

## 7. Reference Implementations

- **URL param read server-side + client roundtrip**: `lib/time-window.ts:33-51` (`windowFromSearch`/`windowToSearch`), consumed in `app/api/sessions/route.ts` and `app/sessions/[id]/page.tsx:57-60` → template for `lib/harness-filter.ts` + `hooks/use-harness-filter.ts`.
- **Per-page SWR key with query**: `app/costs/page.tsx:22-28` → where `apiQuery()` wraps.
- **Streaming parse into ledger**: `lib/claude-reader.ts` `parseSessionFile` (`readJSONLLines` + `LedgerBuilder.addTurn/addUser`) → template for Codex/Copilot readers.
- **Folding secondary transcripts into a record**: `foldAgentUsage`/`withAgentUsage` in `lib/claude-reader.ts` → template for Copilot `agent_id` rows → `agent_model_usage`.
- **mtime cache + in-flight dedupe + eviction**: `lib/claude-reader.ts:417-505` → moved verbatim into `session-store.ts`.
- **Lazy read-only SQLite**: `lib/inspector-db.ts:14-22` → `lib/harness/copilot/usage-db.ts`.
- **Env-overridable dir with default**: `lib/config.ts` `configDir()` (`CC_LENS_CONFIG_DIR`), `lib/team-reader.ts:20` `teamDir()` → registry dir resolution.
- **Replay cache keyed by file**: `lib/replay-cache.ts:41-67` → generalise key to `SessionFileEntry`.
- **Badge component**: `components/sessions/session-badges.tsx` → `harness-badge.tsx`.
- **Client checkbox filters**: `components/sessions/session-table.tsx:65-88` (not reused for harness; kept as-is).
- **Pricing override merge**: `lib/pricing.ts` `getPricingTable()` → extend with OpenAI defaults + `copilot.aiu_usd` key.
- **Version-tolerant payload read**: `lib/team-reader.ts` `isTeamExport` + `readTeamExports` → add `1.0.0` default-harness branch.
- **Fixture-driven reader test**: `lib/__tests__/claude-reader.test.ts:79-110` → Codex/Copilot/api tests.
- **Export route shape**: `app/api/export/route.ts:50-67` → version bump.

---

## Notes

- Field names keep Claude semantics (`cache_creation_input_tokens`, `cc_version`, `.cclens*` files). Documented in `COMPATIBILITY.md`; not renamed.
- `stats-cache.json` is Claude-only; Activity/Stats for other harnesses derive from sessions only (slightly different daily counts vs Claude's own cache, acceptable).
- Copilot `session-store.db` can be absent or locked; always degrade to events-only, never block the dashboard.
- `node:sqlite` requires Node ≥ 24 (already required).
- No new npm deps (YAML parsed by regex for the 8 known keys).
- Performance: Codex walks a date tree; cap to `sessions/*/*/*/` + flat `archived_sessions/` (verified).
- Phase 1 PR is the largest diff but has zero behaviour change; review by diffing API payloads on real data.

### Unresolved questions
1. **AIU → USD rate** for Copilot CLI: published by GitHub? Value? (Blocks P6; fallback = premium requests only.)
2. **Copilot session-folder retention**: does `session-state/<id>/` survive session close/archive? (Blocks P5 listing strategy.)
3. **Codex compaction marker**: no `*compact*` payload type found in local sessions; confirm whether Codex writes one at all. If not, `has_compaction=false` for Codex and LIMITATIONS says so.
4. **Copilot utility-model rows**: do `gpt-4o-mini` / `*-utility` calls get their own `assistant_usage_events` rows (would break the order-based join)? Local session shows only `gpt-5.6-terra` rows; if utility rows exist, filter by `model` before joining.
5. **Copilot reasoning tokens**: assumed included in `output_tokens` like Codex; confirm against a `session.usage_checkpoint` total.
6. **OpenAI fallback model** for unknown `gpt-*` ids: `gpt-5.5` (over-estimate) or `gpt-5-mini` (under-estimate)? Recommend `gpt-5.5` to match Claude's Opus-fallback bias.
7. **OpenAI context windows** for `gpt-5.5`, `gpt-5.3-codex` (400k?) — verify; Codex per-session `model_context_window` covers most cases.
8. **`COPILOT_HOME` scope**: the binary reads it for its `pkg` dir; confirm `session-state/` and `session-store.db` also live under it when set.
9. **Project slug collisions**: `pathToSlug` is lossy (`/a-b/c` vs `/a/b-c`). Claude already lives with it; confirm acceptable across harnesses.

### Resolved during planning (from local data)
- Codex `last_token_usage`: `input_tokens` ⊇ `cached_input_tokens`; `output_tokens` ⊇ `reasoning_output_tokens`; `total_tokens = input + output`.
- Codex `archived_sessions/` is flat (`rollout-<ts>-<uuid>.jsonl`), no date tree.
- Copilot `assistant_usage_events.turn_index` is always 0 (schema v8); join by `created_at` order.
- Copilot CLI honours `COPILOT_HOME` (no `COPILOT_CONFIG_DIR`); used as the override var.
