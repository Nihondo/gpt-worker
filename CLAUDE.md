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

`worker/src/index.js`'s `BridgeDO` class holds *everything* durable: the message queue (`msgs` table), task/protocol state (`tasks` table), per-workspace secrets (`secrets` table), and standing guidance (`settings` table) — all in its own SQLite. One workspace = one Durable Object instance (keyed by a 16-hex-char `workspace_id`, via `idFromName`), so registering a new workspace never touches another's queue, tokens, or WebSocket link. A separate hub-named DO instance (`HUB_DO_NAME = "gpt-worker-hub"`) exists only to route the one shared ChatGPT connector (`/mcp/<hub_gpt_token>`) to the right per-workspace DO and to keep the `workspace_registry` table (`list_workspaces`).

Local files (`bridge/state.mjs`) hold only secrets/process bookkeeping — never a second copy of task/protocol state. The machine-wide `worker.json` may also hold non-protocol `chatUrlsByWorkspace` and `chromeTabsByWorkspace` UI mappings: a workspace URL override falls back to shared `chatUrl`, and its tab is scoped to the effective URL. Mutate these maps through `updateWorkerConfigAtomic()` so simultaneous CLIs cannot overwrite another workspace's association. `show-config` must remain an explicit allowlist projection of browser-facing settings; never serialize raw `worker.json` or emit its Worker/authentication tokens. `state.json`/`guidance.md` in the local state dir are legacy migration inputs only (see `localMigrateLegacyState` in `worker/src/index.js`); do not add new local state that duplicates what the DO already owns.

### Message flow: two queues, one Durable Object, no chat text

ChatGPT and the local agent never exchange chat text as protocol — they exchange `INIT`/`EXECUTED` (local → GPT, via `to_gpt` queue rows, delivered through the `next_task` MCP tool) and `PLAN`/`DONE`/`BLOCKED` (GPT → local, via `to_local` queue rows, delivered through `submit_plan`). Each round is tagged with a `task_id` + `iteration`; `queueSubmit` in `worker/src/index.js` rejects a reply that doesn't match the task's current `iteration`, so a stale/duplicated GPT reply can never be misapplied. The full state machine and message body formats are documented in [reference/protocol.md](reference/protocol.md) — read it before changing anything in `queueNext`/`queueSubmit`/`localStartTask`/`localReportTask`.

### Local bridge: WebSocket client + 7 read-only workspace tools

`bridge/link.mjs`'s `BridgeLink` holds the outbound WebSocket to the Worker's `/link/<workspace_id>/<link_token>` endpoint (reconnects with exponential backoff, 1s → 30s). It dispatches incoming RPCs to `bridge/tools.mjs`'s `WorkspaceTools`, which implements the 7 read-only tools ChatGPT can call to inspect a workspace: `workspace_info`, `workspace_guidance`, `list_directory`, `read_file`, `search_workspace`, `git_status`, `git_diff`, `git_log`, `execution_output`.

Two independent safety layers gate what ChatGPT can see:
- **Access window** (`link.mjs`'s `GATED_METHODS`): 6 of the 7 tools (all but `workspace_info`) answer `{"status":"no_active_task"}` unless a task is currently active — enforced using `__gptWorkerActiveTask`, authenticated metadata the Worker itself stamps onto every relayed call (never trust a value ChatGPT could supply). `--always-allow` on `gpt-worker start` disables this gate.
- **Sensitive-file denial** (`bridge/ignore.mjs`'s `SENSITIVE_PATTERNS`): `.env`, private keys, `.ssh/`, `.aws/`, credentials files, etc. are always blocked from reads, regardless of `.gitignore` or the access window. `NOISE_PATTERNS` are hidden from listing/search but not an error to read directly. Both pattern lists are copied verbatim from the upstream project this was inspired by (see file header) — preserve that provenance comment if you touch them.

### Worker routing (`worker/src/index.js`)

Path shapes at the top-level `fetch`:
- `/admin/<ADMIN_TOKEN>` — provisioning (new workspace, hub token, rotation); machine-wide, never appears in a per-workspace URL.
- `/mcp/<hub_gpt_token>` — the one shared ChatGPT connector URL; forwards to the hub DO, which itself forwards per-tool calls to the right per-workspace DO via an internal `/hub` route.
- `/mcp/<workspace_id>/<token>`, `/link/<workspace_id>/<token>`, `/local/<workspace_id>/<token>` — legacy per-workspace endpoints, kept for migration.

`workspace_id` is a routing key, not a secret (selects which DO instance); the actual `gpt_token`/`link_token`/`cli_token` are generated by `/admin` and validated **inside** the DO against its own `secrets` table — the top-level Worker never sees them.

### CLI (`bridge/cli.mjs`)

Each `gpt-worker <cmd>` subcommand talks to the Worker over `/local/<workspace_id>/<cli_token>` (`localCall`) for queue/task operations. `cmdWait` (the most failure-prone command to modify) already polls the Worker in ~20s chunks for its whole `--timeout` window (default 900s) — it is a single blocking call by design; if you change its retry/backoff behavior, keep that property, since [SKILL.md](SKILL.md) explicitly instructs agents to call it once and let it block rather than wrapping it in their own sleep/retry loop.

## Key invariants to preserve when editing

- **DO is the single source of truth for task/protocol state.** Never let the CLI or bridge reconstruct or cache task state independently (see the comment at the top of `bridge/state.mjs`).
- **Workspace isolation between DOs.** A change to routing or `idFromName` calls must not let one workspace's queue, tokens, or WebSocket link become reachable from another's.
- **Token validation stays inside the DO**, not at the top-level Worker `fetch`.
- **`workspace_guidance` is the only trusted input from the local side** — every other tool result ChatGPT reads is untrusted workspace data (see `UNTRUSTED_NOTE` in `bridge/tools.mjs` and the protocol doc). Don't blur that line when adding new tools.
- **Local state files are private by default** (`0700` dirs / `0600` files, self-healed by `fixPermissions()` in `bridge/state.mjs`) — any new local state file must go through the same helpers, not raw `fs.writeFileSync`.
- **Idempotent enqueue**: `localEnqueue` reuses an existing message for a repeated `(task_id, iteration)` instead of creating a duplicate, since a CLI retry after a dropped HTTP response must not double-post. Preserve this if you touch queueing.

## Tests

`tests/` uses Node's built-in test runner (`node --test`) against a fake Durable Object context (`tests/helpers/fake-do-ctx.mjs`) or a real temporary git repo (`tests/tools-containment.test.mjs`), not Miniflare — `queue.test.mjs` and `admin.test.mjs` import the real `BridgeDO` methods from `worker/src/index.js` and exercise them directly against `this.sql`, so DO logic changes are covered without deploying. When adding a workspace tool or a queue/admin op, add or extend a test in the matching file rather than introducing a new test harness.

## Commit messages

This repo follows [Conventional Commits 1.0.0](https://www.conventionalcommits.org/ja/v1.0.0/) — see [docs/commit-instructions.md](docs/commit-instructions.md) (written in Japanese) for the full type list and examples used in this repo.
