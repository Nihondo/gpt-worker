import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
import { verifyScanner } from "./scanner.mjs";

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
    else if (a === "-n") {
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("-")) out.n = argv[++i];
      else out.n = true;
    }
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
  return (await remoteActiveState(cfg, opts)).task;
}

/** Returns the active task together with the Worker-owned read-window
 * metadata. Keep remoteActiveTask() as the task-only compatibility wrapper:
 * most callers need no knowledge of the window, while status must never
 * duplicate the Worker's idle-limit constant locally. */
export async function remoteActiveState(cfg, opts = {}) {
  const state = await localCall(cfg, "active_task", {}, opts);
  if (state.error) throw new WorkerCallError(state.error);
  return { task: state.task || null, taskWindow: state.taskWindow || null, bundleHint: state.bundleHint || null };
}

// ---------------------------------------------------------------------------
// workspace_bundle hint (Worker-computed; see BridgeDO.bundleHint)
// ---------------------------------------------------------------------------
//
// ChatGPT asks the user before it opens a workspace_bundle attachment, and
// that dialog is invisible from here. When the last thing ChatGPT did was be
// handed an archive and the task has not moved since, the Worker says so in
// `poll` / `active_task`. This is a hint, never a finding: it cannot tell a
// pending dialog from ChatGPT simply reading the archive, so every message says
// "may". The Worker decides *whether* there is a hint; when to speak up about
// it is only presentation, so it lives here.

// The first advisory waits a while (reading a large archive takes minutes),
// then repeats rarely. Initial values, to be tuned against real use.
const BUNDLE_ADVICE_AFTER_MS = 120_000;
const BUNDLE_ADVICE_REPEAT_MS = 300_000;

/** "42s" / "3 min" / "1 h 5 min": a duration for a human. */
export function formatAgeMs(ms) {
  const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${Math.floor(minutes / 60)} h`;
}

/** The lines `wait` should print for a `poll` hint, and the memory to pass back
 *  with the next one. A hint is announced once when first seen; a reminder
 *  follows once the silence has lasted a while, and then only occasionally.
 *  `seen` is `{ at, adviceAgeMs }` from the previous call, or null. */
export function bundleHintMessages(hint, seen) {
  if (!hint || !Number.isFinite(hint.at)) return { lines: [], seen: seen || null };
  const age = Number(hint.ageMs) || 0;
  const isNew = !seen || seen.at !== hint.at;
  const next = isNew ? { at: hint.at, adviceAgeMs: null } : { ...seen };
  const lines = [];
  if (isNew) {
    lines.push(
      `ChatGPT called workspace_bundle and was handed the archive (${formatAgeMs(age)} ago). ` +
        "If ChatGPT asks for approval to open the attachment, answer in the ChatGPT window."
    );
  }
  const due = next.adviceAgeMs === null ? age >= BUNDLE_ADVICE_AFTER_MS : age - next.adviceAgeMs >= BUNDLE_ADVICE_REPEAT_MS;
  if (due) {
    lines.push(
      `${formatAgeMs(age)} since ChatGPT was handed a workspace_bundle archive, with no reply. ` +
        "It may be waiting for you to approve opening the attachment in the ChatGPT window (or it may still be reading it). Still waiting."
    );
    next.adviceAgeMs = age;
  }
  return { lines, seen: next };
}

/** What `wait` says when its deadline passes with a hint outstanding. It starts
 *  with the usual "No message yet." so anything that looks for that still works.
 *  `sinceHintMs` is how long ago the hint was received, because its own age was
 *  measured then. */
export function bundleTimeoutMessage(hint, sinceHintMs = 0) {
  const age = (Number(hint.ageMs) || 0) + Math.max(0, sinceHintMs);
  return (
    `No message yet. ChatGPT was handed a workspace_bundle archive ${formatAgeMs(age)} ago and has not replied since; ` +
    "it may be waiting for you to approve opening the attachment in the ChatGPT window. " +
    "Run 'gpt-worker wait' again to keep waiting."
  );
}

/** The `gpt-worker status` line for a hint. */
export function bundleStatusLine(hint) {
  return (
    `ChatGPT was handed a workspace_bundle archive ${formatAgeMs(hint.ageMs)} ago and has not continued ` +
    "(it may be waiting for your approval in the ChatGPT window)"
  );
}

function commandVersion(bin, args = ["--version"]) {
  try {
    return execFileSync(bin, args, { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function commandWorks(bin, args) {
  try {
    execFileSync(bin, args, { timeout: 2_000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function parseMinimumNodeVersion(range) {
  const match = typeof range === "string" ? range.match(/>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/) : null;
  return match ? match.slice(1).map((part) => Number(part || 0)) : null;
}

function nodeSatisfiesMinimum(current, minimum) {
  const actual = current.split(".").map((part) => Number(part));
  for (let i = 0; i < minimum.length; i++) {
    if ((actual[i] || 0) !== minimum[i]) return (actual[i] || 0) > minimum[i];
  }
  return true;
}

/** Check the local programs gpt-worker depends on before init starts an
 * irreversible deploy. Fatal findings block by default; optional programs are
 * reported so an operator knows which conveniences are unavailable. */
export function checkPrerequisites({ packagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json") } = {}) {
  const fatal = [];
  const warnings = [];
  const info = [];
  let nodeRange = null;
  try {
    nodeRange = JSON.parse(fs.readFileSync(packagePath, "utf8")).engines?.node || null;
  } catch {
    fatal.push(`could not read the required Node version from ${packagePath}`);
  }
  const minimum = parseMinimumNodeVersion(nodeRange);
  if (minimum && !nodeSatisfiesMinimum(process.versions.node, minimum)) {
    fatal.push(`Node ${process.versions.node} does not satisfy package.json engines.node ${nodeRange}`);
  } else if (nodeRange) {
    info.push(`Node ${process.versions.node} (${nodeRange})`);
  }

  const git = commandVersion("git");
  if (!git) fatal.push("git was not found on PATH (workspace reads require it)");
  else info.push(git);

  try {
    const scanner = verifyScanner();
    info.push(`secret scanner: ${scanner.bin} ${scanner.version}`);
  } catch (err) {
    fatal.push(String(err?.message || err).split("\n")[0]);
  }

  const rg = commandVersion("rg");
  if (!rg) warnings.push("rg was not found on PATH; searches fall back to git grep");
  else info.push(rg);

  if (process.platform === "darwin") {
    info.push(commandWorks("open", ["-Ra", "Google Chrome"]) ? "Google Chrome: available" : "Google Chrome: not found (browser nudges will need manual setup)");
  } else {
    info.push("Google Chrome: not checked on this platform");
  }
  return { ok: fatal.length === 0, fatal, warnings, info };
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
