(function () {
  "use strict";
  var HUB_BASE = "/dashboard/hub";
  var POLL_MS = 10000;
  var LIST_PREVIEW_CHARS = 180;

  function api(base, path, options) {
    return fetch(base + path, Object.assign({ credentials: "same-origin" }, options || {})).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        return { ok: res.ok, status: res.status, body: body };
      });
    });
  }
  function hubApi(path, options) { return api(HUB_BASE, path, options); }
  // Fixed-target helper: every per-workspace call takes its target
  // workspaceId as an explicit argument instead of reading it back off
  // mutable global state when the request resolves — see the
  // selection-generation guard on `state` below for why a delayed callback
  // must never resolve its own target that way.
  function wsApiFor(workspaceId, path, options) { return api(HUB_BASE + "/api/workspaces/" + workspaceId, path, options); }

  function el(tag, opts) {
    var e = document.createElement(tag);
    opts = opts || {};
    if (opts.className) e.className = opts.className;
    if (opts.text !== undefined) e.textContent = opts.text;
    return e;
  }

  // Never innerHTML, even to clear — every element here is either built
  // fresh via el()/textContent above or removed one node at a time.
  function clearEl(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function fmtTime(ms) {
    if (!ms) return "";
    try { return new Date(ms).toLocaleString(); } catch (e) { return String(ms); }
  }

  function formatTimelineTime(ms) {
    if (!ms) return "";
    var d = new Date(ms);
    if (isNaN(d.getTime())) return String(ms);
    function pad(n) { return String(n).padStart(2, "0"); }
    return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  // Truncates on Unicode code points (via Array.from), not UTF-16 code
  // units, so a surrogate pair (e.g. an emoji) is never split in half.
  function truncateText(value, maxChars) {
    var s = String(value == null ? "" : value);
    var chars = Array.from(s);
    if (chars.length <= maxChars) return { text: s, truncated: false };
    return { text: chars.slice(0, maxChars).join("") + "…", truncated: true };
  }

  function taskListLabel(task) {
    return typeof task.title === "string" && task.title ? task.title : truncateText(task.goal, LIST_PREVIEW_CHARS).text;
  }

  // ---- 3-stage indicator: [Web] — [Hub] — [Local] ----
  // See docs/plans/dashboard-ux-redesign.md "3ステージマッピング". A task's
  // protocolState encodes *responsibility/protocol stage*, not physical
  // transport location — WAITING_PLAN/WAITING_REVIEW never claim the task is
  // "in the Hub queue", only that Web currently owns the next step.
  function taskStage(t) {
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
    if (t.protocolState === "BLOCKED") {
      return { node: null, label: t.waitingFor === "USER" ? "Blocked — needs user" : "Blocked", terminal: true, blocked: true };
    }
    return { node: null, label: t.protocolState || "Unknown" };
  }

  // A message's dir+state does encode real transport location (pending ==
  // sitting in the Hub's queue, unlike a task's protocolState above).
  function messageStage(m) {
    var destNode = m.dir === "to_gpt" ? "web" : "local";
    var destLabel = m.dir === "to_gpt" ? "Web" : "Local";
    if (m.state === "pending") return { node: "hub", label: "Queued for " + destLabel };
    if (m.state === "leased") {
      if (m.dir === "to_gpt") return { node: "web", label: "Web reading" };
      return { node: "hub", label: "Queued for " + destLabel }; // defensive: to_local is not normally leased
    }
    if (m.state === "acked") return { node: destNode, label: "Consumed by " + destLabel, terminal: true };
    return { node: null, label: m.state || "Unknown" };
  }

  function renderStageIndicator(stage, opts) {
    opts = opts || {};
    var wrap = el("div", { className: "stage-indicator" + (opts.small ? " small" : "") });
    wrap.setAttribute("aria-label", "Stage: " + stage.label);
    [
      { key: "web", text: "Web" },
      { key: "hub", text: "Hub" },
      { key: "local", text: "Local" },
    ].forEach(function (n, i, arr) {
      var cls = "stage-node";
      if (stage.node === n.key) cls += " current";
      else if (stage.terminal) cls += " complete";
      wrap.appendChild(el("span", { className: cls, text: n.text }));
      if (i < arr.length - 1) wrap.appendChild(el("span", { className: "stage-connector" }));
    });
    wrap.appendChild(el("span", { className: "stage-label" + (stage.blocked ? " blocked" : ""), text: stage.label }));
    return wrap;
  }

  // ---- login page ----
  var loginForm = document.getElementById("login-form");
  if (loginForm) {
    loginForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var tokenInput = document.getElementById("owner_token");
      var errorEl = document.getElementById("login-error");
      errorEl.hidden = true;
      hubApi("/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ownerToken: tokenInput.value }),
      }).then(function (res) {
        if (res.ok) { location.reload(); return; }
        errorEl.textContent = res.status === 403 ? "Invalid owner token." : "Login failed (" + res.status + ").";
        errorEl.hidden = false;
      });
    });
    return; // nothing else to do on the login page
  }

  // ---- authenticated shell ----
  var listEl = document.getElementById("workspace-list");
  if (!listEl) return; // neither page — app.js loaded somewhere unexpected

  var detailEl = document.getElementById("workspace-detail");
  var detailTitleEl = document.getElementById("detail-title");
  var overviewEl = document.getElementById("overview");
  // selectionGen guards every in-flight per-workspace request: it is
  // incremented on every selectWorkspace() call, and each load function
  // captures the generation current when it *issues* its request. A
  // response only ever touches the DOM if that captured generation still
  // equals state.selectionGen when the response arrives — otherwise a
  // slower response for a workspace the user has since switched away from
  // could overwrite the newly selected workspace's guidance/limits/
  // messages/tasks with the wrong workspace's data (and a stale "Save"
  // click could then write it to the wrong target). Every request also
  // takes its target workspaceId as an explicit argument (wsApiFor) rather
  // than re-reading state.workspaceId when the response resolves, for the
  // same reason.
  var state = {
    workspaceId: null, selectionGen: 0, activeTaskId: null,
    messagesCursor: null, tasksCursor: null,
    // Set once Load more has fetched past the first page — see loadTasks()/
    // loadMessages() below for why polling must branch on this instead of
    // always replacing the list with a fresh first page. Reset by
    // selectWorkspace() along with the rest of the per-workspace cache.
    tasksExpanded: false, messagesExpanded: false,
    tasks: [], messages: [],
    selectedTaskId: null, selectedMessageId: null,
    selectedTask: null, selectedMessage: null,
    selectedTaskRowEl: null, selectedMessageRowEl: null,
    taskHistoryTaskId: null, taskHistoryItems: [], taskHistoryLoading: false,
    taskHistoryError: null, taskHistoryRequestGen: 0,
    activitySubview: "tasks",
  };

  document.getElementById("logout-btn").addEventListener("click", function () {
    hubApi("/logout", { method: "POST" }).then(function () { location.reload(); });
  });

  // ---- Tasks/Messages tab wiring (client-side only, no routing/hash) ----
  // The sidebar (workspace picker/start-task/settings) sits outside this
  // toggle entirely and never re-layouts when switching tabs — only which of
  // the list/detail column pairs is visible changes. Switching tabs also
  // always returns to the list view on narrow screens (closeDetail()) so a
  // freshly-selected tab with nothing selected yet can't strand a mobile
  // user on an empty detail pane with no "Back to list" control rendered.
  // These elements start hidden (class "hub-gated") until a workspace is
  // selected — selectWorkspace() reveals them.
  function setActivityTab(which) {
    state.activitySubview = which;
    document.getElementById("tab-tasks").setAttribute("aria-selected", which === "tasks" ? "true" : "false");
    document.getElementById("tab-messages").setAttribute("aria-selected", which === "messages" ? "true" : "false");
    document.getElementById("tasks-list-col").hidden = which !== "tasks";
    document.getElementById("tasks-detail").hidden = which !== "tasks";
    document.getElementById("messages-list-col").hidden = which !== "messages";
    document.getElementById("messages-detail").hidden = which !== "messages";
    closeDetail();
  }
  document.getElementById("tab-tasks").addEventListener("click", function () { setActivityTab("tasks"); });
  document.getElementById("tab-messages").addEventListener("click", function () { setActivityTab("messages"); });

  // ---- workspace list ----
  function updateWorkspaceSelection(workspaceId) {
    Array.prototype.forEach.call(document.querySelectorAll(".workspace-choice"), function (button) {
      var isSelected = button.getAttribute("data-workspace-id") === workspaceId;
      button.classList.toggle("selected", isSelected);
      if (isSelected) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    });
  }

  function renderWorkspaceList(data) {
    clearEl(listEl);
    var workspaces = data.workspaces || [];
    workspaces.forEach(function (w) {
      var item = el("div", { className: "workspace-item" });
      var nameBtn = el("button", { className: "workspace-choice" + (w.workspaceId === state.workspaceId ? " selected" : ""), text: w.name });
      nameBtn.setAttribute("data-workspace-id", w.workspaceId);
      if (w.workspaceId === state.workspaceId) nameBtn.setAttribute("aria-current", "true");
      nameBtn.addEventListener("click", function () { selectWorkspace(w.workspaceId, w.name); });
      item.appendChild(nameBtn);
      var status = "Idle";
      if (w.error) {
        status = "Unavailable";
      } else if (w.overview) {
        status = w.overview.activeTask ? "In progress" : "Idle";
      }
      item.appendChild(el("span", { className: "workspace-status" + (status === "In progress" ? " active" : ""), text: status }));
      listEl.appendChild(item);
    });
    if (!workspaces.length) listEl.appendChild(el("p", { className: "note", text: "No workspaces registered yet." }));
  }

  function loadWorkspaceList() {
    hubApi("/api/workspaces").then(function (res) {
      if (res.ok) renderWorkspaceList(res.body);
    });
  }

  function selectWorkspace(id, name) {
    state.workspaceId = id;
    updateWorkspaceSelection(id);
    state.selectionGen += 1;
    state.activeTaskId = null;
    state.messagesCursor = null;
    state.tasksCursor = null;
    state.tasksExpanded = false;
    state.messagesExpanded = false;
    state.tasks = [];
    state.messages = [];
    state.selectedTaskId = null;
    state.selectedMessageId = null;
    state.selectedTask = null;
    state.selectedMessage = null;
    state.selectedTaskRowEl = null;
    state.selectedMessageRowEl = null;
    state.taskHistoryTaskId = null;
    state.taskHistoryItems = [];
    state.taskHistoryLoading = false;
    state.taskHistoryError = null;
    state.taskHistoryRequestGen += 1;
    detailEl.hidden = false;
    detailTitleEl.textContent = name + " (" + id + ")";
    clearEl(document.getElementById("messages-list"));
    clearEl(document.getElementById("tasks-list"));
    // Clear the previously selected workspace's rendered detail immediately,
    // before the newly selected workspace's own data arrives — otherwise the
    // old workspace's messages/tasks/guidance/limits/detail panes (and their
    // click handlers, still bound to the old workspaceId) would stay visible
    // and clickable during the load.
    clearEl(overviewEl);
    document.getElementById("guidance-text").value = "";
    document.getElementById("limits-value").value = "";
    document.getElementById("chat-project-override").value = "";
    document.getElementById("conversation-url").value = "";
    document.getElementById("chat-project-override-error").hidden = true;
    document.getElementById("conversation-url-error").hidden = true;
    clearEl(document.getElementById("tasks-detail"));
    clearEl(document.getElementById("messages-detail"));
    closeDetail();
    document.getElementById("messages-load-more").hidden = true;
    document.getElementById("tasks-load-more").hidden = true;
    document.getElementById("new-task-status").textContent = "";
    // The Tasks/Messages tab strip and their list/detail columns start
    // hidden (class "hub-gated") until a workspace is selected — reveal them
    // now, and reset to the default "Tasks" tab regardless of which tab was
    // active for a previously selected workspace.
    Array.prototype.forEach.call(document.querySelectorAll(".hub-gated"), function (gated) { gated.hidden = false; });
    setActivityTab("tasks");
    loadDetail(id, state.selectionGen);
  }

  // ---- overview ----
  function renderOverview(data) {
    clearEl(overviewEl);
    var row = el("div", { className: "row" });
    row.appendChild(el("span", { text: "Bridge: " + (data.connected ? "connected" : "not connected") }));
    row.appendChild(el("span", { text: "Queued to ChatGPT: " + data.pendingToGpt }));
    row.appendChild(el("span", { text: "Queued to local: " + data.pendingToLocal }));
    overviewEl.appendChild(row);
    var taskLine = el("p", { className: "meta" });
    if (data.activeTask) {
      state.activeTaskId = data.activeTask.taskId;
      taskLine.textContent = "Active task: " + data.activeTask.taskId + " (" + data.activeTask.protocolState + ")";
    } else {
      state.activeTaskId = null;
      taskLine.textContent = "No active task.";
    }
    overviewEl.appendChild(taskLine);
    var settingsLine = el("p", { className: "meta" });
    settingsLine.textContent = "Guidance set: " + (data.guidanceSet ? "yes" : "no") + " · Body limit: " + data.maxBodyBytes + " bytes";
    overviewEl.appendChild(settingsLine);
  }

  function loadOverview(id, gen) {
    wsApiFor(id, "/overview").then(function (res) {
      if (res.ok && gen === state.selectionGen) renderOverview(res.body);
    });
  }

  // ---- guidance (Settings tab) ----
  function loadGuidance(id, gen) {
    wsApiFor(id, "/guidance").then(function (res) {
      if (res.ok && gen === state.selectionGen) document.getElementById("guidance-text").value = res.body.guidance || "";
    });
  }
  document.getElementById("guidance-save").addEventListener("click", function () {
    var id = state.workspaceId;
    if (!id) return;
    var text = document.getElementById("guidance-text").value;
    wsApiFor(id, "/guidance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: text }) });
  });
  document.getElementById("guidance-clear").addEventListener("click", function () {
    var id = state.workspaceId;
    var gen = state.selectionGen;
    if (!id) return;
    wsApiFor(id, "/guidance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clear: true }) }).then(function () {
      if (gen === state.selectionGen) document.getElementById("guidance-text").value = "";
    });
  });

  // ---- limits (Settings tab) ----
  function loadLimits(id, gen) {
    wsApiFor(id, "/limits").then(function (res) {
      if (res.ok && gen === state.selectionGen) document.getElementById("limits-value").value = res.body.maxBodyBytes;
    });
  }
  document.getElementById("limits-save").addEventListener("click", function () {
    var id = state.workspaceId;
    var gen = state.selectionGen;
    if (!id) return;
    var value = Number(document.getElementById("limits-value").value);
    wsApiFor(id, "/limits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxBodyBytes: value }) }).then(function () { loadLimits(id, gen); });
  });
  document.getElementById("limits-reset").addEventListener("click", function () {
    var id = state.workspaceId;
    var gen = state.selectionGen;
    if (!id) return;
    wsApiFor(id, "/limits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxBodyBytes: null }) }).then(function () { loadLimits(id, gen); });
  });

  // ---- shared hub browser settings ----
  function loadHubBrowserSettings() {
    hubApi("/api/browser-settings").then(function (res) {
      if (res.ok) {
        document.getElementById("hub-shared-project-url").value = res.body.chatUrl || "";
      }
    });
  }
  document.getElementById("hub-shared-project-save").addEventListener("click", function () {
    var val = document.getElementById("hub-shared-project-url").value.trim();
    var errEl = document.getElementById("hub-shared-project-error");
    errEl.hidden = true;
    errEl.textContent = "";
    hubApi("/api/browser-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatUrl: val || null }),
    }).then(function (res) {
      if (!res.ok || res.body.error) {
        errEl.hidden = false;
        errEl.textContent = res.body.message || res.body.error || "Failed to save shared project URL.";
      } else {
        loadHubBrowserSettings();
      }
    });
  });
  document.getElementById("hub-shared-project-clear").addEventListener("click", function () {
    var errEl = document.getElementById("hub-shared-project-error");
    errEl.hidden = true;
    errEl.textContent = "";
    hubApi("/api/browser-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatUrl: null }),
    }).then(function (res) {
      if (!res.ok || res.body.error) {
        errEl.hidden = false;
        errEl.textContent = res.body.message || res.body.error || "Failed to clear shared project URL.";
      } else {
        document.getElementById("hub-shared-project-url").value = "";
        loadHubBrowserSettings();
      }
    });
  });

  // ---- workspace browser settings (Settings tab) ----
  function loadBrowserSettings(id, gen) {
    wsApiFor(id, "/browser-settings").then(function (res) {
      if (res.ok && gen === state.selectionGen) {
        document.getElementById("chat-project-override").value = res.body.chatUrlOverride || "";
        document.getElementById("conversation-url").value = res.body.conversationUrl || "";
        var overrideInput = document.getElementById("chat-project-override");
        if (res.body.sharedChatUrl) {
          overrideInput.placeholder = res.body.sharedChatUrl + " (shared default)";
        } else {
          overrideInput.placeholder = "https://chatgpt.com/g/g-p-.../project (leave empty for shared default)";
        }
      }
    });
  }
  document.getElementById("chat-project-override-save").addEventListener("click", function () {
    var id = state.workspaceId;
    var gen = state.selectionGen;
    if (!id) return;
    var val = document.getElementById("chat-project-override").value.trim();
    var errEl = document.getElementById("chat-project-override-error");
    errEl.hidden = true;
    errEl.textContent = "";
    wsApiFor(id, "/browser-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatUrlOverride: val || null }),
    }).then(function (res) {
      if (!res.ok || res.body.error) {
        if (gen === state.selectionGen) {
          errEl.hidden = false;
          errEl.textContent = res.body.message || res.body.error || "Failed to save project override.";
        }
      } else {
        loadBrowserSettings(id, gen);
      }
    });
  });
  document.getElementById("chat-project-override-clear").addEventListener("click", function () {
    var id = state.workspaceId;
    var gen = state.selectionGen;
    if (!id) return;
    var errEl = document.getElementById("chat-project-override-error");
    errEl.hidden = true;
    errEl.textContent = "";
    wsApiFor(id, "/browser-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatUrlOverride: null }),
    }).then(function (res) {
      if (!res.ok || res.body.error) {
        if (gen === state.selectionGen) {
          errEl.hidden = false;
          errEl.textContent = res.body.message || res.body.error || "Failed to clear project override.";
        }
      } else {
        if (gen === state.selectionGen) {
          document.getElementById("chat-project-override").value = "";
        }
        loadBrowserSettings(id, gen);
      }
    });
  });
  document.getElementById("conversation-url-save").addEventListener("click", function () {
    var id = state.workspaceId;
    var gen = state.selectionGen;
    if (!id) return;
    var val = document.getElementById("conversation-url").value.trim();
    var errEl = document.getElementById("conversation-url-error");
    errEl.hidden = true;
    errEl.textContent = "";
    wsApiFor(id, "/browser-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationUrl: val || null }),
    }).then(function (res) {
      if (!res.ok || res.body.error) {
        if (gen === state.selectionGen) {
          errEl.hidden = false;
          errEl.textContent = res.body.message || res.body.error || "Failed to save conversation URL.";
        }
      } else {
        loadBrowserSettings(id, gen);
      }
    });
  });
  document.getElementById("conversation-url-clear").addEventListener("click", function () {
    var id = state.workspaceId;
    var gen = state.selectionGen;
    if (!id) return;
    var errEl = document.getElementById("conversation-url-error");
    errEl.hidden = true;
    errEl.textContent = "";
    wsApiFor(id, "/browser-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationUrl: null }),
    }).then(function (res) {
      if (!res.ok || res.body.error) {
        if (gen === state.selectionGen) {
          errEl.hidden = false;
          errEl.textContent = res.body.message || res.body.error || "Failed to reset conversation.";
        }
      } else {
        if (gen === state.selectionGen) {
          document.getElementById("conversation-url").value = "";
        }
        loadBrowserSettings(id, gen);
      }
    });
  });

  // ---- new task ----
  document.getElementById("new-task-submit").addEventListener("click", function () {
    var id = state.workspaceId;
    var gen = state.selectionGen;
    var goal = document.getElementById("new-task-goal").value;
    var force = document.getElementById("new-task-force").checked;
    var statusEl = document.getElementById("new-task-status");
    if (!id) { statusEl.textContent = "Select a workspace first."; return; }
    if (!goal.trim()) { statusEl.textContent = "Goal is required."; return; }
    if (force && !confirm("This will BLOCK the currently active task. Continue?")) return;
    statusEl.textContent = "Starting…";
    wsApiFor(id, "/start-task", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: goal, force: force }) }).then(function (res) {
      if (gen !== state.selectionGen) return; // the user switched workspaces while this was in flight
      if (!res.ok || res.body.error) {
        statusEl.textContent = "Failed: " + (res.body.error || res.status);
        return;
      }
      var nudgeStatus = res.body.nudge && res.body.nudge.status;
      statusEl.textContent = "Task " + res.body.task.taskId + " queued. Browser notification: " + (nudgeStatus || "unknown") + ".";
      document.getElementById("new-task-goal").value = "";
      document.getElementById("new-task-force").checked = false;
      loadDetail(id, gen);
      loadWorkspaceList();
    });
  });

  // ---- list/detail pane plumbing shared by Tasks and Messages ----
  // There is a single .three-pane grid on the page (sidebar + one list/detail
  // column pair, with the Tasks/Messages tab above choosing which pair is
  // visible — see setActivityTab()), so open/close only ever need to toggle
  // that one element's "detail-open" class, not a per-kind grid.
  function threePane() { return document.querySelector(".three-pane"); }
  function renderDetailPane(kind, node) {
    var d = document.getElementById(kind + "-detail");
    clearEl(d);
    d.appendChild(node);
  }
  function openDetail() { threePane().classList.add("detail-open"); }
  function closeDetail() { threePane().classList.remove("detail-open"); }
  function renderBackButton(kind) {
    var btn = el("button", { className: "secondary detail-back", text: "← Back to list" });
    btn.addEventListener("click", function () {
      closeDetail();
      var rowEl = kind === "tasks" ? state.selectedTaskRowEl : state.selectedMessageRowEl;
      if (rowEl && rowEl.focus) rowEl.focus();
    });
    return btn;
  }
  // Detail text remains fully available in its own scrollable pane. Unlike
  // the compact list preview, it deliberately has no expansion control.
  function renderTextSection(containerId, label, fullText) {
    var wrap = el("div", { className: "detail-section" });
    if (label) wrap.appendChild(el("h3", { text: label }));
    var body = el("pre", { className: "detail-body" });
    body.id = containerId;
    body.textContent = String(fullText == null ? "" : fullText);
    wrap.appendChild(body);
    return wrap;
  }

  function taskHistoryKindClass(kind) {
    if (kind === "INIT") return "init";
    if (kind === "PLAN") return "plan";
    if (kind === "EXECUTED") return "executed";
    if (kind === "DONE") return "done";
    if (kind === "BLOCKED") return "blocked";
    return "other";
  }

  function renderTaskHistory(t) {
    var wrap = el("section", { className: "task-history" });
    wrap.appendChild(el("h3", { text: "Exchange history" }));
    if (state.taskHistoryTaskId !== t.taskId || state.taskHistoryLoading) {
      wrap.appendChild(el("p", { className: "note", text: "Loading retained exchange history…" }));
      return wrap;
    }
    if (state.taskHistoryError) {
      wrap.appendChild(el("p", { className: "error", text: "Could not load exchange history." }));
      return wrap;
    }
    if (!state.taskHistoryItems.length) {
      wrap.appendChild(el("p", { className: "note", text: "No retained exchange history. Older acknowledged events may have expired." }));
      return wrap;
    }
    var list = el("ol", { className: "task-history-list" });
    list.setAttribute("role", "list");
    state.taskHistoryItems.forEach(function (m) {
      var row = el("li", { className: "task-history-row task-history-kind-" + taskHistoryKindClass(m.kind) });
      row.appendChild(el("span", { className: "task-history-time", text: formatTimelineTime(m.createdAt) }));
      row.appendChild(el("strong", { className: "task-history-kind", text: m.kind || "UNKNOWN" }));
      row.appendChild(el("span", { className: "task-history-iteration", text: "Iteration " + m.iteration }));
      list.appendChild(row);
    });
    wrap.appendChild(list);
    wrap.appendChild(el("p", { className: "note", text: "Acknowledged events are retained for a limited time." }));
    return wrap;
  }

  function isCurrentTaskHistory(taskId, id, gen, requestGen) {
    return state.workspaceId === id && state.selectionGen === gen && state.selectedTaskId === taskId && state.taskHistoryTaskId === taskId && state.taskHistoryRequestGen === requestGen;
  }

  function renderSelectedTaskHistory(id, gen) {
    if (state.workspaceId === id && state.selectionGen === gen && state.selectedTask && state.selectedTaskId === state.selectedTask.taskId) {
      renderDetailPane("tasks", renderTaskDetail(state.selectedTask, id, gen));
    }
  }

  function loadTaskHistory(taskId, id, gen) {
    var requestGen = state.taskHistoryRequestGen + 1;
    state.taskHistoryRequestGen = requestGen;
    state.taskHistoryTaskId = taskId;
    state.taskHistoryItems = [];
    state.taskHistoryLoading = true;
    state.taskHistoryError = null;
    var byId = {};
    function loadPage(cursor) {
      var q = "?task_id=" + encodeURIComponent(taskId) + "&limit=100&include_body=0" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
      wsApiFor(id, "/messages" + q).then(function (res) {
        if (!isCurrentTaskHistory(taskId, id, gen, requestGen)) return;
        if (!res.ok) {
          state.taskHistoryLoading = false;
          state.taskHistoryError = true;
          renderSelectedTaskHistory(id, gen);
          return;
        }
        (res.body.messages || []).forEach(function (m) { byId[m.messageId] = m; });
        if (res.body.nextCursor) {
          loadPage(res.body.nextCursor);
          return;
        }
        state.taskHistoryItems = Object.keys(byId).map(function (messageId) { return byId[messageId]; }).sort(function (a, b) {
          return a.createdAt - b.createdAt || String(a.messageId).localeCompare(String(b.messageId));
        });
        state.taskHistoryLoading = false;
        renderSelectedTaskHistory(id, gen);
      }).catch(function () {
        if (!isCurrentTaskHistory(taskId, id, gen, requestGen)) return;
        state.taskHistoryLoading = false;
        state.taskHistoryError = true;
        renderSelectedTaskHistory(id, gen);
      });
    }
    loadPage(null);
  }

  // ---- list merge/sort helpers (Load more + 10s polling) ----
  // Polling (loadTasks(id, gen, false)/loadMessages(id, gen, false)) always
  // re-fetches only the first page. Once Load more has expanded the list
  // past that page, a plain poll response must not replace the whole list
  // wholesale — that would silently drop every row loaded past page 1.
  // Instead the fresh first page is merged into the retained cache (same id
  // => overwritten with the fresh row, new id => added) and the combined
  // list is re-sorted with the same ordering as the backend's own ORDER BY,
  // so an expanded list never drifts out of sync with server order.
  // Comparators use plain `<`/`>` on the id (not localeCompare) to match
  // SQLite's BINARY-collation tie-break in dashboardTasks()/
  // dashboardMessages() (worker/src/index.js) exactly.
  function mergeRows(existing, fresh, idKey, comparator) {
    var byId = {};
    existing.forEach(function (r) { byId[r[idKey]] = r; });
    fresh.forEach(function (r) { byId[r[idKey]] = r; });
    var merged = Object.keys(byId).map(function (k) { return byId[k]; });
    merged.sort(comparator);
    return merged;
  }
  function taskComparator(a, b) {
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return b.taskId > a.taskId ? 1 : b.taskId < a.taskId ? -1 : 0;
  }
  function messageComparator(a, b) {
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
    return b.messageId > a.messageId ? 1 : b.messageId < a.messageId ? -1 : 0;
  }

  // ---- tasks ----
  function renderTaskRow(t, id, gen) {
    var row = el("button", { className: "list-row" });
    row.type = "button";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", state.selectedTaskId === t.taskId ? "true" : "false");
    var head = el("div", { className: "row" });
    head.appendChild(el("span", { className: "badge", text: t.protocolState }));
    head.appendChild(el("span", { className: "meta", text: fmtTime(t.updatedAt) }));
    row.appendChild(head);
    row.appendChild(el("div", { className: "preview" + (t.title ? " task-title" : ""), text: taskListLabel(t) }));
    row.addEventListener("click", function () { selectTask(t, id, gen, row); });
    return row;
  }

  function renderTaskDetail(t, id, gen) {
    var wrap = el("div");
    wrap.appendChild(renderBackButton("tasks"));
    var head = el("div", { className: "row" });
    head.appendChild(el("span", { className: "badge", text: t.protocolState }));
    head.appendChild(el("span", { className: "meta", text: "Task " + t.taskId }));
    wrap.appendChild(head);
    if (t.title) wrap.appendChild(el("p", { className: "meta task-detail-title", text: t.title }));
    wrap.appendChild(el("p", { className: "meta", text: "Iteration " + t.iteration + " · waiting for " + (t.waitingFor || "none") + " · started " + fmtTime(t.taskStartedAt) + " · updated " + fmtTime(t.updatedAt) }));
    wrap.appendChild(renderStageIndicator(taskStage(t)));
    wrap.appendChild(renderTextSection("task-detail-goal", "Goal", t.goal));
    if (t.terminalSummary) {
      var summaryHeading = (t.protocolState === "DONE" || t.protocolState === "BLOCKED") ? "Terminal summary" : "Proposed completion";
      wrap.appendChild(renderTextSection("task-detail-summary", summaryHeading, t.terminalSummary));
    }
    wrap.appendChild(renderTaskHistory(t));
    if (t.protocolState === "WAITING_LOCAL" && t.waitingFor === "LOCAL_DECISION") {
      var actions = el("div", { className: "decision-actions" });
      var completeBtn = el("button", { text: "Complete task" });
      completeBtn.addEventListener("click", function () {
        wsApiFor(id, "/complete-task", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: t.taskId }) }).then(function () {
          if (gen === state.selectionGen) loadDetail(id, gen);
        });
      });
      actions.appendChild(completeBtn);
      var continueBtn = el("button", { text: "Continue implementation" });
      continueBtn.addEventListener("click", function () {
        wsApiFor(id, "/continue-task", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: t.taskId }) }).then(function () {
          if (gen === state.selectionGen) loadDetail(id, gen);
        });
      });
      actions.appendChild(continueBtn);
      wrap.appendChild(actions);
    }
    if (t.protocolState !== "DONE" && t.protocolState !== "BLOCKED") {
      var discardBtn = el("button", { className: "danger", text: "Discard task" });
      discardBtn.addEventListener("click", function () {
        if (!confirm("Discard task " + t.taskId + "? This marks it BLOCKED and clears its queued messages.")) return;
        wsApiFor(id, "/discard-task", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: t.taskId }) }).then(function () {
          if (gen === state.selectionGen) loadDetail(id, gen);
        });
      });
      wrap.appendChild(discardBtn);
    }
    return wrap;
  }

  // selectTask/selectMessage always take the row *object* (not a bare id) —
  // see docs/plans/dashboard-ux-redesign.md's "選択スナップショットの契約":
  // the id+object pair is set together so the detail pane can survive a
  // later poll dropping this row off the first page.
  function selectTask(t, id, gen, rowEl) {
    var taskChanged = state.selectedTaskId !== t.taskId;
    state.selectedTaskId = t.taskId;
    state.selectedTask = t;
    state.selectedTaskRowEl = rowEl || null;
    if (taskChanged) loadTaskHistory(t.taskId, id, gen);
    renderTasksList(id, gen);
    renderDetailPane("tasks", renderTaskDetail(t, id, gen));
    openDetail();
  }

  function renderTasksList(id, gen) {
    var listEl2 = document.getElementById("tasks-list");
    clearEl(listEl2);
    state.tasks.forEach(function (t) { listEl2.appendChild(renderTaskRow(t, id, gen)); });
    if (!state.tasks.length) listEl2.appendChild(el("p", { className: "note", text: "No tasks yet." }));
  }

  function updateSelectedTaskFromRows(rows, id, gen) {
    if (!state.selectedTaskId) return;
    var fresh = rows.filter(function (t) { return t.taskId === state.selectedTaskId; })[0];
    if (fresh) {
      var historyChanged = state.selectedTask && state.selectedTask.updatedAt !== fresh.updatedAt;
      state.selectedTask = fresh;
      if (historyChanged) loadTaskHistory(fresh.taskId, id, gen);
      renderDetailPane("tasks", renderTaskDetail(state.selectedTask, id, gen));
    }
  }

  function loadTasks(id, gen, more) {
    var loadMoreBtn = document.getElementById("tasks-load-more");
    var q = "?limit=20" + (more && state.tasksCursor ? "&cursor=" + encodeURIComponent(state.tasksCursor) : "");
    wsApiFor(id, "/tasks" + q).then(function (res) {
      if (!res.ok || gen !== state.selectionGen) return;
      var rows = res.body.tasks || [];
      if (more) {
        state.tasks = mergeRows(state.tasks, rows, "taskId", taskComparator);
        state.tasksCursor = res.body.nextCursor;
        state.tasksExpanded = true;
      } else if (state.tasksExpanded) {
        if (res.body.nextCursor) {
          state.tasks = mergeRows(state.tasks, rows, "taskId", taskComparator);
        } else {
          state.tasks = rows;
          state.tasksCursor = null;
          state.tasksExpanded = false;
        }
        updateSelectedTaskFromRows(rows, id, gen);
      } else {
        state.tasks = rows;
        state.tasksCursor = res.body.nextCursor;
        updateSelectedTaskFromRows(rows, id, gen);
      }
      renderTasksList(id, gen);
      loadMoreBtn.hidden = !state.tasksCursor;
    });
  }
  document.getElementById("tasks-load-more").addEventListener("click", function () {
    if (state.workspaceId) loadTasks(state.workspaceId, state.selectionGen, true);
  });

  // ---- messages ----
  function renderMessageRow(m, id, gen) {
    var row = el("button", { className: "list-row" });
    row.type = "button";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", state.selectedMessageId === m.messageId ? "true" : "false");
    var head = el("div", { className: "row" });
    head.appendChild(el("span", { className: "badge", text: m.state }));
    head.appendChild(el("span", { className: "meta", text: fmtTime(m.createdAt) }));
    row.appendChild(head);
    row.appendChild(el("div", { className: "preview", text: truncateText(m.body, LIST_PREVIEW_CHARS).text }));
    row.addEventListener("click", function () { selectMessage(m, id, gen, row); });
    return row;
  }

  function renderMessageDetail(m, id, gen) {
    var wrap = el("div");
    wrap.appendChild(renderBackButton("messages"));
    var head = el("div", { className: "row" });
    head.appendChild(el("span", { className: "badge", text: m.dir }));
    head.appendChild(el("span", { className: "badge", text: m.kind }));
    head.appendChild(el("span", { className: "badge", text: m.state }));
    wrap.appendChild(head);
    wrap.appendChild(el("p", { className: "meta", text: "task=" + m.taskId + " iter=" + m.iteration + " " + fmtTime(m.createdAt) }));
    wrap.appendChild(renderStageIndicator(messageStage(m)));
    wrap.appendChild(renderTextSection("message-detail-body", "Body", m.body));
    if (m.dir === "to_local" && m.state !== "acked") {
      var ackBtn = el("button", { text: "Ack" });
      ackBtn.addEventListener("click", function () {
        wsApiFor(id, "/ack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId: m.messageId }) }).then(function () {
          if (gen === state.selectionGen) {
            loadMessages(id, gen, false);
            loadOverview(id, gen);
            loadTasks(id, gen, false);
          }
        });
      });
      wrap.appendChild(ackBtn);
    }
    var canDiscardDirectly = m.state !== "acked" && !(state.activeTaskId === m.taskId);
    if (canDiscardDirectly) {
      var discardBtn = el("button", { className: "danger", text: "Discard" });
      discardBtn.addEventListener("click", function () {
        if (!confirm("Discard this message?")) return;
        wsApiFor(id, "/discard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId: m.messageId }) }).then(function (res) {
          if (res.body && res.body.error === "USE_DISCARD_TASK") {
            alert("This message belongs to the active task; discard the task instead.");
          }
          if (gen === state.selectionGen) loadDetail(id, gen);
        });
      });
      wrap.appendChild(discardBtn);
    } else if (m.state !== "acked" && state.activeTaskId === m.taskId) {
      wrap.appendChild(el("span", { className: "note", text: "(part of the active task — use \"Discard task\" above)" }));
    }
    return wrap;
  }

  function selectMessage(m, id, gen, rowEl) {
    state.selectedMessageId = m.messageId;
    state.selectedMessage = m;
    state.selectedMessageRowEl = rowEl || null;
    renderMessagesList(id, gen);
    renderDetailPane("messages", renderMessageDetail(m, id, gen));
    openDetail();
  }

  function renderMessagesList(id, gen) {
    var listEl2 = document.getElementById("messages-list");
    clearEl(listEl2);
    state.messages.forEach(function (m) { listEl2.appendChild(renderMessageRow(m, id, gen)); });
    if (!state.messages.length) listEl2.appendChild(el("p", { className: "note", text: "No messages yet." }));
  }

  function updateSelectedMessageFromRows(rows, id, gen) {
    if (!state.selectedMessageId) return;
    var fresh = rows.filter(function (m) { return m.messageId === state.selectedMessageId; })[0];
    if (fresh) {
      state.selectedMessage = fresh;
      renderDetailPane("messages", renderMessageDetail(state.selectedMessage, id, gen));
    }
  }

  function loadMessages(id, gen, more) {
    var loadMoreBtn = document.getElementById("messages-load-more");
    var q = "?limit=20" + (more && state.messagesCursor ? "&cursor=" + encodeURIComponent(state.messagesCursor) : "");
    wsApiFor(id, "/messages" + q).then(function (res) {
      if (!res.ok || gen !== state.selectionGen) return;
      var rows = res.body.messages || [];
      if (more) {
        state.messages = mergeRows(state.messages, rows, "messageId", messageComparator);
        state.messagesCursor = res.body.nextCursor;
        state.messagesExpanded = true;
      } else if (state.messagesExpanded) {
        if (res.body.nextCursor) {
          state.messages = mergeRows(state.messages, rows, "messageId", messageComparator);
        } else {
          state.messages = rows;
          state.messagesCursor = null;
          state.messagesExpanded = false;
        }
        updateSelectedMessageFromRows(rows, id, gen);
      } else {
        state.messages = rows;
        state.messagesCursor = res.body.nextCursor;
        updateSelectedMessageFromRows(rows, id, gen);
      }
      renderMessagesList(id, gen);
      loadMoreBtn.hidden = !state.messagesCursor;
    });
  }
  document.getElementById("messages-load-more").addEventListener("click", function () {
    if (state.workspaceId) loadMessages(state.workspaceId, state.selectionGen, true);
  });

  function loadDetail(id, gen) {
    loadOverview(id, gen);
    loadGuidance(id, gen);
    loadLimits(id, gen);
    loadBrowserSettings(id, gen);
    loadMessages(id, gen, false);
    loadTasks(id, gen, false);
  }

  loadWorkspaceList();
  loadHubBrowserSettings();
  setInterval(function () {
    loadWorkspaceList();
    if (state.workspaceId) loadDetail(state.workspaceId, state.selectionGen);
  }, POLL_MS);
})();
