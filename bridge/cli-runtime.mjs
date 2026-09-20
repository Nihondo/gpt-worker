import fs from "node:fs";
import {
  readWorkerConfig,
  workerConfigPath,
  readTokens,
  readState,
  clearLegacyState,
  readGuidance,
  clearGuidance,
  appendLog,
} from "./state.mjs";

// Exit codes beyond the conventional 0 (success) / 1 (error). `wait` already
// uses 2 for "no message yet".
export const EXIT_PROTOCOL_STATE = 3; // the Worker delivered a reply but the task did not advance
export const EXIT_WORKER_UNREACHABLE = 4; // the Worker could not be reached

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") && argv[i + 1] !== "-w") out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else if (a === "-w" && argv[i + 1]) out.workspace = argv[++i];
    else out._.push(a);
  }
  return out;
}

export function workspaceRoot(args) {
  return fs.realpathSync(args.workspace || process.cwd());
}

export function requireWorkspaceConfig(root) {
  const worker = readWorkerConfig();
  if (!worker) {
    console.error(`Not initialized. Run: gpt-worker init -w ${root}  (config path: ${workerConfigPath()})`);
    process.exit(1);
  }
  const tokens = readTokens(root);
  if (!tokens) {
    console.error(`This workspace isn't provisioned yet. Run: gpt-worker init -w ${root}`);
    process.exit(1);
  }
  // workspaceRoot rides along so the transport layer can write to this
  // workspace's bridge.log without every caller threading a root through.
  return { workerUrl: worker.workerUrl, adminToken: worker.adminToken, ...tokens, workspaceRoot: root };
}

// ---------------------------------------------------------------------------
// Talking to the Worker
//
// Every CLI command reaches the Worker through localCall()/adminCall(). They
// used to be a bare fetch: no timeout, no retry, and a network hiccup surfaced
// as a raw stack trace — including in the middle of a 900s `wait`.
// ---------------------------------------------------------------------------

/** The Worker could not be reached (or kept failing at the transport level).
 *  `maybeApplied` is true when the request may nevertheless have taken effect —
 *  a mutating call that timed out or got a 5xx, where "never arrived" and
 *  "arrived but the reply was lost" cannot be told apart. */
