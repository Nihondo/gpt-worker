// WebSocket reverse-connection to the Worker's /link/<workspace_id>/<LINK_TOKEN> endpoint.
// Reconnects with exponential backoff (1s -> 30s) so a bridge restart, laptop
// sleep, or network blip never requires touching the ChatGPT connector again.
//
// Access gating (6.5 of the plan): while no task is active, the tools that can
// reveal file/diff content (GATED_METHODS below) answer
// {"status":"no_active_task"} without running, or
// {"status":"task_window_expired"} when a task does exist but its read window
// has gone idle — two different situations that need two different recoveries
// from the operator. `workspace_info`/`workspace_guidance` are exempt: they
// only reveal workspace identity (name/branch/languages) and the owner's own
// guidance, which the first-connection check needs before any task exists.
//
// The window itself is Worker-owned state, never recomputed here (see
// handleMessage).

import os from "node:os";
import { WorkspaceTools } from "./tools.mjs";
import { appendLog } from "./state.mjs";
import { sanitizeText, redactLocalPaths } from "./sanitize.mjs";

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const GATED_METHODS = new Set([
  "workspace_overview",
  "list_directory",
  "read_file",
  "search_workspace",
  "git_status",
  "git_diff",
  "git_log",
  "execution_output",
  "workspace_batch",
]);

// The three values the Worker may stamp onto a relay as __gptWorkerTaskWindow.
// Anything else (including a missing key, i.e. an older Worker) falls back to
// deriving the state from the boolean __gptWorkerActiveTask.
const TASK_WINDOW_STATES = new Set(["none", "expired", "active"]);

const MAX_BATCH_CALLS = 8;
const BATCH_WHITELIST = new Set([
  "workspace_info",
  "workspace_overview",
  "list_directory",
  "read_file",
  "search_workspace",
  "git_status",
  "git_diff",
  "git_log",
  "execution_output",
]);

// Internal-only join marker used while batching every string field of one
// reply into a single scanner invocation (see sanitizeResult() below). A
// control character essentially never present in real file/diff/log
// content, so it can't be mistaken for a field boundary by any secret
// pattern's character class. Never sent over the wire.
const FIELD_SEP = "\x1e";

/** One-line, content-free summary of a dispatch result for bridge.log. Never
 *  includes file contents, diffs, or search hits — only the outcome shape: a
 *  bare success, a status string, an error code, or a batch's ok/err tally.
 *  bridge.log is a local 0600 file, but it is a debugging aid, not a data
 *  sink; keeping bodies out of it is what makes it safe to read and paste. */
function describeResultForLog(result) {
  if (!result || typeof result !== "object") return "ok";
  if (Array.isArray(result.results)) {
    const failed = result.results.filter((r) => r && r.ok === false).length;
    return `ok batch ${result.results.length} calls, ${result.results.length - failed} ok / ${failed} err`;
  }
  if (typeof result.error === "string") return `err ${result.error}`;
  if (result.status === "error") return `err ${result.code || "error"}`;
  if (typeof result.status === "string") return `ok ${result.status}`;
  return "ok";
}

function collectStringLeaves(value, out) {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStringLeaves(v, out);
  } else if (value && typeof value === "object") {
    for (const k of Object.keys(value)) collectStringLeaves(value[k], out);
  }
}

/** Rebuilds `value`'s shape as a new tree, substituting each string leaf
 *  with the next masked value from `iter` (same traversal order as
 *  collectStringLeaves — both walk Object.keys() on the same, unmutated
 *  source object). Never mutates the original result. */
function rebuildWithLeaves(value, iter) {
  if (typeof value === "string") return iter.next().value;
  if (Array.isArray(value)) return value.map((v) => rebuildWithLeaves(v, iter));
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = rebuildWithLeaves(value[k], iter);
    return out;
  }
  return value;
}

/** Sanitizes every string field in a reply payload with exactly one scanner
 *  invocation, regardless of how many fields it has — necessary because
 *  list_directory/search_workspace can return hundreds of entries, and
 *  spawning the scanner per-field would cost seconds per tool call (see the
 *  plan doc this was implemented from). Throws (never returns unscanned
 *  text) if the scanner fails or if batching can't be trusted to map masked
 *  text back to the right field.
 *
 *  Returns the new value plus a nested `sanitize` summary — nested, not
 *  flattened onto the result, because gitStatus()/gitDiff() already have
 *  their own unrelated `redacted` counter (git-ignored paths hidden from a
 *  status/diff) and a same-named top-level field here would silently
 *  collide with that. */
