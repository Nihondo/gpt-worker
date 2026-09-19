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