export class WorkerUnreachableError extends Error {
  constructor(message, { op = null, attempts = 1, status = null, maybeApplied = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "WorkerUnreachableError";
    this.op = op;
    this.attempts = attempts;
    this.status = status;
    this.maybeApplied = maybeApplied;
  }
}

/** The Worker answered, but with a structured error the command cannot
 *  continue past (e.g. the active-task lookup failed). Not a network problem. */
export class WorkerCallError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "WorkerCallError";
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
// How far past an absolute `deadlineMs` a single attempt may run. A long-poll
// the Worker holds open until exactly the deadline must be allowed to answer,
// or a healthy wait would be aborted at its own finish line and misread as an
// outage.
const DEADLINE_GRACE_MS = 2_000;
const POLL_TIMEOUT_MARGIN_MS = 10_000;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 30_000;

// Ops that can be repeated without changing the outcome, so a lost response is
// safe to retry. `ack` is included deliberately: acking twice is a no-op the
// second time (localAck reports it as already_acked).
const IDEMPOTENT_OPS = new Set([
  "status",
  "active_task",
  "poll",
  "list",
  "ack",
  "settings_get",
  "browser_settings_get",
  "max_body_bytes_get",
  "guidance_get",
]);

function isIdempotentOp(op) {
  // Admin reads (hub_browser_settings_get, owner_token_get, ...) follow the
  // same *_get naming.
  return IDEMPOTENT_OPS.has(op) || (typeof op === "string" && op.endsWith("_get"));
}

// Connection-establishment failures: the request provably never reached the
// server, so repeating even a mutating call cannot double-apply it.
const NEVER_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function fetchFailureCode(err) {
  const cause = err && err.cause;
  return (cause && (cause.code || (cause.errors && cause.errors[0] && cause.errors[0].code))) || (err && err.code) || null;
}

function describeFetchFailure(err) {
  if (err && (err.name === "TimeoutError" || err.name === "AbortError")) return "request timed out";
  const code = fetchFailureCode(err);
  const cause = err && err.cause;
  return code || (cause && cause.message) || (err && err.message) || String(err);
}

export function parseRetryAfterMs(header) {
  if (header === null || header === undefined || header === "") return null;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

function backoffMs(attempt, baseMs) {
  // 300ms, 900ms, 2.7s ... with +/-25% jitter so simultaneous CLIs (several
  // agents on one machine) do not retry in lockstep.
  return baseMs * 3 ** (attempt - 1) * (0.75 + Math.random() * 0.5);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One logical call to the Worker: POST `payload`, retrying only when that is
 *  safe for `op` (see the classification above). Resolves with the parsed body
 *  for any answer that reached the application — including structured errors
 *  and 4xx — and throws WorkerUnreachableError for transport-level failure.
 *
 *  `opts`: `throttleBeforeDispatch` (true only for /local: see below),
 *  `deadlineMs` (an absolute time the whole call must not run far past: each
 *  attempt's timeout is clamped to it and no retry starts after it),
 *  `timeoutMs`, `retry: { attempts, baseMs }` (tests shorten these),
 *  `log(line)` for the bridge log, and `notify(line)` for a line the *user*
 *  should see (default: stderr). The base delay can also be set with
 *  GPT_WORKER_RETRY_BASE_MS. */
async function callWorker(url, op, payload, opts = {}) {
  const idempotent = isIdempotentOp(op);
  const attempts = Math.max(1, opts.retry?.attempts ?? MAX_ATTEMPTS);
  const envBase = Number(process.env.GPT_WORKER_RETRY_BASE_MS);
  const baseMs = opts.retry?.baseMs ?? (Number.isFinite(envBase) && envBase >= 0 ? envBase : 300);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = opts.log || (() => {});
  const notify = opts.notify || ((line) => console.error(line));

  const deadlineMs = Number.isFinite(opts.deadlineMs) ? opts.deadlineMs : null;

  for (let attempt = 1; ; attempt++) {
    let failure;
    // Each attempt is bounded by its own timeout *and* by whatever is left of
    // the caller's deadline. Without the second bound, a hung server let a call
    // with a 1s deadline run for 3 attempts x 11s.
    const attemptTimeoutMs =
      deadlineMs === null ? timeoutMs : Math.min(timeoutMs, Math.max(1, deadlineMs - Date.now() + DEADLINE_GRACE_MS));
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(attemptTimeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        await res.arrayBuffer().catch(() => {});
        failure = {
          detail: `HTTP ${res.status}`,
          status: res.status,
          // /local rate-limits before it parses or dispatches (see
          // handleLocalRoute), so a 429 from it means the op did not run and
          // retrying is safe for every op. /admin has no such gate — it forwards
          // to a Durable Object — so a 429 there proves nothing about whether a
          // rotate/deprovision/register ran, and only a repeatable read may be
          // retried. A 5xx gives no guarantee on either route.
          retryable: idempotent || (res.status === 429 && opts.throttleBeforeDispatch === true),
          maybeApplied: !(res.status === 429 && opts.throttleBeforeDispatch === true),
          retryAfterMs: res.status === 429 ? parseRetryAfterMs(res.headers.get("retry-after")) : null,
        };
      } else {
        const body = await res.json().catch(() => ({}));
        if (!res.ok && !body.error) body.error = `HTTP_${res.status}`;
        return body;
      }
    } catch (err) {
      const neverSent = NEVER_SENT_CODES.has(fetchFailureCode(err));
      failure = {
        detail: describeFetchFailure(err),
        status: null,
        retryable: neverSent || idempotent,
        maybeApplied: !neverSent,
        retryAfterMs: null,
        cause: err,
      };
    }

    const pastDeadline = () => deadlineMs !== null && Date.now() >= deadlineMs;
    const giveUp = !failure.retryable || attempt >= attempts || pastDeadline();
    log(`${op} attempt ${attempt}/${attempts} failed: ${failure.detail}${giveUp ? " (giving up)" : ""}`);
    const unreachable = () => {
      // Only mutating calls can be "maybe applied"; a read has nothing to apply.
      const maybeApplied = failure.maybeApplied && !idempotent;
      return new WorkerUnreachableError(
        `Could not reach the Worker (${failure.detail}) for "${op}" after ${attempt} attempt${attempt === 1 ? "" : "s"}.` +
          (maybeApplied ? " The request may still have been applied; check with: gpt-worker state" : ""),
        { op, attempts: attempt, status: failure.status, maybeApplied, cause: failure.cause }
      );
    };
    if (giveUp) throw unreachable();
    let delayMs = failure.retryAfterMs ?? backoffMs(attempt, baseMs);
    if (deadlineMs !== null) delayMs = Math.min(delayMs, Math.max(0, deadlineMs - Date.now()));
    // The Worker's 429 asks for a 60s pause (capped to 30s here). A command
    // that then sits silent for that long looks hung, so say what it is doing —
    // but only for a long wait: the ordinary sub-second retries stay quiet.
    if (delayMs >= 2_000) {
      notify(`Worker is busy (${failure.detail}); retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${attempts})...`);
    }
    await sleep(delayMs);
    // The pause above is clamped to the time left, so it can end exactly at the
    // deadline. Checking only *before* sleeping let one more attempt start after
    // it; "no retry begins after the deadline" needs the check on this side too.
    if (pastDeadline()) {
      log(`${op}: deadline reached while waiting to retry (giving up)`);
      throw unreachable();
    }
  }
}

function localLog(cfg, opts) {
  if (opts.log) return opts.log;
  if (!cfg || !cfg.workspaceRoot) return () => {};
  return (line) => {
    try {
      appendLog(cfg.workspaceRoot, `cli: ${line}`);
    } catch {
      /* logging must never turn a retry into a failure */
    }
  };
}

export async function localCall(cfg, op, extra = {}, opts = {}) {
  const url = `${cfg.workerUrl.replace(/\/$/, "")}/local/${cfg.workspaceId}/${cfg.cliToken}`;
  // `poll` is a long-poll: the Worker holds the request open for up to
  // `timeout_ms`, so the client's own limit has to sit above that.
  const timeoutMs = opts.timeoutMs ?? (op === "poll" ? Number(extra.timeout_ms || 0) + POLL_TIMEOUT_MARGIN_MS : DEFAULT_TIMEOUT_MS);
  return callWorker(url, op, { op, ...extra }, { ...opts, timeoutMs, throttleBeforeDispatch: true, log: localLog(cfg, opts) });
}

export async function adminCall(worker, op, extra = {}, opts = {}) {
  const url = `${worker.workerUrl.replace(/\/$/, "")}/admin/${worker.adminToken}`;
  return callWorker(url, op, { op, ...extra }, opts);
}

export async function remoteActiveTask(cfg, opts = {}) {
  const state = await localCall(cfg, "active_task", {}, opts);
  if (state.error) throw new WorkerCallError(state.error);
  return state.task || null;
}

export async function migrateLegacyStateIfNeeded(root, cfg) {
  const legacy = readState(root);
  const settings = {};
  if (legacy && legacy.chatUrl !== undefined) settings.chatUrl = legacy.chatUrl;
  if (legacy && legacy.enterDelayMs !== undefined) settings.enterDelayMs = legacy.enterDelayMs;
  if (Object.keys(settings).length) {
    const saved = await localCall(cfg, "settings_set", settings);
    if (saved.error) throw new Error(saved.error);
  }
  if (legacy && legacy.taskId && ["WAITING_PLAN", "EXECUTING", "WAITING_REVIEW"].includes(legacy.protocolState)) {
    const migrated = await localCall(cfg, "migrate_legacy_state", legacy);
    if (migrated.error) throw new Error(migrated.error);
  }
  const legacyGuidance = readGuidance(root);
  if (legacyGuidance) {
    const migratedGuidance = await localCall(cfg, "guidance_set", { text: legacyGuidance });
    if (migratedGuidance.error) throw new Error(migratedGuidance.error);
    clearGuidance(root);
  }
  if (legacy) clearLegacyState(root);
}