function sanitizeResult(result, pathContext) {
  if (typeof result === "string") {
    const { text, redacted, rules, heavilyRedacted } = sanitizeText(result);
    return { value: redactLocalPaths(text, pathContext), redacted, rules, heavilyRedacted };
  }
  if (!result || typeof result !== "object") {
    return { value: result, redacted: 0, rules: [], heavilyRedacted: false };
  }

  const leaves = [];
  collectStringLeaves(result, leaves);
  if (leaves.length === 0) return { value: result, redacted: 0, rules: [], heavilyRedacted: false };

  let maskedLeaves, redacted, rules, heavilyRedacted;
  if (leaves.some((s) => s.includes(FIELD_SEP))) {
    // FIELD_SEP is a control character that should never occur in real
    // content; if it somehow does, batching can't safely tell a field
    // boundary from a literal occurrence, so fall back to scanning each
    // field on its own rather than risk misattributing masked text.
    redacted = 0;
    const ruleSet = new Set();
    heavilyRedacted = false;
    maskedLeaves = leaves.map((s) => {
      const r = sanitizeText(s);
      redacted += r.redacted;
      for (const id of r.rules) ruleSet.add(id);
      if (r.heavilyRedacted) heavilyRedacted = true;
      return r.text;
    });
    rules = [...ruleSet];
  } else {
    const combined = leaves.join(FIELD_SEP);
    const r = sanitizeText(combined);
    const parts = r.text.split(FIELD_SEP);
    if (parts.length !== leaves.length) {
      // Should be unreachable given FIELD_SEP is excluded from every
      // pattern's character class — fail closed rather than risk sending a
      // field's masked text into the wrong place (or vice versa).
      throw new Error(`sanitize: batched field count mismatch (${parts.length} vs ${leaves.length})`);
    }
    maskedLeaves = parts;
    redacted = r.redacted;
    rules = r.rules;
    heavilyRedacted = r.heavilyRedacted;
  }

  maskedLeaves = maskedLeaves.map((s) => redactLocalPaths(s, pathContext));
  const value = rebuildWithLeaves(result, maskedLeaves[Symbol.iterator]());
  return { value, redacted, rules, heavilyRedacted };
}

export class BridgeLink {
  constructor({ workerUrl, workspaceId, linkToken, workspaceRoot, alwaysAllow, onPlanPushed, onDashboardTaskCreated }) {
    this.url = `${workerUrl.replace(/\/$/, "")}/link/${workspaceId}/${linkToken}`;
    this.root = workspaceRoot;
    this.alwaysAllow = !!alwaysAllow;
    this.onPlanPushed = onPlanPushed || (() => {});
    // Fired after a task is created through the Web dashboard
    // (docs/plans/queue-dashboard.md, §"新規タスク投入") — see
    // handleMessage's dashboard_task_created branch below for why this is
    // ACKed before the callback runs, same as onPlanPushed.
    this.onDashboardTaskCreated = onDashboardTaskCreated || (() => {});
    this.tools = new WorkspaceTools(workspaceRoot);
    this.ws = null;
    this.backoff = MIN_BACKOFF_MS;
    this.stopped = false;
    // Fixed once per process for redactLocalPaths() — see sanitize.mjs: these
    // are known real values, not a guessed pattern. Uses this.tools.root
    // (realpath'd by WorkspaceTools), not the raw workspaceRoot argument:
    // fs error messages (e.g. readFile's ENOENT) are built from realpath'd
    // paths, and on macOS /tmp is itself a symlink to /private/tmp, so the
    // two can differ even for an ordinary workspace path.
    let username = null;
    try {
      username = os.userInfo().username;
    } catch {
      /* not available in every environment (e.g. some containers) */
    }
    this.pathContext = { root: this.tools.root, home: os.homedir(), tmpdir: os.tmpdir(), username };
  }

