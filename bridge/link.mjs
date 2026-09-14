// WebSocket reverse-connection to the Worker's /link/<workspace_id>/<LINK_TOKEN> endpoint.
// Reconnects with exponential backoff (1s -> 30s) so a bridge restart, laptop
// sleep, or network blip never requires touching the ChatGPT connector again.
//
// Access gating (6.5 of the plan): while no task is active, the 6 tools that
// can reveal file/diff content answer {"status":"no_active_task"} without
// running. `workspace_info` is exempt — it only reveals workspace identity
// (name/branch/languages), which the Phase-5 first-connection check needs to
// work before any task has ever been created.

import { WorkspaceTools } from "./tools.mjs";
import { appendLog } from "./state.mjs";

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const GATED_METHODS = new Set(["list_directory", "read_file", "search_workspace", "git_status", "git_diff", "git_log", "execution_output"]);

export class BridgeLink {
  constructor({ workerUrl, workspaceId, linkToken, workspaceRoot, alwaysAllow, onPlanPushed }) {
    this.url = `${workerUrl.replace(/\/$/, "")}/link/${workspaceId}/${linkToken}`;
    this.root = workspaceRoot;
    this.alwaysAllow = !!alwaysAllow;
    this.onPlanPushed = onPlanPushed || (() => {});
    this.tools = new WorkspaceTools(workspaceRoot);
    this.ws = null;
    this.backoff = MIN_BACKOFF_MS;
    this.stopped = false;
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

  reply(rid, ok, result) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(ok ? { rid, ok: true, result } : { rid, ok: false, error: result }));
    } catch {
      /* connection dropped mid-reply; the DO's 20s timeout covers it */
    }
  }

  isConnected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}
