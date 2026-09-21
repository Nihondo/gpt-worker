// Pure helpers for the MCP access history (the dashboard's "MCP Access" tab).
// No SQL, no env, no state — the same layer as worker-http.js — so both
// bridge-mcp.js (which builds an event from a finished tool call) and
// bridge-mcp-access.js (which stores and reads events) can import it without
// breaking the rule that bridge-*.js modules never import each other.
//
// The one thing this module exists to guarantee is what an event may CONTAIN.
// An access-history row is metadata about a call, never a copy of it:
//
//   kept    : tool name, a sanitized workspace-relative target, the kind of
//             outcome, a known outcome code, duration, and the task the DO
//             itself considered active when the call began;
//   dropped : file contents, diffs, search hits, search queries and globs,
//             message bodies and titles, result/warning/error message text,
//             raw arguments or results, absolute paths, secrets.
//
// Every string that reaches a row is either drawn from a closed set (tool,
// connector, outcome, outcome code, a batch sub-call's tool), matched against a
// strict pattern (task id), or built here from a fixed vocabulary plus a path
// that has been through safeWorkspacePath(). Nothing is copied through from the
// call's payload: a value that merely LOOKS like an identifier is not enough.

export const MCP_OUTCOMES = ["success", "gate_denied", "access_denied", "error", "mixed"];
export const MCP_CONNECTORS = ["dedicated", "shared"];
export const MAX_TARGET_CHARS = 240;
export const MAX_DETAILS_BYTES = 4096;
export const MAX_BATCH_DETAIL_CALLS = 8;

/** Every tool name the connector can record. A name outside this list (ChatGPT
 *  can send any string) is stored as "unknown", never as the string it sent.
 *  tests/mcp-access.test.mjs keeps this equal to tools.json plus list_workspaces. */
export const MCP_TOOL_NAMES = [
  "workspace_info", "workspace_guidance", "workspace_overview", "list_directory", "read_file",
  "search_workspace", "git_status", "git_diff", "git_log", "execution_output", "workspace_batch", "workspace_bundle",
  "operating_instructions", "next_task", "submit_plan", "set_title", "task_history", "list_workspaces",
];

/** The tools a workspace_batch sub-call may name (bridge/link.mjs's BATCH_WHITELIST). */
export const MCP_BATCH_TOOL_NAMES = [
  "workspace_info", "workspace_overview", "list_directory", "read_file",
  "search_workspace", "git_status", "git_diff", "git_log", "execution_output",
];

/** The only reason codes that are ever stored. Each is a fixed identifier the
 *  Worker or the local bridge defines; a code outside this set — including one
 *  that merely looks like an identifier — is stored as "UNKNOWN", so nothing a
 *  result happens to contain can reach the audit table. An ACCESS_DENIED_* code
 *  this list does not know collapses to the generic "ACCESS_DENIED". */
export const MCP_OUTCOME_CODES = [
  "NO_ACTIVE_TASK", "TASK_WINDOW_EXPIRED", "PARTIAL", "ERROR", "UNKNOWN", "UNKNOWN_METHOD",
  "ACCESS_DENIED", "ACCESS_DENIED_SENSITIVE_FILE", "ACCESS_DENIED_GITIGNORED_FILE", "ACCESS_DENIED_EXPLICIT_READ",
  "OUT_OF_WORKSPACE",
  "LOCAL_OFFLINE", "LOCAL_DISCONNECTED", "LOCAL_TIMEOUT", "LOCAL_TOOL_ERROR",
  "INVALID_ARGS", "INVALID_ITERATION", "INVALID_STATE", "INVALID_TITLE", "TITLE_ALREADY_SET",
  "NOT_FOUND", "NOT_A_DIRECTORY", "ENOENT", "ENOTDIR", "BINARY_FILE",
  "GIT_ERROR", "GIT_TIMEOUT", "SEARCH_TIMEOUT", "SEARCH_FAILED",
  "BUNDLE_TOO_LARGE", "BUNDLE_SCAN_FAILED", "ARCHIVE_TIMEOUT", "ARCHIVE_FAILED",
  "UNKNOWN_TOOL", "UNKNOWN_WORKSPACE", "WORKSPACE_UNAVAILABLE", "NO_MATCHING_TASK",
  "BODY_TOO_LARGE", "PAYLOAD_TOO_LARGE", "PARSE_ERROR", "INTERNAL_ERROR",
];
const OUTCOME_CODE_SET = new Set(MCP_OUTCOME_CODES);
const BATCH_TOOL_SET = new Set(MCP_BATCH_TOOL_NAMES);
const TOOL_NAME_SET = new Set(MCP_TOOL_NAMES);

