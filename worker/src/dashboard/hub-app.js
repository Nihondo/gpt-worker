(function () {
  "use strict";
  var HUB_BASE = "/dashboard/hub";
  var POLL_MS = 10000;

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
  var state = { workspaceId: null, selectionGen: 0, activeTaskId: null, messagesCursor: null, tasksCursor: null };

  document.getElementById("logout-btn").addEventListener("click", function () {
    hubApi("/logout", { method: "POST" }).then(function () { location.reload(); });
  });

  // ---- workspace list ----
  function renderWorkspaceList(data) {
    clearEl(listEl);
    var workspaces = data.workspaces || [];
    workspaces.forEach(function (w) {
      var item = el("div", { className: "item" });
      var head = el("div", { className: "row" });
      var nameBtn = el("button", { className: w.workspaceId === state.workspaceId ? "" : "secondary", text: w.name });
      nameBtn.addEventListener("click", function () { selectWorkspace(w.workspaceId, w.name); });
      head.appendChild(nameBtn);
      head.appendChild(el("span", { className: "note", text: w.workspaceId }));
      item.appendChild(head);
      if (w.error) {
        item.appendChild(el("p", { className: "error", text: "Unavailable: " + w.error }));
      } else if (w.overview) {
        var line = el("p", { className: "meta" });
        line.textContent = (w.overview.connected ? "connected" : "not connected") + " · to ChatGPT " + w.overview.pendingToGpt + " · to local " + w.overview.pendingToLocal + (w.overview.activeTask ? " · active: " + w.overview.activeTask.protocolState : "");
        item.appendChild(line);
      }
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
    state.selectionGen += 1;
    state.activeTaskId = null;
    state.messagesCursor = null;
    state.tasksCursor = null;
    detailEl.hidden = false;
    detailTitleEl.textContent = name + " (" + id + ")";
    // Clear the previously selected workspace's rendered detail
    // immediately, before the newly selected workspace's own data arrives —
    // otherwise the old workspace's messages/tasks/guidance/limits (and
    // their click handlers, still bound to the old workspaceId) would stay
    // visible and clickable during the load.
    clearEl(overviewEl);
    document.getElementById("guidance-text").value = "";
    document.getElementById("limits-value").value = "";
    clearEl(document.getElementById("messages-list"));
    clearEl(document.getElementById("tasks-list"));
    document.getElementById("messages-load-more").hidden = true;
    document.getElementById("tasks-load-more").hidden = true;
    document.getElementById("new-task-status").textContent = "";
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

  // ---- guidance ----
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

  // ---- limits ----
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

  // ---- messages ----
  function renderMessage(m, id, gen) {
    var item = el("div", { className: "item" });
    var head = el("div");
    head.appendChild(el("span", { className: "badge", text: m.dir }));
    head.appendChild(el("span", { className: "badge", text: m.kind }));
    head.appendChild(el("span", { className: "badge", text: m.state }));
    head.appendChild(el("span", { text: " task=" + m.taskId + " iter=" + m.iteration + " " + fmtTime(m.createdAt) }));
    item.appendChild(head);
    var pre = el("pre", { text: m.body });
    item.appendChild(pre);
    if (m.dir === "to_local" && m.state !== "acked") {
      var ackBtn = el("button", { text: "Ack" });
      ackBtn.addEventListener("click", function () {
        // Not .then(loadMessages) — that would pass the resolved {ok,status,body}
        // object through as loadMessages(id, gen, more), which loadMessages()
        // treats as a truthy "load more" flag (skips clearing the list, and
        // may fetch the next cursor page instead of refreshing the first page).
        wsApiFor(id, "/ack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId: m.messageId }) }).then(function () {
          if (gen === state.selectionGen) loadMessages(id, gen, false);
        });
      });
      item.appendChild(ackBtn);
    }
    var canDiscardDirectly = m.state !== "acked" && !(m.dir === "to_gpt" && state.activeTaskId === m.taskId);
    if (canDiscardDirectly) {
      var discardBtn = el("button", { className: "danger", text: "Discard" });
      discardBtn.addEventListener("click", function () {
        if (!confirm("Discard this message?")) return;
        wsApiFor(id, "/discard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId: m.messageId }) }).then(function (res) {
          if (res.body && res.body.error === "USE_DISCARD_TASK") {
            alert("This message belongs to the active task; discard the task instead.");
          }
          if (gen === state.selectionGen) loadMessages(id, gen, false);
        });
      });
      item.appendChild(discardBtn);
    } else if (m.dir === "to_gpt" && m.state !== "acked" && state.activeTaskId === m.taskId) {
      item.appendChild(el("span", { className: "note", text: " (part of the active task — use \"Discard task\" below)" }));
    }
    return item;
  }

  function loadMessages(id, gen, more) {
    var listEl2 = document.getElementById("messages-list");
    var loadMoreBtn = document.getElementById("messages-load-more");
    var q = "?limit=20" + (more && state.messagesCursor ? "&cursor=" + encodeURIComponent(state.messagesCursor) : "");
    wsApiFor(id, "/messages" + q).then(function (res) {
      if (!res.ok || gen !== state.selectionGen) return;
      if (!more) clearEl(listEl2);
      res.body.messages.forEach(function (m) { listEl2.appendChild(renderMessage(m, id, gen)); });
      state.messagesCursor = res.body.nextCursor;
      loadMoreBtn.hidden = !res.body.nextCursor;
    });
  }
  document.getElementById("messages-load-more").addEventListener("click", function () {
    if (state.workspaceId) loadMessages(state.workspaceId, state.selectionGen, true);
  });

  // ---- tasks ----
  function renderTask(t, id, gen) {
    var item = el("div", { className: "item" });
    var head = el("div");
    head.appendChild(el("span", { className: "badge", text: t.protocolState }));
    head.appendChild(el("span", { text: t.taskId + " · updated " + fmtTime(t.updatedAt) }));
    item.appendChild(head);
    item.appendChild(el("div", { text: t.goal }));
    if (t.terminalSummary) item.appendChild(el("pre", { text: t.terminalSummary }));
    if (t.protocolState !== "DONE" && t.protocolState !== "BLOCKED") {
      var discardBtn = el("button", { className: "danger", text: "Discard task" });
      discardBtn.addEventListener("click", function () {
        if (!confirm("Discard task " + t.taskId + "? This marks it BLOCKED and clears its queued messages.")) return;
        wsApiFor(id, "/discard-task", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: t.taskId }) }).then(function () {
          if (gen === state.selectionGen) loadDetail(id, gen);
        });
      });
      item.appendChild(discardBtn);
    }
    return item;
  }

  function loadTasks(id, gen, more) {
    var listEl3 = document.getElementById("tasks-list");
    var loadMoreBtn = document.getElementById("tasks-load-more");
    var q = "?limit=20" + (more && state.tasksCursor ? "&cursor=" + encodeURIComponent(state.tasksCursor) : "");
    wsApiFor(id, "/tasks" + q).then(function (res) {
      if (!res.ok || gen !== state.selectionGen) return;
      if (!more) clearEl(listEl3);
      res.body.tasks.forEach(function (t) { listEl3.appendChild(renderTask(t, id, gen)); });
      state.tasksCursor = res.body.nextCursor;
      loadMoreBtn.hidden = !res.body.nextCursor;
    });
  }
  document.getElementById("tasks-load-more").addEventListener("click", function () {
    if (state.workspaceId) loadTasks(state.workspaceId, state.selectionGen, true);
  });

  function loadDetail(id, gen) {
    loadOverview(id, gen);
    loadGuidance(id, gen);
    loadLimits(id, gen);
    loadMessages(id, gen, false);
    loadTasks(id, gen, false);
  }

  loadWorkspaceList();
  setInterval(function () {
    loadWorkspaceList();
    if (state.workspaceId) loadDetail(state.workspaceId, state.selectionGen);
  }, POLL_MS);
})();
