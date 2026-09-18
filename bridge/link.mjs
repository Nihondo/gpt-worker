// WebSocket reverse-connection to the Worker's /link/<workspace_id>/<LINK_TOKEN> endpoint.
// Reconnects with exponential backoff (1s -> 30s) so a bridge restart, laptop
// sleep, or network blip never requires touching the ChatGPT connector again.
//
// Access gating (6.5 of the plan): while no task is active, the 6 tools that
// can reveal file/diff content answer {"status":"no_active_task"} without
// running. `workspace_info` is exempt — it only reveals workspace identity
// (name/branch/languages), which the Phase-5 first-connection check needs to
// work before any task has ever been created.

import os from "node:os";
import { WorkspaceTools } from "./tools.mjs";
import { appendLog } from "./state.mjs";
import { sanitizeText, redactLocalPaths } from "./sanitize.mjs";

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const GATED_METHODS = new Set(["workspace_overview", "list_directory", "read_file", "search_workspace", "git_status", "git_diff", "git_log", "execution_output"]);

// Internal-only join marker used while batching every string field of one
// reply into a single scanner invocation (see sanitizeResult() below). A
// control character essentially never present in real file/diff/log
// content, so it can't be mistaken for a field boundary by any secret
// pattern's character class. Never sent over the wire.
const FIELD_SEP = "\x1e";

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
    // cmdStart's --__daemon wiring in cli.mjs); it is never surfaced back
    // through this RPC.
    if (method === "dashboard_task_created") {
      this.reply(rid, true, {});
      try {
        // Swallow both a synchronous throw and an async rejection here —
        // the real callback (cli.mjs's handleDashboardTaskCreated) already
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
    const workerSaysTaskIsActive = !!(params && params.__gptWorkerActiveTask);
    if (params && typeof params === "object") delete params.__gptWorkerActiveTask;
    if (GATED_METHODS.has(method) && !this.alwaysAllow && !workerSaysTaskIsActive) {
      this.reply(rid, true, { status: "no_active_task" });
      return;
    }

    try {
      const result = this.dispatch(method, params || {});
      this.reply(rid, true, result);
    } catch (err) {
      this.reply(rid, false, { status: "error", message: String((err && err.message) || err) });
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
      default:
        return { status: "unknown_method", method };
    }
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
