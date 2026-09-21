import {
  clearEl, el, fmtTime, formatDuration, formatTimelineTime, groupMcpEvents, mcpCodeText,
  mcpComparator, mcpOutcomeInfo, mcpToolLabel, messageComparator,
  messageListLabel, messageStage, mergeRows, renderStageIndicator, taskComparator,
  taskHistoryKindClass, taskListLabel, taskStage,
} from "./common-app.js";

// Selected-workspace controller shared by the direct workspace and hub shells.
// The adapter owns target routing and freshness; this module never reads hub
// state or assumes a particular dashboard URL.
export function createWorkspacePanel(adapter) {
  var currentTarget = null;
  var state = {};
  // One trailing refresh after an MCP notification (see handleMcpInvalidate).
  var mcpSettleTimer = null;

  function isCurrent(target) { return currentTarget === target && adapter.isCurrent(target); }
  function request(target, path, options) { return adapter.request(target, path, options); }
  function reset() {
    clearMcpSettle();
    state = {
      activeTaskId: null, messagesCursor: null, tasksCursor: null,
      tasksExpanded: false, messagesExpanded: false, tasks: [], messages: [],
      selectedTaskId: null, selectedMessageId: null, selectedTask: null, selectedMessage: null,
      selectedTaskRowEl: null, selectedMessageRowEl: null,
      taskHistoryTaskId: null, taskHistoryItems: [], taskHistoryLoading: false,
      taskHistoryError: null, taskHistoryRequestGen: (state.taskHistoryRequestGen || 0) + 1,
      messageDetailRequestGen: (state.messageDetailRequestGen || 0) + 1,
      mcpEvents: [], mcpCursor: null, mcpExpanded: false, mcpItems: [],
      mcpFilters: { tool: "", outcome: "" }, mcpGrouped: true,
      selectedMcpId: null, selectedMcpRowEl: null,
      mcpRequestGen: (state.mcpRequestGen || 0) + 1,
      activitySubview: "tasks",
    };
  }
  function node(id) { return document.getElementById(id); }
  function jsonOptions(body) { return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }; }
  function clearPanel() {
    ["overview", "tasks-list", "messages-list", "mcp-list", "tasks-detail", "messages-detail", "mcp-detail"].forEach(function (id) { var n = node(id); if (n) clearEl(n); });
    node("tasks-load-more").hidden = true;
    node("messages-load-more").hidden = true;
    node("mcp-load-more").hidden = true;
  }
  function threePane() { return document.querySelector(".three-pane"); }
  function openDetail() { threePane().classList.add("detail-open"); }
  function closeDetail() { threePane().classList.remove("detail-open"); }
  function renderDetailPane(kind, content) { var d = node(kind + "-detail"); clearEl(d); d.appendChild(content); }
  function renderBackButton(kind) {
    var btn = el("button", { className: "secondary detail-back", text: "← Back to list" });
    btn.addEventListener("click", function () { closeDetail(); var row = kind === "tasks" ? state.selectedTaskRowEl : kind === "mcp" ? state.selectedMcpRowEl : state.selectedMessageRowEl; if (row && row.focus) row.focus(); });
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
    node("tab-mcp").setAttribute("aria-selected", which === "mcp" ? "true" : "false");
    node("tasks-list-col").hidden = which !== "tasks";
    node("tasks-detail").hidden = which !== "tasks";
    node("messages-list-col").hidden = which !== "messages";
    node("messages-detail").hidden = which !== "messages";
    node("mcp-list-col").hidden = which !== "mcp";
    node("mcp-detail").hidden = which !== "mcp";
    closeDetail();
    if (which !== "mcp") clearMcpSettle();
    if (changed && currentTarget) {
      if (which === "tasks") loadSnapshot(currentTarget, { messages: false });
      else if (which === "messages") loadSnapshot(currentTarget, { tasks: false });
      else if (which === "mcp") loadMcpAccess(currentTarget, false);
    }
  }
  node("tab-tasks").addEventListener("click", function () { setActivityTab("tasks"); });
  node("tab-messages").addEventListener("click", function () { setActivityTab("messages"); });
  node("tab-mcp").addEventListener("click", function () { setActivityTab("mcp"); });

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
    if (adapter.onOverview) {
      adapter.onOverview(data, currentTarget);
    }
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
  function applyTasksPage(res, target, more) {
    if (!res.ok || !isCurrent(target)) return;
    var rows = res.body.tasks || [];
    if (more) {
      state.tasks = mergeRows(state.tasks, rows, "taskId", taskComparator);
      state.tasksCursor = res.body.nextCursor;
      state.tasksExpanded = true;
    } else if (state.tasksExpanded) {
      if (res.body.nextCursor) state.tasks = mergeRows(state.tasks, rows, "taskId", taskComparator);
      else {
        state.tasks = rows;
        state.tasksCursor = null;
        state.tasksExpanded = false;
      }
      updateSelectedTaskFromRows(rows, target);
    } else {
      state.tasks = rows;
      state.tasksCursor = res.body.nextCursor;
      updateSelectedTaskFromRows(rows, target);
    }
    renderTasksList(target);
    node("tasks-load-more").hidden = !state.tasksCursor;
  }
  function loadTasks(target, more) {
    var q = "?limit=20" + (more && state.tasksCursor ? "&cursor=" + encodeURIComponent(state.tasksCursor) : "");
    return request(target, "/tasks" + q).then(function (res) { applyTasksPage(res, target, more); });
  }
  node("tasks-load-more").addEventListener("click", function () { if (currentTarget) loadTasks(currentTarget, true); });

  function renderMessageRow(m, target) {
    var row = el("button", { className: "list-row" }); row.type = "button"; row.setAttribute("role", "option"); row.setAttribute("aria-selected", state.selectedMessageId === m.messageId ? "true" : "false"); var head = el("div", { className: "row" }); head.appendChild(el("span", { className: "badge", text: m.state })); head.appendChild(el("span", { className: "meta", text: fmtTime(m.createdAt) })); row.appendChild(head);
    var label = messageListLabel(m);
    if (!label) label = (m.kind || "MSG") + " · task " + (m.taskId || "none");
    row.appendChild(el("div", { className: "preview" + (m.title ? " message-title" : ""), text: label })); row.addEventListener("click", function () { selectMessage(m, target, row); }); return row;
  }
  function renderMessageDetail(m, target) {
    var wrap = el("div"); wrap.appendChild(renderBackButton("messages")); var head = el("div", { className: "row" }); [m.dir, m.kind, m.state].forEach(function (value) { head.appendChild(el("span", { className: "badge", text: value })); }); wrap.appendChild(head); if (m.title) wrap.appendChild(el("p", { className: "meta message-detail-title", text: m.title })); wrap.appendChild(el("p", { className: "meta", text: "task=" + m.taskId + " iter=" + m.iteration + " " + fmtTime(m.createdAt) })); wrap.appendChild(renderStageIndicator(messageStage(m)));
    var bodyText = m.body !== undefined ? m.body : (m.bodyUnavailable ? "(message body unavailable; retained event may have expired)" : (m.bodyError ? "(failed to load message body)" : "Loading body…"));
    wrap.appendChild(renderTextSection("message-detail-body", "Body", bodyText));
    if (m.dir === "to_local" && m.state !== "acked") { var ack = el("button", { text: "Ack" }); ack.addEventListener("click", function () { request(target, "/ack", jsonOptions({ messageId: m.messageId })).then(function () { if (isCurrent(target)) loadSnapshot(target); }); }); wrap.appendChild(ack); }
    var canDiscard = m.state !== "acked" && !(state.activeTaskId === m.taskId);
    if (canDiscard) { var discard = el("button", { className: "danger", text: "Discard" }); discard.addEventListener("click", function () { if (!confirm("Discard this message?")) return; request(target, "/discard", jsonOptions({ messageId: m.messageId })).then(function (res) { if (!isCurrent(target)) return; if (res.body && res.body.error === "USE_DISCARD_TASK") alert("This message belongs to the active task; discard the task instead."); if (adapter.discardMessageRefresh === "all") refreshAll(); else loadMessages(target, false); }); }); wrap.appendChild(discard); }
    else if (m.state !== "acked" && state.activeTaskId === m.taskId) wrap.appendChild(el("span", { className: "note", text: "(part of the active task — use \"Discard task\" above)" }));
    return wrap;
  }
  function isCurrentMessageDetail(target, messageId, requestGen) { return isCurrent(target) && state.selectedMessageId === messageId && state.messageDetailRequestGen === requestGen; }
  function loadMessageDetail(messageId, taskId, target) {
    var requestGen = (state.messageDetailRequestGen || 0) + 1;
    state.messageDetailRequestGen = requestGen;
    function loadPage(cursor) {
      var q = "?task_id=" + encodeURIComponent(taskId) + "&limit=100" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
      request(target, "/messages" + q).then(function (res) {
        if (!isCurrentMessageDetail(target, messageId, requestGen)) return;
        if (!res.ok) {
          if (state.selectedMessage && state.selectedMessage.messageId === messageId && state.selectedMessage.body === undefined) {
            state.selectedMessage = Object.assign({}, state.selectedMessage, { bodyError: true });
            renderDetailPane("messages", renderMessageDetail(state.selectedMessage, target));
          }
          return;
        }
        var found = (res.body.messages || []).filter(function (m) { return m.messageId === messageId; })[0];
        if (found) {
          if (state.selectedMessage && state.selectedMessage.messageId === messageId) {
            state.selectedMessage = Object.assign({}, state.selectedMessage, { body: found.body });
            state.messages.forEach(function (m) { if (m.messageId === messageId) m.body = found.body; });
            renderDetailPane("messages", renderMessageDetail(state.selectedMessage, target));
          }
          return;
        }
        if (res.body.nextCursor) { loadPage(res.body.nextCursor); return; }
        if (state.selectedMessage && state.selectedMessage.messageId === messageId && state.selectedMessage.body === undefined) {
          state.selectedMessage = Object.assign({}, state.selectedMessage, { bodyUnavailable: true });
          renderDetailPane("messages", renderMessageDetail(state.selectedMessage, target));
        }
      }).catch(function () {
        if (isCurrentMessageDetail(target, messageId, requestGen)) {
          if (state.selectedMessage && state.selectedMessage.messageId === messageId && state.selectedMessage.body === undefined) {
            state.selectedMessage = Object.assign({}, state.selectedMessage, { bodyError: true });
            renderDetailPane("messages", renderMessageDetail(state.selectedMessage, target));
          }
        }
      });
    }
    loadPage(null);
  }
  function selectMessage(m, target, rowEl) {
    state.selectedMessageId = m.messageId; state.selectedMessage = m; state.selectedMessageRowEl = rowEl || null; renderMessagesList(target); renderDetailPane("messages", renderMessageDetail(m, target)); openDetail();
    if (m.body === undefined && m.taskId) loadMessageDetail(m.messageId, m.taskId, target);
  }
  function renderMessagesList(target) { var list = node("messages-list"); clearEl(list); state.messages.forEach(function (m) { list.appendChild(renderMessageRow(m, target)); }); if (!state.messages.length) list.appendChild(el("p", { className: "note", text: "No messages yet." })); }
  function updateSelectedMessageFromRows(rows, target) {
    if (!state.selectedMessageId) return;
    var fresh = rows.filter(function (m) { return m.messageId === state.selectedMessageId; })[0];
    if (fresh) {
      var prevBody = state.selectedMessage ? state.selectedMessage.body : undefined;
      state.selectedMessage = prevBody !== undefined ? Object.assign({}, fresh, { body: prevBody }) : fresh;
      if (state.selectedMessage.body === undefined && fresh.taskId) loadMessageDetail(fresh.messageId, fresh.taskId, target);
      renderDetailPane("messages", renderMessageDetail(state.selectedMessage, target));
    }
  }
  function applyMessagesPage(res, target, more) {
    if (!res.ok || !isCurrent(target)) return;
    var rows = res.body.messages || [];
    if (state.messages && state.messages.length) {
      var bodyMap = {};
      state.messages.forEach(function (m) { if (m.body !== undefined) bodyMap[m.messageId] = m.body; });
      rows.forEach(function (m) { if (m.body === undefined && bodyMap[m.messageId] !== undefined) m.body = bodyMap[m.messageId]; });
    }
    if (more) {
      state.messages = mergeRows(state.messages, rows, "messageId", messageComparator);
      state.messagesCursor = res.body.nextCursor;
      state.messagesExpanded = true;
    } else if (state.messagesExpanded) {
      if (res.body.nextCursor) state.messages = mergeRows(state.messages, rows, "messageId", messageComparator);
      else {
        state.messages = rows;
        state.messagesCursor = null;
        state.messagesExpanded = false;
      }
      updateSelectedMessageFromRows(rows, target);
    } else {
      state.messages = rows;
      state.messagesCursor = res.body.nextCursor;
      updateSelectedMessageFromRows(rows, target);
    }
    renderMessagesList(target);
    node("messages-load-more").hidden = !state.messagesCursor;
  }
  function loadMessages(target, more) {
    var q = "?limit=20&include_body=0" + (more && state.messagesCursor ? "&cursor=" + encodeURIComponent(state.messagesCursor) : "");
    return request(target, "/messages" + q).then(function (res) { applyMessagesPage(res, target, more); });
  }
  node("messages-load-more").addEventListener("click", function () { if (currentTarget) loadMessages(currentTarget, true); });

  // ---- MCP access history ----------------------------------------------------
  // What ChatGPT did through MCP, newest first. The rows are metadata only (tool,
  // a sanitized target, the kind of result, duration) — the Worker never stored a
  // file's content, a query or a diff, so there is nothing of that sort to show.
  // Filters are applied by the API so they hold across pages; grouping repeated
  // reads is only a view over what is loaded.
  function mcpQuery(more) {
    var q = "?limit=50";
    if (state.mcpFilters.tool) q += "&tool=" + encodeURIComponent(state.mcpFilters.tool);
    if (state.mcpFilters.outcome) q += "&outcome=" + encodeURIComponent(state.mcpFilters.outcome);
    if (more && state.mcpCursor) q += "&cursor=" + encodeURIComponent(state.mcpCursor);
    return q;
  }
  function loadMcpAccess(target, more) {
    // A fresh load (filter change, refresh) supersedes anything still in flight;
    // "Load more" belongs to the load it was started from.
    var gen = more ? state.mcpRequestGen : (state.mcpRequestGen = state.mcpRequestGen + 1);
    return request(target, "/mcp-access" + mcpQuery(more)).then(function (res) {
      if (gen !== state.mcpRequestGen) return;
      applyMcpPage(res, target, more);
    });
  }
  function loadMcpIfActive(target) { return state.activitySubview === "mcp" ? loadMcpAccess(target, false) : null; }
  function mcpFiltersActive() { return Boolean(state.mcpFilters.tool || state.mcpFilters.outcome); }
  function syncMcpControls() {
    node("mcp-filter-tool").value = state.mcpFilters.tool;
    node("mcp-filter-outcome").value = state.mcpFilters.outcome;
    node("mcp-group").checked = state.mcpGrouped;
  }
  function applyMcpPage(res, target, more) {
    if (!res.ok || !isCurrent(target)) return;
    var rows = res.body.events || [];
    if (more) {
      state.mcpEvents = mergeRows(state.mcpEvents, rows, "eventId", mcpComparator);
      state.mcpCursor = res.body.nextCursor;
      state.mcpExpanded = true;
    } else if (state.mcpExpanded) {
      if (res.body.nextCursor) state.mcpEvents = mergeRows(state.mcpEvents, rows, "eventId", mcpComparator);
      else { state.mcpEvents = rows; state.mcpCursor = null; state.mcpExpanded = false; }
    } else {
      state.mcpEvents = rows;
      state.mcpCursor = res.body.nextCursor;
    }
    renderMcpList(target);
    node("mcp-load-more").hidden = !state.mcpCursor;
    var selected = state.mcpItems.filter(function (item) { return item.id === state.selectedMcpId; })[0];
    if (selected) renderDetailPane("mcp", renderMcpDetail(selected));
  }
  function mcpItemEvent(item) { return item.type === "group" ? item.newest : item.event; }
  function renderMcpRow(item, target) {
    var e = mcpItemEvent(item), isGroup = item.type === "group";
    var row = el("button", { className: "list-row mcp-row" });
    row.type = "button"; row.setAttribute("role", "option"); row.setAttribute("aria-selected", state.selectedMcpId === item.id ? "true" : "false");
    var head = el("div", { className: "row" }), outcome = mcpOutcomeInfo(isGroup ? "success" : e.outcome);
    var titleWrap = el("span", { className: "mcp-row-title" });
    titleWrap.appendChild(el("span", { className: "badge mcp-outcome " + outcome.className, text: outcome.label }));
    titleWrap.appendChild(el("span", { className: "mcp-title", text: mcpToolLabel(e.toolName) + (isGroup ? " × " + item.count : "") }));
    head.appendChild(titleWrap);
    head.appendChild(el("span", { className: "meta", text: fmtTime(e.startedAt) }));
    row.appendChild(head);
    row.addEventListener("click", function () { selectMcp(item, row); });
    return row;
  }
  function renderMcpList(target) {
    var list = node("mcp-list"); clearEl(list);
    state.mcpItems = state.mcpGrouped
      ? groupMcpEvents(state.mcpEvents)
      : state.mcpEvents.map(function (event) { return { type: "event", id: "event-" + event.eventId, event: event }; });
    state.mcpItems.forEach(function (item) { list.appendChild(renderMcpRow(item, target)); });
    if (!state.mcpItems.length) {
      list.appendChild(el("p", { className: "note", text: mcpFiltersActive() ? "No MCP calls match these filters." : "No MCP calls recorded yet. They appear here as ChatGPT reads the workspace." }));
    }
  }
  function mcpDetailRow(dl, label, value) {
    if (value === null || value === undefined || value === "") return;
    dl.appendChild(el("dt", { text: label }));
    dl.appendChild(el("dd", { text: String(value) }));
  }
  function renderMcpBatchCalls(details) {
    var wrap = el("section", { className: "detail-section" });
    wrap.appendChild(el("h3", { text: "Calls in this batch" }));
    var list = el("ol", { className: "task-history-list mcp-call-list" });
    list.setAttribute("role", "list");
    (details.calls || []).forEach(function (call) {
      var outcome = mcpOutcomeInfo(call.outcome), row = el("li", { className: "task-history-row mcp-call-row mcp-batch-row" });
      row.appendChild(el("span", { className: "badge mcp-outcome " + outcome.className, text: outcome.label }));
      row.appendChild(el("strong", { text: mcpToolLabel(call.tool) }));
      row.appendChild(el("span", { className: "mcp-call-target", text: call.target || "" }));
      var code = mcpCodeText(call.code);
      if (code) row.appendChild(el("span", { className: "task-history-iteration", text: code }));
      list.appendChild(row);
    });
    wrap.appendChild(list);
    return wrap;
  }
  function renderMcpDetail(item) {
    var wrap = el("div"), e = mcpItemEvent(item), isGroup = item.type === "group";
    wrap.appendChild(renderBackButton("mcp"));
    var head = el("div", { className: "row" }), outcome = mcpOutcomeInfo(isGroup ? "success" : e.outcome);
    head.appendChild(el("span", { className: "badge mcp-outcome " + outcome.className, text: outcome.label }));
    head.appendChild(el("span", { className: "meta", text: mcpToolLabel(e.toolName) + (isGroup ? " × " + item.count : "") + " (" + e.toolName + ")" }));
    wrap.appendChild(head);
    var dl = el("dl", { className: "mcp-facts" });
    if (isGroup) {
      mcpDetailRow(dl, "Between", fmtTime(item.oldest.startedAt) + " and " + fmtTime(item.newest.startedAt));
    } else {
      mcpDetailRow(dl, "When", fmtTime(e.startedAt));
      mcpDetailRow(dl, "Duration", formatDuration(e.durationMs));
      mcpDetailRow(dl, "Target", e.target);
      mcpDetailRow(dl, "Result", outcome.word + (e.outcomeCode ? " — " + mcpCodeText(e.outcomeCode) : ""));
    }
    mcpDetailRow(dl, "Task", e.taskId ? e.taskId : "none was active");
    mcpDetailRow(dl, "Connector", e.connector === "shared" ? "Shared connector" : "Dedicated connector");
    wrap.appendChild(dl);
    if (isGroup) {
      var section = el("section", { className: "detail-section" });
      section.appendChild(el("h3", { text: "Files read (newest first)" }));
      var list = el("ol", { className: "task-history-list mcp-call-list" });
      list.setAttribute("role", "list");
      item.events.forEach(function (event) {
        var row = el("li", { className: "task-history-row mcp-call-row" });
        row.appendChild(el("span", { className: "task-history-time", text: formatTimelineTime(event.startedAt) }));
        row.appendChild(el("span", { className: "mcp-call-target", text: event.target || "" }));
        row.appendChild(el("span", { className: "task-history-iteration", text: formatDuration(event.durationMs) }));
        list.appendChild(row);
      });
      section.appendChild(list);
      wrap.appendChild(section);
    } else if (e.details && Array.isArray(e.details.calls)) {
      wrap.appendChild(renderMcpBatchCalls(e.details));
    }
    return wrap;
  }
  function selectMcp(item, rowEl) {
    state.selectedMcpId = item.id; state.selectedMcpRowEl = rowEl || null;
    renderMcpList(currentTarget);
    renderDetailPane("mcp", renderMcpDetail(item));
    openDetail();
  }
  function resetMcpList() {
    state.mcpEvents = []; state.mcpCursor = null; state.mcpExpanded = false; state.mcpItems = [];
    state.selectedMcpId = null; state.selectedMcpRowEl = null;
    clearEl(node("mcp-detail")); node("mcp-detail").appendChild(el("p", { className: "note detail-empty", text: "Select an access to see details." }));
    closeDetail();
  }
  node("mcp-filter-tool").addEventListener("change", function () { state.mcpFilters.tool = node("mcp-filter-tool").value; resetMcpList(); if (currentTarget) loadMcpAccess(currentTarget, false); });
  node("mcp-filter-outcome").addEventListener("change", function () { state.mcpFilters.outcome = node("mcp-filter-outcome").value; resetMcpList(); if (currentTarget) loadMcpAccess(currentTarget, false); });
  node("mcp-group").addEventListener("change", function () { state.mcpGrouped = node("mcp-group").checked; if (currentTarget) renderMcpList(currentTarget); });
  node("mcp-load-more").addEventListener("click", function () { if (currentTarget) loadMcpAccess(currentTarget, true); });
  /** A scope "mcp" invalidation: refresh the history if — and only if — it is the
   *  tab on screen. It must never fall through to the Tasks/Messages reload. */
  // The Worker sends at most one "mcp" notification per MCP_NOTIFY_MIN_INTERVAL_MS
  // (2 s, leading edge), and this dashboard stops polling while its WebSocket is
  // healthy — so calls made just after a notification would otherwise not appear
  // until the next one, which may never come. Each notification therefore reloads
  // now AND schedules one trailing reload just past the throttle window; the
  // latter picks up whatever the throttle swallowed. A newer notification replaces
  // the pending timer, and leaving the tab / switching workspace cancels it.
  var MCP_SETTLE_MS = 2500;
  function clearMcpSettle() {
    if (mcpSettleTimer !== null) { clearTimeout(mcpSettleTimer); mcpSettleTimer = null; }
  }
  function handleMcpInvalidate() {
    if (!currentTarget || state.activitySubview !== "mcp") return null;
    var target = currentTarget;
    clearMcpSettle();
    mcpSettleTimer = setTimeout(function () {
      mcpSettleTimer = null;
      if (isCurrent(target) && state.activitySubview === "mcp") loadMcpAccess(target, false);
    }, MCP_SETTLE_MS);
    return loadMcpAccess(target, false);
  }

  function loadSnapshot(target, options) {
    var opts = options || {};
    var q = "?limit=20";
    if (opts.tasks === false) q += "&include_tasks=0";
    if (opts.messages === false) q += "&include_messages=0";
    else q += "&include_body=0";
    return request(target, "/snapshot" + q).then(function (res) {
      if (!res.ok || !isCurrent(target)) return;
      if (res.body.overview) renderOverview(res.body.overview);
      if (res.body.tasks) applyTasksPage({ ok: true, body: res.body.tasks }, target, false);
      if (res.body.messages) applyMessagesPage({ ok: true, body: res.body.messages }, target, false);
    });
  }

  function loadAll() {
    var target = currentTarget;
    if (!target) return;
    return Promise.all([loadSnapshot(target), loadGuidance(target), loadLimits(target), loadBrowserSettings(target), loadMcpIfActive(target)]);
  }
  function pollActivity() {
    var target = currentTarget;
    if (!target) return;
    // The MCP tab has no snapshot of its own: its history and the overview strip
    // (bridge connected, queue counts) are read separately.
    if (state.activitySubview === "mcp") return Promise.all([loadMcpAccess(target, false), loadOverview(target)]);
    return state.activitySubview === "messages"
      ? loadSnapshot(target, { tasks: false })
      : loadSnapshot(target, { messages: false });
  }
  function refreshAll() { return loadAll(); }
  function hasActiveTask() { return Boolean(state.activeTaskId); }
  function activate(target, options) { currentTarget = target; reset(); syncMcpControls(); if (options && options.clearView) clearPanel(); setActivityTab("tasks"); return loadAll(); }
  return { activate: activate, loadAll: loadAll, pollActivity: pollActivity, refreshAll: refreshAll, hasActiveTask: hasActiveTask, handleMcpInvalidate: handleMcpInvalidate };
}