const OUTSIDE_PATH_LABEL = "invalid/outside workspace path";
const ROOT_LABEL = "workspace root";
const TASK_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z_-]{7,63}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function truncateCodePoints(text, maxChars) {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : chars.slice(0, maxChars - 1).join("") + "…";
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** A workspace-relative path that is safe to show and store, or null.
 *
 *  Refused (null): anything that is not a string, control characters and NUL,
 *  absolute paths (POSIX, backslash-rooted, drive-letter and UNC), URL-shaped
 *  values, and any `..` segment. Kept paths are normalized to `/` separators
 *  with empty and `.` segments removed, and capped in length. A local absolute
 *  path can carry a username, so it is never stored even when the bridge would
 *  have treated it as a workspace-relative one. */
export function safeWorkspacePath(input) {
  if (typeof input !== "string") return null;
  if (CONTROL_CHARS.test(input)) return null;
  if (input.startsWith("/") || input.startsWith("\\") || /^[A-Za-z]:/.test(input) || input.includes("://")) return null;
  const segments = input.replace(/\\/g, "/").split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) return null;
  return truncateCodePoints(segments.join("/"), MAX_TARGET_CHARS);
}

/** How a path argument is shown: the path, "workspace root" for none/empty, or a
 *  fixed label for one that could not be made safe. */
function pathLabel(input) {
  if (input === undefined || input === null || input === "") return ROOT_LABEL;
  const safe = safeWorkspacePath(input);
  if (safe === null) return OUTSIDE_PATH_LABEL;
  return safe === "" ? ROOT_LABEL : safe;
}

function optionalPathSuffix(input) {
  if (input === undefined || input === null || input === "") return "";
  const label = pathLabel(input);
  return label === ROOT_LABEL ? "" : ` · ${label}`;
}

/** A short, human-readable description of what a call was about. Built from a
 *  fixed vocabulary plus sanitized paths and small integers — never from a
 *  search query, a glob, a message body or a title. Null when there is nothing
 *  useful to say. */
export function summarizeTarget(tool, args) {
  const a = plainObject(args);
  switch (tool) {
    case "list_directory":
      return pathLabel(a.path);
    case "read_file": {
      const label = pathLabel(a.path);
      return Number.isInteger(a.offset) && a.offset > 0 ? `${label} (from line ${a.offset + 1})` : label;
    }
    case "search_workspace":
      return "workspace search";
    case "git_status":
      return "working tree";
    case "git_diff":
      return `${a.staged === true ? "staged diff" : "working tree diff"}${optionalPathSuffix(a.path)}`;
    case "git_log":
      return `git history${optionalPathSuffix(a.path)}`;
    case "execution_output": {
      const task = typeof a.task_id === "string" && TASK_ID_PATTERN.test(a.task_id) ? `task ${a.task_id.slice(0, 8)}` : "task output";
      return Number.isInteger(a.iteration) && a.iteration >= 0 ? `${task} · iteration ${a.iteration}` : task;
    }
    case "workspace_info":
      return "workspace info";
    case "workspace_overview":
      return "AGENTS.md / CLAUDE.md";
    case "workspace_guidance":
      return "workspace guidance";
    case "workspace_bundle":
      return `workspace archive${optionalPathSuffix(a.path)}`;
    case "workspace_batch":
      return Array.isArray(a.calls) ? `${a.calls.length} call${a.calls.length === 1 ? "" : "s"}` : "batch";
    case "next_task":
      return "fetch next task";
    case "submit_plan": {
      const state = ["PLAN", "DONE", "BLOCKED"].includes(a.state) ? a.state : "reply";
      return Number.isInteger(a.iteration) && a.iteration >= 0 ? `${state} · iteration ${a.iteration}` : state;
    }
    case "set_title":
      return "set task title";
    case "task_history":
      return "task history";
    default:
      return null;
  }
}

function normalizeCode(code) {
  if (typeof code !== "string") return "UNKNOWN";
  if (OUTCOME_CODE_SET.has(code)) return code;
  return code.startsWith("ACCESS_DENIED") ? "ACCESS_DENIED" : "UNKNOWN";
}

/** Classifies one payload (a tool's structured result, or one batch sub-result)
 *  into an outcome and a code. The code is always a known identifier, never text
 *  copied from a message. */
function classifyPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { outcome: "success", code: null };
  if (payload.status === "no_active_task") return { outcome: "gate_denied", code: "NO_ACTIVE_TASK" };
  if (payload.status === "task_window_expired") return { outcome: "gate_denied", code: "TASK_WINDOW_EXPIRED" };
  if (typeof payload.error === "string") {
    const code = normalizeCode(payload.error);
    const denied = code.startsWith("ACCESS_DENIED") || code === "OUT_OF_WORKSPACE";
    return { outcome: denied ? "access_denied" : "error", code };
  }
  if (payload.status === "error" || payload.status === "unknown_method") {
    return { outcome: "error", code: normalizeCode(typeof payload.code === "string" ? payload.code : String(payload.status).toUpperCase()) };
  }
  return { outcome: "success", code: payload.partial === true ? "PARTIAL" : null };
}

function summarizeBatch(structured, args) {
  const calls = Array.isArray(plainObject(args).calls) ? args.calls : [];
  const results = structured.results;
  const subcalls = results.slice(0, MAX_BATCH_DETAIL_CALLS).map((item, index) => {
    const entry = plainObject(item);
    // The call this result belongs to, by position: results keep input order.
    // The tool name comes from the INPUT call and must be one a batch may run —
    // never from the result, which is data the local side produced.
    const call = plainObject(calls[index]);
    const tool = typeof call.name === "string" && BATCH_TOOL_SET.has(call.name) ? call.name : "unknown";
    const verdict = entry.ok === true ? classifyPayload(entry.result) : classifyPayload(entry.error);
    // A sub-call that failed is an error even if its payload had no error shape.
    const outcome = entry.ok === true ? verdict.outcome : verdict.outcome === "success" ? "error" : verdict.outcome;
    const code = entry.ok === true ? verdict.code : verdict.code || "ERROR";
    return { tool, target: summarizeTarget(tool, call.arguments), outcome, code };
  });
  const outcomes = new Set(subcalls.map((subcall) => subcall.outcome));
  let outcome = "success";
  let code = null;
  if (outcomes.size === 1) {
    outcome = subcalls[0] ? subcalls[0].outcome : "success";
    code = outcome === "success" ? null : subcalls[0].code;
  } else if (outcomes.size > 1) {
    outcome = "mixed";
  }
  return { outcome, code, details: { calls: subcalls } };
}

/** Outcome, code and (for a batch) per-call details for a finished tool call.
 *  `result` is the MCP tool response as invokeTool returns it. */
export function classifyResult(tool, result, args) {
  const response = plainObject(result);
  const structured = response.structuredContent;
  if (response.isError === true) {
    return { outcome: "error", code: normalizeCode(plainObject(structured).error), details: null };
  }
  if (tool === "workspace_batch" && structured && Array.isArray(structured.results)) {
    return summarizeBatch(structured, args);
  }
  const verdict = classifyPayload(structured);
  return { outcome: verdict.outcome, code: verdict.code, details: null };
}

/** Serializes details for storage, keeping them within MAX_DETAILS_BYTES by
 *  dropping the (longest) targets before dropping the calls themselves. */
export function serializeDetails(details) {
  if (!details) return null;
  // Bytes, not characters: a path of multi-byte characters is several times longer in storage.
  const fits = (text) => new TextEncoder().encode(text).length <= MAX_DETAILS_BYTES;
  let text = JSON.stringify(details);
  if (fits(text)) return text;
  text = JSON.stringify({ calls: details.calls.map((call) => ({ ...call, target: null })) });
  return fits(text) ? text : null;
}

/** The row for one finished tool call. Everything in it is drawn from a closed
 *  set, matched against a strict pattern, or built by summarizeTarget(). */
export function buildMcpAccessEvent({ tool, connector, args, result, startedAt, finishedAt, taskId }) {
  const { outcome, code, details } = classifyResult(tool, result, args);
  const started = Number.isFinite(startedAt) ? startedAt : Date.now();
  const finished = Number.isFinite(finishedAt) ? finishedAt : started;
  return {
    startedAt: started,
    durationMs: Math.min(Math.max(Math.round(finished - started), 0), 3_600_000),
    toolName: TOOL_NAME_SET.has(tool) ? tool : "unknown",
    connector: MCP_CONNECTORS.includes(connector) ? connector : "dedicated",
    taskId: typeof taskId === "string" && TASK_ID_PATTERN.test(taskId) ? taskId : null,
    target: summarizeTarget(tool, args),
    outcome: MCP_OUTCOMES.includes(outcome) ? outcome : "error",
    outcomeCode: code === null ? null : normalizeCode(code),
    detailsJson: serializeDetails(details),
  };
}
