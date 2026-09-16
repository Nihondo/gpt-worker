# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

gpt-worker is a zero-API-cost dev workflow tool: ChatGPT (web subscription, via an MCP connector) acts as the planning/review "brain," while a local coding agent acts as the execution "hands." It relays messages through one fixed Cloudflare Workers hub:

```
ChatGPT Project ── MCP over HTTPS ──> Shared Hub (CF Workers) ──> Selected Workspace (Durable Object) ──> Local Bridge (WebSocket)
```

The operating protocol for *using* gpt-worker as an agent (task/wait/report loop, plan validation, timeout handling) lives in [SKILL.md](SKILL.md) and [reference/protocol.md](reference/protocol.md) — read those before driving a gpt-worker session. This file is about developing gpt-worker itself.

Zero runtime dependencies by design (see `package.json`'s `description`) — do not add npm packages to `bridge/` or `worker/src/` without a strong reason; use Node/Workers built-ins.

## Commands

```bash
npm run check    # node --check every bridge/*.mjs + worker/src/index.js (syntax only, no linter)
npm test         # node --test tests/  (built-in Node test runner)
npm run verify   # check + test — run this before considering a change done
npm run dry-run  # cd worker && wrangler deploy --dry-run
npm run deploy   # cd worker && wrangler deploy  — never run without the user's explicit go-ahead
```

Run a single test file: `node --test tests/queue.test.mjs`. Filter by name: `node --test --test-name-pattern="taskHistory" tests/`.

There is no build step and no bundler — `bridge/*.mjs` and `worker/src/index.js` run as-is (Node ESM and Cloudflare Workers ESM respectively).

## Architecture

Three independently-runnable pieces, each with a distinct execution environment:

| Piece | Where | Runs on |
|---|---|---|
| CLI / bridge | `bridge/*.mjs`, `bin/gpt-worker` | Local Node.js, as a detached background daemon |
| Relay hub | `worker/src/index.js` | Cloudflare Workers (Durable Objects), one shared deployment for every workspace |
| ChatGPT-side tools | exposed by the Worker, described in `worker/src/tools.json` | Called by ChatGPT itself, never executed locally |

### The Durable Object is the only stateful authority

`worker/src/index.js`'s `BridgeDO` class holds *everything* durable: the message queue (`msgs` table), task/protocol state (`tasks` table), per-workspace secrets (`secrets` table), and standing guidance (`settings` table) — all in its own SQLite. One workspace = one Durable Object instance (keyed by a 16-hex-char `workspace_id`, via `idFromName`), so registering a new workspace never touches another's queue, tokens, or WebSocket link. A separate hub-named DO instance (`HUB_DO_NAME = "gpt-worker-hub"`) backs the shared OAuth-protected ChatGPT connector (`/mcp`) and keeps the `workspace_registry` table (`list_workspaces`).

Local files (`bridge/state.mjs`) hold only secrets/process bookkeeping — never a second copy of task/protocol state. The machine-wide `worker.json` may also hold non-protocol `chatUrlsByWorkspace`, `conversationUrlsByWorkspace`, and `chromeTabsByWorkspace` UI mappings: a workspace URL override falls back to shared `chatUrl`; its same-Project conversation URL is the durable handoff target; its tab ID is only a process-local cache. `gpt-worker chat new` clears the latter two mappings for one workspace without changing Worker task state, while `chat attach` records a manually opened same-Project conversation and clears its stale tab cache. Once a selected tab is at a same-Project conversation URL, Chrome automation must keep its URL unchanged and insert the continuation into its composer; only a new or Project-landing tab may navigate to the URL carrying a prompt. Clear and overwrite existing composer content to maintain uninterrupted background automation. Mutate these maps through `updateWorkerConfigAtomic()` so simultaneous CLIs cannot overwrite another workspace's association. `show-config` must remain an explicit allowlist projection of browser-facing settings; never serialize raw `worker.json` or emit its Worker/authentication tokens. Chrome automation intentionally does not issue `activate` or raise the selected window: a new-window launch is best-effort background behavior, with final focus controlled by Chrome and macOS. `state.json`/`guidance.md` in the local state dir are legacy migration inputs only (see `localMigrateLegacyState` in `worker/src/index.js`); do not add new local state that duplicates what the DO already owns.

### Message flow: two queues, one Durable Object, no chat text

ChatGPT and the local agent never exchange chat text as protocol — they exchange `INIT`/`EXECUTED` (local → GPT, via `to_gpt` queue rows, delivered through the `next_task` MCP tool) and `PLAN`/`DONE`/`BLOCKED` (GPT → local, via `to_local` queue rows, delivered through `submit_plan`). Each round is tagged with a `task_id` + `iteration`; `queueSubmit` in `worker/src/index.js` rejects a reply that doesn't match the task's current `iteration`, so a stale/duplicated GPT reply can never be misapplied. The full state machine and message body formats are documented in [reference/protocol.md](reference/protocol.md) — read it before changing anything in `queueNext`/`queueSubmit`/`localStartTask`/`localReportTask`.

### Local bridge: WebSocket client + 10 read-only workspace tools

`bridge/link.mjs`'s `BridgeLink` holds the outbound WebSocket to the Worker's `/link/<workspace_id>/<link_token>` endpoint (reconnects with exponential backoff, 1s → 30s). It dispatches incoming RPCs to `bridge/tools.mjs`'s `WorkspaceTools`, which implements the 10 read-only tools ChatGPT can call to inspect a workspace: `workspace_info`, `workspace_guidance`, `workspace_overview`, `list_directory`, `read_file`, `search_workspace`, `git_status`, `git_diff`, `git_log`, `execution_output`.

Three independent safety layers gate what ChatGPT can see:
- **Access window** (`link.mjs`'s `GATED_METHODS`): 8 of the 10 tools (all but `workspace_info`/`workspace_guidance`) answer `{"status":"no_active_task"}` unless a task is currently active — enforced using `__gptWorkerActiveTask`, authenticated metadata the Worker itself stamps onto every relayed call (never trust a value ChatGPT could supply). `--always-allow` on `gpt-worker start` disables this gate.
- **Sensitive-file denial** (`bridge/ignore.mjs`'s `SENSITIVE_PATTERNS`): `.env`, private keys, `.ssh/`, `.aws/`, credentials files, etc. are always blocked from reads, regardless of `.gitignore` or the access window. `NOISE_PATTERNS` are hidden from listing/search but not an error to read directly. Both pattern lists are copied verbatim from the upstream project this was inspired by (see file header) — preserve that provenance comment if you touch them.
- **Egress content sanitization** (`bridge/link.mjs`'s `reply()`, via `bridge/scanner.mjs` + `bridge/sanitize.mjs`): every reply — success or error, for every tool — is scanned for secrets by an external scanner (`betterleaks`, or `gitleaks` as a compatible fallback; see `bridge/leaks.toml`) and has every finding replaced with `[REDACTED:<RuleID>]` in place, plus local filesystem paths (workspace root, home, tmpdir, username) normalized to `[workspace]`/`[home]`/`[tmp]`/`[user]`. This is a **required external dependency**, not an optional one — `gpt-worker start` refuses to run if no working scanner is found (`bridge/cli.mjs`'s `cmdStart` calls `verifyScanner()`, which also runs a canary scan to catch a broken config or a same-named-but-wrong binary), and `reply()` fails closed: if sanitization itself throws, the original unscanned payload is never sent, an error response is sent instead. `bridge/sanitize.mjs` holds no secret-detection patterns of its own by design — see its header and the two `gw-*` rules in `bridge/leaks.toml` (which fill measured gaps in the scanner's built-in rule set; do not add a rule there that duplicates a built-in one). There is deliberately no all-or-nothing "restricted" outcome: masking always preserves line structure and never drops a whole field, unlike the upstream project this was evaluated against. Content sanitization is defense in depth, not a hard boundary — split/encoded/obfuscated secrets can still slip through a regex-based scanner; the access-window and sensitive-file layers above remain the primary controls. `betterleaks`/`gitleaks` is an external binary (Homebrew/dnf/`go install`/Docker), unrelated to the zero-npm-dependency policy above, the same way `git` itself already is.

### Worker routing (`worker/src/index.js`)

Path shapes at the top-level `fetch`:
- `/admin/<ADMIN_TOKEN>` — provisioning (new workspace, hub token, rotation); machine-wide, never appears in a per-workspace URL.
- `/mcp`, `/mcp/<workspace_id>` — OAuth-protected shared and per-workspace ChatGPT MCP resources. The shared resource forwards per-tool calls to the right per-workspace DO via an internal `/hub` route. `/hub` is binding-only (fetched only from `handleHubToolCall`, never routed from the top-level `fetch`), so a DO handling a `/hub` request can assume the shared connector unconditionally — `invokeTool`'s `connector` option relies on this to pick the right operating-instructions variant.
- `/link/<workspace_id>/<link_token>`, `/local/<workspace_id>/<cli_token>` — token-protected local bridge and CLI endpoints; they are not MCP connector routes.

`workspace_id` is a routing key, not a secret (selects which DO instance); the actual `gpt_token`/`link_token`/`cli_token` are generated by `/admin` and validated **inside** the DO against its own `secrets` table — the top-level Worker never sees them.

### CLI (`bridge/cli.mjs`)

Each `gpt-worker <cmd>` subcommand talks to the Worker over `/local/<workspace_id>/<cli_token>` (`localCall`) for queue/task operations. `cmdWait` (the most failure-prone command to modify) already polls the Worker in ~20s chunks for its whole `--timeout` window (default 900s) — it is a single blocking call by design; if you change its retry/backoff behavior, keep that property, since [SKILL.md](SKILL.md) explicitly instructs agents to call it once and let it block rather than wrapping it in their own sleep/retry loop.

## Key invariants to preserve when editing

- **DO is the single source of truth for task/protocol state.** Never let the CLI or bridge reconstruct or cache task state independently (see the comment at the top of `bridge/state.mjs`).
- **Workspace isolation between DOs.** A change to routing or `idFromName` calls must not let one workspace's queue, tokens, or WebSocket link become reachable from another's.
- **Token validation stays inside the DO**, not at the top-level Worker `fetch`.
- **Exactly two trusted inputs, with different provenance.** (1) The Worker-owned operating protocol in `worker/src/instructions.md`, parsed by `worker/src/instructions.js` — static text compiled into the Worker, delivered in `InitializeResult.instructions`, by the `operating_instructions` tool, and in the `operating_instructions` field of a non-empty `next_task` result. It is trusted because nothing outside this repository can reach it; never interpolate workspace, CLI, or ChatGPT data into it. (2) `workspace_guidance` — the only trusted input from the **local** side, set through the owner-authenticated CLI. Everything else ChatGPT reads is untrusted workspace data (see `UNTRUSTED_NOTE` in `bridge/tools.mjs` and the protocol doc). Don't blur either line when adding new tools.
- **Local state files are private by default** (`0700` dirs / `0600` files, self-healed by `fixPermissions()` in `bridge/state.mjs`) — any new local state file must go through the same helpers, not raw `fs.writeFileSync`.
- **Idempotent enqueue**: `localEnqueue` reuses an existing message for a repeated `(task_id, iteration)` instead of creating a duplicate, since a CLI retry after a dropped HTTP response must not double-post. Preserve this if you touch queueing.

## Tests

`tests/` uses Node's built-in test runner (`node --test`) against a fake Durable Object context (`tests/helpers/fake-do-ctx.mjs`) or a real temporary git repo (`tests/tools-containment.test.mjs`), not Miniflare — `queue.test.mjs` and `admin.test.mjs` import the real `BridgeDO` methods from `worker/src/index.js` and exercise them directly against `this.sql`, so DO logic changes are covered without deploying. When adding a workspace tool or a queue/admin op, add or extend a test in the matching file rather than introducing a new test harness.

## Commit messages

This repo follows [Conventional Commits 1.0.0](https://www.conventionalcommits.org/ja/v1.0.0/) — see [docs/commit-instructions.md](docs/commit-instructions.md) (written in Japanese) for the full type list and examples used in this repo.
