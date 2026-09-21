// Stateless browser-side dashboard helpers. Keep this module free of network
// access and mutable workspace state so both dashboard entry modules share one
// canonical rendering contract.
export var LIST_PREVIEW_CHARS = 180;

export function el(tag, opts) {
  var e = document.createElement(tag);
  opts = opts || {};
  if (opts.className) e.className = opts.className;
  if (opts.text !== undefined) e.textContent = opts.text;
  return e;
}

// Never innerHTML, even to clear — every element here is either built fresh
// via el()/textContent above or removed one node at a time.
export function clearEl(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function fmtTime(ms) {
  if (!ms) return "";
  try { return new Date(ms).toLocaleString(); } catch (e) { return String(ms); }
}

export function formatTimelineTime(ms) {
  if (!ms) return "";
  var d = new Date(ms);
  if (isNaN(d.getTime())) return String(ms);
  function pad(n) { return String(n).padStart(2, "0"); }
  return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

export function truncateText(value, maxChars) {
  var s = String(value == null ? "" : value);
  var chars = Array.from(s);
  if (chars.length <= maxChars) return { text: s, truncated: false };
  return { text: chars.slice(0, maxChars).join("") + "…", truncated: true };
}

export function taskListLabel(task) {
  return typeof task.title === "string" && task.title ? task.title : truncateText(task.goal, LIST_PREVIEW_CHARS).text;
}

export function messageListLabel(message) {
  return typeof message.title === "string" && message.title ? message.title : truncateText(message.body, LIST_PREVIEW_CHARS).text;
}

export function taskStage(t) {
  if (t.protocolState === "WAITING_PLAN") return { node: "web", label: "Waiting for Web plan" };
  if (t.protocolState === "EXECUTING") return { node: "local", label: "Executing locally" };
  if (t.protocolState === "WAITING_REVIEW") return { node: "web", label: "Waiting for Web review" };
  if (t.protocolState === "WAITING_LOCAL") {
    if (t.waitingFor === "LOCAL_PLAN_ACK") return { node: "local", label: "Waiting for Local to receive plan" };
    if (t.waitingFor === "LOCAL_DONE_ACK") return { node: "local", label: "Waiting for Local to receive completion" };
    if (t.waitingFor === "LOCAL_BLOCKED_ACK") return { node: "local", label: "Waiting for Local to receive blocker" };
    if (t.waitingFor === "LOCAL_DECISION") return { node: "local", label: "Waiting for Local decision" };
    return { node: "local", label: "Waiting for Local" };
  }
  if (t.protocolState === "DONE") return { node: null, label: "Done", terminal: true };
  if (t.protocolState === "BLOCKED") return { node: null, label: t.waitingFor === "USER" ? "Blocked — needs user" : "Blocked", terminal: true, blocked: true };
  return { node: null, label: t.protocolState || "Unknown" };
}

export function messageStage(m) {
  var destNode = m.dir === "to_gpt" ? "web" : "local";
  var destLabel = m.dir === "to_gpt" ? "Web" : "Local";
  if (m.state === "pending") return { node: "hub", label: "Queued for " + destLabel };
  if (m.state === "leased") return m.dir === "to_gpt" ? { node: "web", label: "Web reading" } : { node: "hub", label: "Queued for " + destLabel };
  if (m.state === "acked") return { node: destNode, label: "Consumed by " + destLabel, terminal: true };
  return { node: null, label: m.state || "Unknown" };
}

export function renderStageIndicator(stage, opts) {
  opts = opts || {};
  var wrap = el("div", { className: "stage-indicator" + (opts.small ? " small" : "") });
  wrap.setAttribute("aria-label", "Stage: " + stage.label);
  [{ key: "web", text: "Web" }, { key: "hub", text: "Hub" }, { key: "local", text: "Local" }].forEach(function (n, i, arr) {
    var cls = "stage-node";
    if (stage.node === n.key) cls += " current";
    else if (stage.terminal) cls += " complete";
    wrap.appendChild(el("span", { className: cls, text: n.text }));
    if (i < arr.length - 1) wrap.appendChild(el("span", { className: "stage-connector" }));
  });
  wrap.appendChild(el("span", { className: "stage-label" + (stage.blocked ? " blocked" : ""), text: stage.label }));
  return wrap;
}

export function taskHistoryKindClass(kind) {
  if (kind === "INIT") return "init";
  if (kind === "PLAN") return "plan";
  if (kind === "EXECUTED") return "executed";
  if (kind === "DONE") return "done";
  if (kind === "BLOCKED") return "blocked";
  return "other";
}

export function mergeRows(existing, fresh, idKey, comparator) {
  var byId = {};
  existing.forEach(function (r) { byId[r[idKey]] = r; });
  fresh.forEach(function (r) { byId[r[idKey]] = r; });
  var merged = Object.keys(byId).map(function (key) { return byId[key]; });
  merged.sort(comparator);
  return merged;
}

export function taskComparator(a, b) {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return b.taskId > a.taskId ? 1 : b.taskId < a.taskId ? -1 : 0;
}

export function messageComparator(a, b) {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return b.messageId > a.messageId ? 1 : b.messageId < a.messageId ? -1 : 0;
}

// ---------------------------------------------------------------------------
// MCP access history ("MCP Access" tab). Pure presentation helpers: turn the
// metadata rows the Worker stores (tool name, outcome kind, a known outcome
// code, a sanitized target) into words a person can read. Nothing here fetches
// or holds state, and everything that reaches the DOM later goes through el()/
// textContent — the strings below are ours, and the row values are shown as
// text, never as markup.
// ---------------------------------------------------------------------------

var MCP_TOOL_LABELS = {
  read_file: "Read file",
  list_directory: "List directory",
  search_workspace: "Search",
  git_status: "Git status",
  git_diff: "Git diff",
  git_log: "Git log",
  execution_output: "Execution output",
  workspace_bundle: "Workspace bundle",
  workspace_info: "Workspace info",
  workspace_overview: "Project overview",
  workspace_guidance: "Guidance",
  workspace_batch: "Batch",
  next_task: "Fetch task",
  submit_plan: "Send reply",
  set_title: "Set title",
  task_history: "Task history",
};

export function mcpToolLabel(name) {
  return MCP_TOOL_LABELS[name] || String(name || "Unknown tool");
}

// Result kinds are shown as words, not only as a color, so they read the same
// for everyone and in a printout.
var MCP_OUTCOMES = {
  success: { label: "OK", className: "mcp-outcome-success" },
  gate_denied: { label: "Blocked", className: "mcp-outcome-gate" },
  access_denied: { label: "Denied", className: "mcp-outcome-denied" },
  error: { label: "NG", className: "mcp-outcome-error" },
  mixed: { label: "Mix", className: "mcp-outcome-mixed" },
};

export function mcpOutcomeInfo(outcome) {
  return MCP_OUTCOMES[outcome] || { label: String(outcome || "Unknown"), className: "mcp-outcome-error" };
}

var MCP_CODE_TEXT = {
  NO_ACTIVE_TASK: "No active task — reading stays closed until one starts",
  TASK_WINDOW_EXPIRED: "The task's read window went idle — the operator has to advance the task",
  ACCESS_DENIED_SENSITIVE_FILE: "Sensitive file — never readable",
  ACCESS_DENIED_GITIGNORED_FILE: "Git-ignored file — not readable unless the owner allows it",
  ACCESS_DENIED_EXPLICIT_READ: "Blocked by the owner's deny-read setting",
  ACCESS_DENIED: "Access denied by the workspace's read policy",
  OUT_OF_WORKSPACE: "Path is outside the workspace",
  LOCAL_OFFLINE: "The local bridge was not connected",
  LOCAL_DISCONNECTED: "The local bridge disconnected mid-call",
  LOCAL_TIMEOUT: "The local bridge did not answer in time",
  LOCAL_TOOL_ERROR: "The local bridge reported an error",
  SEARCH_TIMEOUT: "The search took too long",
  SEARCH_FAILED: "The search failed (for example a malformed pattern)",
  GIT_TIMEOUT: "Git did not answer in time",
  GIT_ERROR: "Git reported an error",
  NOT_FOUND: "File or directory not found",
  BINARY_FILE: "Binary file — content not shown",
  INVALID_ARGS: "The call's arguments were invalid",
  INTERNAL_ERROR: "Internal error in the Worker",
  NO_MATCHING_TASK: "The reply did not match an open task",
  PARTIAL: "The result was partial or possibly incomplete",
};

/** A sentence for an outcome code, or the code itself when it is not one we know
 *  (the Worker only ever stores identifier-shaped codes), or null for none. */
export function mcpCodeText(code) {
  if (!code) return null;
  return MCP_CODE_TEXT[code] || String(code);
}

export function mcpTaskLabel(taskId) {
  return taskId ? "task " + String(taskId).slice(0, 8) : "no active task";
}

export function formatDuration(ms) {
  var n = Number(ms);
  if (!isFinite(n) || n < 0) return "";
  if (n < 1000) return Math.round(n) + " ms";
  return (n / 1000).toFixed(n < 10000 ? 1 : 0) + " s";
}

export function mcpComparator(a, b) {
  if (a.startedAt !== b.startedAt) return b.startedAt - a.startedAt;
  return b.eventId - a.eventId;
}

// Reads that follow one another are the noise: one task can make dozens of
// read_file calls in a minute. Successful reads of the same task, each within
// this gap of the next, are shown as one row. A denial or an error is never
// folded in — it is the thing you are looking for.
export var MCP_GROUP_GAP_MS = 30000;
var MCP_GROUPABLE_TOOLS = { read_file: true };

/** Turns newest-first events into display items: single events, and groups of
 *  two or more consecutive successful reads. The grouping is a view over the
 *  events that are loaded; it never changes which events exist. */
export function groupMcpEvents(events) {
  var items = [];
  var run = [];
  function flush() {
    if (run.length >= 2) {
      // The id is the OLDEST member's: newer reads join a run at the top, so this id
      // stays put and a selected group stays selected as the run grows.
      items.push({ type: "group", id: "group-" + run[run.length - 1].eventId, events: run, newest: run[0], oldest: run[run.length - 1], count: run.length });
    } else if (run.length === 1) {
      items.push({ type: "event", id: "event-" + run[0].eventId, event: run[0] });
    }
    run = [];
  }
  events.forEach(function (event) {
    var groupable = MCP_GROUPABLE_TOOLS[event.toolName] === true && event.outcome === "success";
    if (!groupable) {
      flush();
      items.push({ type: "event", id: "event-" + event.eventId, event: event });
      return;
    }
    var last = run[run.length - 1];
    if (last && (last.toolName !== event.toolName || last.connector !== event.connector || last.taskId !== event.taskId || last.startedAt - event.startedAt > MCP_GROUP_GAP_MS)) flush();
    run.push(event);
  });
  flush();
  return items;
}

/** The one-line summary shown under a row's title. */
export function mcpEventLine(event) {
  var code = mcpCodeText(event.outcomeCode);
  if (event.outcome === "success") return event.target || "";
  if (event.outcome === "mixed") return event.target || "";
  return code ? (event.target ? event.target + " — " + code : code) : (event.target || "");
}