  /** Appends one line to the workspace's bridge.log (0600, rotated at 10MB by
   *  appendLog). Records only outcomes — method names, error codes, paths,
   *  window states, durations — and never response bodies: no file contents,
   *  no diffs, no search hits. Anything that would need the secret scanner
   *  before leaving this process does not belong in the log either. */
  log(line) {
    try {
      appendLog(this.root, `link: ${line}`);
    } catch {
      /* ignore */
    }
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  connect() {
    if (this.stopped) return;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.log(`connect failed: ${err}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.backoff = MIN_BACKOFF_MS;
      this.log("connected");
    });

    ws.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });

    ws.addEventListener("close", (event) => {
      this.log(`closed (${event.code} ${event.reason || ""})`);
      if (!this.stopped) this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // "close" always follows "error" for WebSocket; reconnect happens there.
    });
  }

  scheduleReconnect() {
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    setTimeout(() => this.connect(), delay);
  }

  async handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const { rid, method, params } = msg;
    if (!rid || !method) return;

    if (method === "plan_pushed") {
      this.reply(rid, true, {});
      this.onPlanPushed(params);
      return;
    }

    // Best-effort browser nudge for a task created through the Web
    // dashboard (BridgeDO.dashboardStartTask's callLocal push). ACKed
    // *before* the (potentially slow, Chrome-automation-driven) callback
    // runs — same ack-before-side-effect shape as plan_pushed — so a slow
    // or failed nudge is never visible to the DO as an RPC timeout, and
    // never reverses the already-authoritative task creation. Any callback
    // failure is the callback's own responsibility to log (see
    // cli-daemon.mjs's cmdStart --__daemon wiring); it is never surfaced back
    // through this RPC.
    if (method === "dashboard_task_created") {
      this.reply(rid, true, {});
      try {
        // Swallow both a synchronous throw and an async rejection here —
        // the real callback (cli-daemon.mjs's handleDashboardTaskCreated) already
        // catches its own errors and logs them via appendLog(), but this
        // handler must not depend on every caller doing that: a callback
        // that throws must never turn into an unhandled rejection on this
        // WebSocket's "message" listener (which does not await
        // handleMessage), let alone reach the caller of this method.
        await this.onDashboardTaskCreated(params);
      } catch (err) {
        this.log(`dashboard_task_created callback failed: ${String((err && err.message) || err)}`);
      }
      return;
    }

    // The Worker owns task state and appends this authenticated metadata to
    // every relay. Do not reconstruct an active task from a local file: that
    // would make the bridge a second workflow-state authority.
    //
    // Two keys arrive. __gptWorkerActiveTask is the long-standing boolean;
    // __gptWorkerTaskWindow (newer Workers) additionally distinguishes "no
    // task at all" from "a task exists but its read window went idle". When
    // the newer key is absent or unrecognized the state is derived from the
    // boolean, so an older Worker behaves exactly as before. The derivation
    // only ever goes boolean -> state, never state -> permission: a Worker
    // that sends a non-"active" state can never widen access here.
    const workerSaysTaskIsActive = !!(params && params.__gptWorkerActiveTask);
    const rawWindow = params && params.__gptWorkerTaskWindow;
    const windowState = TASK_WINDOW_STATES.has(rawWindow)
      ? rawWindow
      : workerSaysTaskIsActive
        ? "active"
        : "none";
    if (params && typeof params === "object") {
      delete params.__gptWorkerActiveTask;
      delete params.__gptWorkerTaskWindow;
    }
    if (GATED_METHODS.has(method) && !this.alwaysAllow && windowState !== "active") {
      // The only local trace that a read was refused, and why — without it an
      // expired window is indistinguishable from "ChatGPT never called".
      this.log(`gated ${method}: ${windowState}`);
      this.reply(
        rid,
        true,
        windowState === "expired"
          ? {
              status: "task_window_expired",
              message:
                "A task exists but its read window has gone idle. Retrying will not help; the operator has to advance the task (gpt-worker report / continue) or start a new one.",
            }
          : { status: "no_active_task" }
      );
      return;
    }

    const startedAt = Date.now();
    try {
      const result = this.dispatch(method, params || {});
      this.log(`rpc ${method} ${describeResultForLog(result)} ${Date.now() - startedAt}ms`);
      this.reply(rid, true, result);
    } catch (err) {
      const message = String((err && err.message) || err);
      this.log(`rpc ${method} threw ${Date.now() - startedAt}ms: ${message}`);
      this.reply(rid, false, { status: "error", message });
    }
  }

  dispatch(method, params) {
    switch (method) {
      case "workspace_info":
        return this.tools.workspaceInfo();
      case "workspace_guidance":
        return this.tools.workspaceGuidance();
      case "workspace_overview":
        return this.tools.workspaceOverview();
      case "list_directory":
        return this.tools.listDirectory(params);
      case "read_file":
        return this.tools.readFile(params);
      case "search_workspace":
        return this.tools.searchWorkspace(params);
      case "git_status":
        return this.tools.gitStatus();
      case "git_diff":
        return this.tools.gitDiff(params);
      case "git_log":
        return this.tools.gitLog(params);
      case "execution_output":
        return this.tools.executionOutput(params);
      case "workspace_batch":
        return this.executeBatch(params);
      default:
        return { status: "unknown_method", method };
    }
  }

  executeBatch(params) {
    if (!params || typeof params !== "object" || !Array.isArray(params.calls)) {
      return { status: "error", code: "INVALID_ARGS", message: "calls must be an array" };
    }
    if (params.calls.length === 0) {
      return { status: "error", code: "INVALID_ARGS", message: "calls cannot be empty" };
    }
    if (params.calls.length > MAX_BATCH_CALLS) {
      return { status: "error", code: "INVALID_ARGS", message: `calls exceeds maximum limit of ${MAX_BATCH_CALLS}` };
    }

    for (let i = 0; i < params.calls.length; i++) {
      const call = params.calls[i];
      if (!call || typeof call !== "object" || Array.isArray(call)) {
        return { status: "error", code: "INVALID_ARGS", message: `calls[${i}] must be an object` };
      }
      if (typeof call.id !== "string" || call.id.trim() === "") {
        return { status: "error", code: "INVALID_ARGS", message: `calls[${i}].id must be a non-empty string` };
      }
      if (typeof call.name !== "string" || !BATCH_WHITELIST.has(call.name)) {
        return { status: "error", code: "INVALID_ARGS", message: `calls[${i}].name '${call && call.name}' is not in allowed batch methods` };
      }
      if (call.arguments !== undefined && (typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments))) {
        return { status: "error", code: "INVALID_ARGS", message: `calls[${i}].arguments must be an object` };
      }
    }

    const results = [];
    for (const call of params.calls) {
      const callArgs = { ...(call.arguments || {}) };
      // Both control keys are stripped from every sub-call's arguments, the
      // same way handleMessage strips them from a single call's params: a
      // batch must never become a way to smuggle them into a tool.
      delete callArgs.__gptWorkerActiveTask;
      delete callArgs.__gptWorkerTaskWindow;

      try {
        const subResult = this.dispatch(call.name, callArgs);
        if (subResult && typeof subResult === "object" && ("error" in subResult || subResult.status === "error")) {
          results.push({ id: call.id, name: call.name, ok: false, error: subResult });
        } else {
          results.push({ id: call.id, name: call.name, ok: true, result: subResult });
        }
      } catch (err) {
        results.push({
          id: call.id,
          name: call.name,
          ok: false,
          error: { error: "INTERNAL_ERROR", message: String((err && err.message) || err) },
        });
      }
    }

    return { results };
  }

  /** The single egress point for everything this bridge sends to the
   *  Worker (and from there, ChatGPT): every reply — success or error —
   *  passes through sanitizeResult() before it is serialized. A sanitize
   *  failure (scanner missing/broken, or the fail-closed check in
   *  sanitizeResult) must never let the original, unscanned payload reach
   *  the wire — it is replaced with an error response instead. */
  reply(rid, ok, result) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    let payload;
    try {
      const sanitized = sanitizeResult(result, this.pathContext);
      let value = sanitized.value;
      if (sanitized.redacted > 0 && value && typeof value === "object" && !Array.isArray(value)) {
        value = { ...value, sanitize: { redacted: sanitized.redacted, rules: sanitized.rules, heavilyRedacted: sanitized.heavilyRedacted } };
      }
      payload = ok ? { rid, ok: true, result: value } : { rid, ok: false, error: value };
    } catch (err) {
      const message = redactLocalPaths(String((err && err.message) || err), this.pathContext);
      // A scanner failure is the one error that silently degrades the whole
      // egress guarantee, so it must leave a local trace even though the
      // caller already gets an error response.
      this.log(`sanitize_failed rid=${rid}: ${message}`);
      payload = { rid, ok: false, error: { status: "error", message: `sanitize_failed: ${message}` } };
    }
    try {
      this.ws.send(JSON.stringify(payload));
    } catch {
      /* connection dropped mid-reply; the DO's 20s timeout covers it */
    }
  }

  isConnected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}
