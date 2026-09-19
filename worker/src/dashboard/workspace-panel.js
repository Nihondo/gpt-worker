import {
  clearEl, el, fmtTime, formatTimelineTime, messageComparator, messageListLabel,
  messageStage, mergeRows, renderStageIndicator, taskComparator, taskHistoryKindClass,
  taskListLabel, taskStage,
} from "./common-app.js";

// Selected-workspace controller shared by the direct workspace and hub shells.
// The adapter owns target routing and freshness; this module never reads hub
// state or assumes a particular dashboard URL.
export function createWorkspacePanel(adapter) {
  var currentTarget = null;
  var state = {};

  function isCurrent(target) { return currentTarget === target && adapter.isCurrent(target); }
  function request(target, path, options) { return adapter.request(target, path, options); }
  function reset() {
    state = {
      activeTaskId: null, messagesCursor: null, tasksCursor: null,
      tasksExpanded: false, messagesExpanded: false, tasks: [], messages: [],
      selectedTaskId: null, selectedMessageId: null, selectedTask: null, selectedMessage: null,
      selectedTaskRowEl: null, selectedMessageRowEl: null,
      taskHistoryTaskId: null, taskHistoryItems: [], taskHistoryLoading: false,
      taskHistoryError: null, taskHistoryRequestGen: (state.taskHistoryRequestGen || 0) + 1,
      activitySubview: "tasks",
    };
  }
  function node(id) { return document.getElementById(id); }
  function jsonOptions(body) { return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }; }
  function clearPanel() {
    ["overview", "tasks-list", "messages-list", "tasks-detail", "messages-detail"].forEach(function (id) { var n = node(id); if (n) clearEl(n); });
    node("tasks-load-more").hidden = true;
    node("messages-load-more").hidden = true;
  }
  function threePane() { return document.querySelector(".three-pane"); }
  function openDetail() { threePane().classList.add("detail-open"); }
  function closeDetail() { threePane().classList.remove("detail-open"); }
  function renderDetailPane(kind, content) { var d = node(kind + "-detail"); clearEl(d); d.appendChild(content); }
  function renderBackButton(kind) {
    var btn = el("button", { className: "secondary detail-back", text: "← Back to list" });
    btn.addEventListener("click", function () { closeDetail(); var row = kind === "tasks" ? state.selectedTaskRowEl : state.selectedMessageRowEl; if (row && row.focus) row.focus(); });
    return btn;
  }
  function renderTextSection(containerId, label, fullText) {
    var wrap = el("div", { className: "detail-section" });
    if (label) wrap.appendChild(el("h3", { text: label }));
    var body = el("pre", { className: "detail-body" });
    body.id = containerId;
    body.textContent = String(fullText == null ? "" : fullText);
    wrap.appendChild(body);
    return wrap;
  }

  function setActivityTab(which) {
    var changed = state.activitySubview !== which;
    state.activitySubview = which;
    node("tab-tasks").setAttribute("aria-selected", which === "tasks" ? "true" : "false");
    node("tab-messages").setAttribute("aria-selected", which === "messages" ? "true" : "false");
    node("tasks-list-col").hidden = which !== "tasks";
    node("tasks-detail").hidden = which !== "tasks";
    node("messages-list-col").hidden = which !== "messages";
    node("messages-detail").hidden = which !== "messages";
    closeDetail();
    if (changed && currentTarget) {
      if (which === "tasks") loadTasks(currentTarget, false);
      else if (which === "messages") loadMessages(currentTarget, false);
    }
  }
  node("tab-tasks").addEventListener("click", function () { setActivityTab("tasks"); });
  node("tab-messages").addEventListener("click", function () { setActivityTab("messages"); });

  function renderOverview(data) {
    var prevActive = Boolean(state.activeTaskId);
    var overview = node("overview"); clearEl(overview);
    var row = el("div", { className: "row" });
    row.appendChild(el("span", { text: "Bridge: " + (data.connected ? "connected" : "not connected") }));
    row.appendChild(el("span", { text: "Queued to ChatGPT: " + data.pendingToGpt }));
    row.appendChild(el("span", { text: "Queued to local: " + data.pendingToLocal })); overview.appendChild(row);
    var taskLine = el("p", { className: "meta" });
    if (data.activeTask) { state.activeTaskId = data.activeTask.taskId; taskLine.textContent = "Active task: " + data.activeTask.taskId + " (" + data.activeTask.protocolState + ")"; }
    else { state.activeTaskId = null; taskLine.textContent = "No active task."; }
    overview.appendChild(taskLine);
    overview.appendChild(el("p", { className: "meta", text: "Guidance set: " + (data.guidanceSet ? "yes" : "no") + " · Body limit: " + data.maxBodyBytes + " bytes" }));
    if (adapter.onActivityStateChanged && prevActive !== Boolean(state.activeTaskId)) {
      adapter.onActivityStateChanged(Boolean(state.activeTaskId), currentTarget);
    }
  }
  function loadOverview(target) { return request(target, "/overview").then(function (res) { if (res.ok && isCurrent(target)) renderOverview(res.body); }); }
  function loadGuidance(target) { return request(target, "/guidance").then(function (res) { if (res.ok && isCurrent(target)) node("guidance-text").value = res.body.guidance || ""; }); }
  function loadLimits(target) { return request(target, "/limits").then(function (res) { if (res.ok && isCurrent(target)) node("limits-value").value = res.body.maxBodyBytes; }); }
  function loadBrowserSettings(target) {
    return request(target, "/browser-settings").then(function (res) {
      if (!res.ok || !isCurrent(target)) return;
      node("chat-project-override").value = res.body.chatUrlOverride || "";
      node("conversation-url").value = res.body.conversationUrl || "";
      node("chat-project-override").placeholder = res.body.sharedChatUrl ? res.body.sharedChatUrl + " (shared default)" : "https://chatgpt.com/g/g-p-.../project (leave empty for shared default)";
    });
  }
  node("guidance-save").addEventListener("click", function () { var target = currentTarget; request(target, "/guidance", jsonOptions({ text: node("guidance-text").value })); });
  node("guidance-clear").addEventListener("click", function () { var target = currentTarget; request(target, "/guidance", jsonOptions({ clear: true })).then(function () { if (isCurrent(target)) node("guidance-text").value = ""; }); });
  node("limits-save").addEventListener("click", function () { var target = currentTarget; request(target, "/limits", jsonOptions({ maxBodyBytes: Number(node("limits-value").value) })).then(function () { if (isCurrent(target)) loadLimits(target); }); });
  node("limits-reset").addEventListener("click", function () { var target = currentTarget; request(target, "/limits", jsonOptions({ maxBodyBytes: null })).then(function () { if (isCurrent(target)) loadLimits(target); }); });
  function saveBrowserSetting(field, value, errorId, failure) {
    var target = currentTarget, error = node(errorId); error.hidden = true; error.textContent = "";
    request(target, "/browser-settings", jsonOptions(field === "chatUrlOverride" ? { chatUrlOverride: value } : { conversationUrl: value })).then(function (res) {
      if (!isCurrent(target)) return;
      if (!res.ok || res.body.error) { error.hidden = false; error.textContent = res.body.message || res.body.error || failure; }
      else loadBrowserSettings(target);
    });
  }
  node("chat-project-override-save").addEventListener("click", function () { saveBrowserSetting("chatUrlOverride", node("chat-project-override").value.trim() || null, "chat-project-override-error", "Failed to save project override."); });
  node("chat-project-override-clear").addEventListener("click", function () { saveBrowserSetting("chatUrlOverride", null, "chat-project-override-error", "Failed to clear project override."); });
  node("conversation-url-save").addEventListener("click", function () { saveBrowserSetting("conversationUrl", node("conversation-url").value.trim() || null, "conversation-url-error", "Failed to save conversation URL."); });
  node("conversation-url-clear").addEventListener("click", function () { saveBrowserSetting("conversationUrl", null, "conversation-url-error", "Failed to reset conversation."); });
  node("new-task-submit").addEventListener("click", function () {
    var target = currentTarget, goal = node("new-task-goal").value, force = node("new-task-force").checked, status = node("new-task-status");
    if (!goal.trim()) { status.textContent = "Goal is required."; return; }
    if (force && !confirm("This will BLOCK the currently active task. Continue?")) return;
    status.textContent = "Starting…";
    request(target, "/start-task", jsonOptions({ goal: goal, force: force })).then(function (res) {
      if (!isCurrent(target)) return;
      if (!res.ok || res.body.error) { status.textContent = "Failed: " + (res.body.error || res.status); return; }
      status.textContent = "Task " + res.body.task.taskId + " queued. Browser notification: " + ((res.body.nudge && res.body.nudge.status) || "unknown") + ".";
      node("new-task-goal").value = ""; node("new-task-force").checked = false; refreshAll();
      if (adapter.onTaskStarted) adapter.onTaskStarted(target);
    });
  });

  function renderTaskHistory(t) {
    var wrap = el("section", { className: "task-history" }); wrap.appendChild(el("h3", { text: "Exchange history" }));
    if (state.taskHistoryTaskId !== t.taskId || state.taskHistoryLoading) { wrap.appendChild(el("p", { className: "note", text: "Loading retained exchange history…" })); return wrap; }
    if (state.taskHistoryError) { wrap.appendChild(el("p", { className: "error", text: "Could not load exchange history." })); return wrap; }
    if (!state.taskHistoryItems.length) { wrap.appendChild(el("p", { className: "note", text: "No retained exchange history. Older acknowledged events may have expired." })); return wrap; }
    var list = el("ol", { className: "task-history-list" }); list.setAttribute("role", "list");
    state.taskHistoryItems.forEach(function (m) {
      var row = el("li", { className: "task-history-row task-history-kind-" + taskHistoryKindClass(m.kind) });
      row.appendChild(el("span", { className: "task-history-time", text: formatTimelineTime(m.createdAt) })); row.appendChild(el("strong", { className: "task-history-kind", text: m.kind || "UNKNOWN" })); row.appendChild(el("span", { className: "task-history-iteration", text: "Iteration " + m.iteration }));
      var title = typeof m.title === "string" && m.title ? m.title : (m.kind === "INIT" && typeof t.title === "string" && t.title ? t.title : ""); if (title) row.appendChild(el("span", { className: "task-history-title", text: title })); list.appendChild(row);
    });
    wrap.appendChild(list); wrap.appendChild(el("p", { className: "note", text: "Acknowledged events are retained for a limited time." })); return wrap;
  }
  function isCurrentTaskHistory(target, taskId, requestGen) { return isCurrent(target) && state.selectedTaskId === taskId && state.taskHistoryTaskId === taskId && state.taskHistoryRequestGen === requestGen; }
  function renderSelectedTaskHistory(target) { if (isCurrent(target) && state.selectedTask && state.selectedTaskId === state.selectedTask.taskId) renderDetailPane("tasks", renderTaskDetail(state.selectedTask, target)); }
  function loadTaskHistory(taskId, target) {
    var requestGen = state.taskHistoryRequestGen + 1; state.taskHistoryRequestGen = requestGen; state.taskHistoryTaskId = taskId; state.taskHistoryItems = []; state.taskHistoryLoading = true; state.taskHistoryError = null;
    var byId = {};
    function loadPage(cursor) {
      var q = "?task_id=" + encodeURIComponent(taskId) + "&limit=100&include_body=0" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
      request(target, "/messages" + q).then(function (res) {
        if (!isCurrentTaskHistory(target, taskId, requestGen)) return;
        if (!res.ok) { state.taskHistoryLoading = false; state.taskHistoryError = true; renderSelectedTaskHistory(target); return; }
        (res.body.messages || []).forEach(function (m) { byId[m.messageId] = m; });
        if (res.body.nextCursor) { loadPage(res.body.nextCursor); return; }
        state.taskHistoryItems = Object.keys(byId).map(function (id) { return byId[id]; }).sort(function (a, b) { return a.createdAt - b.createdAt || String(a.messageId).localeCompare(String(b.messageId)); });
        state.taskHistoryLoading = false; renderSelectedTaskHistory(target);
      }).catch(function () { if (isCurrentTaskHistory(target, taskId, requestGen)) { state.taskHistoryLoading = false; state.taskHistoryError = true; renderSelectedTaskHistory(target); } });
    }
    loadPage(null);
  }

  function renderTaskRow(t, target) { var row = el("button", { className: "list-row" }); row.type = "button"; row.setAttribute("role", "option"); row.setAttribute("aria-selected", state.selectedTaskId === t.taskId ? "true" : "false"); var head = el("div", { className: "row" }); head.appendChild(el("span", { className: "badge", text: t.protocolState })); head.appendChild(el("span", { className: "meta", text: fmtTime(t.updatedAt) })); row.appendChild(head); row.appendChild(el("div", { className: "preview" + (t.title ? " task-title" : ""), text: taskListLabel(t) })); row.addEventListener("click", function () { selectTask(t, target, row); }); return row; }
  function renderTaskDetail(t, target) {
    var wrap = el("div"); wrap.appendChild(renderBackButton("tasks")); var head = el("div", { className: "row" }); head.appendChild(el("span", { className: "badge", text: t.protocolState })); head.appendChild(el("span", { className: "meta", text: "Task " + t.taskId })); wrap.appendChild(head);
    if (t.title) wrap.appendChild(el("p", { className: "meta task-detail-title", text: t.title })); wrap.appendChild(el("p", { className: "meta", text: "Iteration " + t.iteration + " · waiting for " + (t.waitingFor || "none") + " · started " + fmtTime(t.taskStartedAt) + " · updated " + fmtTime(t.updatedAt) })); wrap.appendChild(renderStageIndicator(taskStage(t))); wrap.appendChild(renderTextSection("task-detail-goal", "Goal", t.goal));
    if (t.terminalSummary) wrap.appendChild(renderTextSection("task-detail-summary", (t.protocolState === "DONE" || t.protocolState === "BLOCKED") ? "Terminal summary" : "Proposed completion", t.terminalSummary));
    wrap.appendChild(renderTaskHistory(t));
    if (t.protocolState === "WAITING_LOCAL" && t.waitingFor === "LOCAL_DECISION") { var actions = el("div", { className: "decision-actions" }); [ ["Complete task", "/complete-task"], ["Continue implementation", "/continue-task"] ].forEach(function (item) { var button = el("button", { text: item[0] }); button.addEventListener("click", function () { request(target, item[1], jsonOptions({ taskId: t.taskId })).then(function () { if (isCurrent(target)) refreshAll(); }); }); actions.appendChild(button); }); wrap.appendChild(actions); }
    if (t.protocolState !== "DONE" && t.protocolState !== "BLOCKED") { var discard = el("button", { className: "danger", text: "Discard task" }); discard.addEventListener("click", function () { if (!confirm("Discard task " + t.taskId + "? This marks it BLOCKED and clears its queued messages.")) return; request(target, "/discard-task", jsonOptions({ taskId: t.taskId })).then(function () { if (isCurrent(target)) refreshAll(); }); }); wrap.appendChild(discard); }
    return wrap;
  }
  function selectTask(t, target, rowEl) { var changed = state.selectedTaskId !== t.taskId; state.selectedTaskId = t.taskId; state.selectedTask = t; state.selectedTaskRowEl = rowEl || null; if (changed) loadTaskHistory(t.taskId, target); renderTasksList(target); renderDetailPane("tasks", renderTaskDetail(t, target)); openDetail(); }
  function renderTasksList(target) { var list = node("tasks-list"); clearEl(list); state.tasks.forEach(function (t) { list.appendChild(renderTaskRow(t, target)); }); if (!state.tasks.length) list.appendChild(el("p", { className: "note", text: "No tasks yet." })); }
  function updateSelectedTaskFromRows(rows, target) { if (!state.selectedTaskId) return; var fresh = rows.filter(function (t) { return t.taskId === state.selectedTaskId; })[0]; if (fresh) { var changed = state.selectedTask && state.selectedTask.updatedAt !== fresh.updatedAt; state.selectedTask = fresh; if (changed) loadTaskHistory(fresh.taskId, target); renderDetailPane("tasks", renderTaskDetail(fresh, target)); } }
  function loadTasks(target, more) { var q = "?limit=20" + (more && state.tasksCursor ? "&cursor=" + encodeURIComponent(state.tasksCursor) : ""); return request(target, "/tasks" + q).then(function (res) { if (!res.ok || !isCurrent(target)) return; var rows = res.body.tasks || []; if (more) { state.tasks = mergeRows(state.tasks, rows, "taskId", taskComparator); state.tasksCursor = res.body.nextCursor; state.tasksExpanded = true; } else if (state.tasksExpanded) { if (res.body.nextCursor) state.tasks = mergeRows(state.tasks, rows, "taskId", taskComparator); else { state.tasks = rows; state.tasksCursor = null; state.tasksExpanded = false; } updateSelectedTaskFromRows(rows, target); } else { state.tasks = rows; state.tasksCursor = res.body.nextCursor; updateSelectedTaskFromRows(rows, target); } renderTasksList(target); node("tasks-load-more").hidden = !state.tasksCursor; }); }
  node("tasks-load-more").addEventListener("click", function () { if (currentTarget) loadTasks(currentTarget, true); });

  function renderMessageRow(m, target) { var row = el("button", { className: "list-row" }); row.type = "button"; row.setAttribute("role", "option"); row.setAttribute("aria-selected", state.selectedMessageId === m.messageId ? "true" : "false"); var head = el("div", { className: "row" }); head.appendChild(el("span", { className: "badge", text: m.state })); head.appendChild(el("span", { className: "meta", text: fmtTime(m.createdAt) })); row.appendChild(head); row.appendChild(el("div", { className: "preview" + (m.title ? " message-title" : ""), text: messageListLabel(m) })); row.addEventListener("click", function () { selectMessage(m, target, row); }); return row; }
  function renderMessageDetail(m, target) {
    var wrap = el("div"); wrap.appendChild(renderBackButton("messages")); var head = el("div", { className: "row" }); [m.dir, m.kind, m.state].forEach(function (value) { head.appendChild(el("span", { className: "badge", text: value })); }); wrap.appendChild(head); if (m.title) wrap.appendChild(el("p", { className: "meta message-detail-title", text: m.title })); wrap.appendChild(el("p", { className: "meta", text: "task=" + m.taskId + " iter=" + m.iteration + " " + fmtTime(m.createdAt) })); wrap.appendChild(renderStageIndicator(messageStage(m))); wrap.appendChild(renderTextSection("message-detail-body", "Body", m.body));
    if (m.dir === "to_local" && m.state !== "acked") { var ack = el("button", { text: "Ack" }); ack.addEventListener("click", function () { request(target, "/ack", jsonOptions({ messageId: m.messageId })).then(function () { if (isCurrent(target)) { loadMessages(target, false); loadOverview(target); loadTasks(target, false); } }); }); wrap.appendChild(ack); }
    var canDiscard = m.state !== "acked" && !(state.activeTaskId === m.taskId);
    if (canDiscard) { var discard = el("button", { className: "danger", text: "Discard" }); discard.addEventListener("click", function () { if (!confirm("Discard this message?")) return; request(target, "/discard", jsonOptions({ messageId: m.messageId })).then(function (res) { if (!isCurrent(target)) return; if (res.body && res.body.error === "USE_DISCARD_TASK") alert("This message belongs to the active task; discard the task instead."); if (adapter.discardMessageRefresh === "all") refreshAll(); else loadMessages(target, false); }); }); wrap.appendChild(discard); }
    else if (m.state !== "acked" && state.activeTaskId === m.taskId) wrap.appendChild(el("span", { className: "note", text: "(part of the active task — use \"Discard task\" above)" }));
    return wrap;
  }
  function selectMessage(m, target, rowEl) { state.selectedMessageId = m.messageId; state.selectedMessage = m; state.selectedMessageRowEl = rowEl || null; renderMessagesList(target); renderDetailPane("messages", renderMessageDetail(m, target)); openDetail(); }
  function renderMessagesList(target) { var list = node("messages-list"); clearEl(list); state.messages.forEach(function (m) { list.appendChild(renderMessageRow(m, target)); }); if (!state.messages.length) list.appendChild(el("p", { className: "note", text: "No messages yet." })); }
  function updateSelectedMessageFromRows(rows, target) { if (!state.selectedMessageId) return; var fresh = rows.filter(function (m) { return m.messageId === state.selectedMessageId; })[0]; if (fresh) { state.selectedMessage = fresh; renderDetailPane("messages", renderMessageDetail(fresh, target)); } }
  function loadMessages(target, more) { var q = "?limit=20" + (more && state.messagesCursor ? "&cursor=" + encodeURIComponent(state.messagesCursor) : ""); return request(target, "/messages" + q).then(function (res) { if (!res.ok || !isCurrent(target)) return; var rows = res.body.messages || []; if (more) { state.messages = mergeRows(state.messages, rows, "messageId", messageComparator); state.messagesCursor = res.body.nextCursor; state.messagesExpanded = true; } else if (state.messagesExpanded) { if (res.body.nextCursor) state.messages = mergeRows(state.messages, rows, "messageId", messageComparator); else { state.messages = rows; state.messagesCursor = null; state.messagesExpanded = false; } updateSelectedMessageFromRows(rows, target); } else { state.messages = rows; state.messagesCursor = res.body.nextCursor; updateSelectedMessageFromRows(rows, target); } renderMessagesList(target); node("messages-load-more").hidden = !state.messagesCursor; }); }
  node("messages-load-more").addEventListener("click", function () { if (currentTarget) loadMessages(currentTarget, true); });

  function loadAll() { var target = currentTarget; if (!target) return; return Promise.all([loadOverview(target), loadGuidance(target), loadLimits(target), loadBrowserSettings(target), loadMessages(target, false), loadTasks(target, false)]); }
  function pollActivity() {
    var target = currentTarget;
    if (!target) return;
    var subview = state.activitySubview === "messages" ? loadMessages(target, false) : loadTasks(target, false);
    return Promise.all([loadOverview(target), subview]);
  }
  function refreshAll() { return loadAll(); }
  function hasActiveTask() { return Boolean(state.activeTaskId); }
  function activate(target, options) { currentTarget = target; reset(); if (options && options.clearView) clearPanel(); setActivityTab("tasks"); return loadAll(); }
  return { activate: activate, loadAll: loadAll, pollActivity: pollActivity, refreshAll: refreshAll, hasActiveTask: hasActiveTask };
}
