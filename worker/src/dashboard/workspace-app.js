(function () {
  "use strict";
  var parts = location.pathname.split("/").filter(Boolean);
  var workspaceId = parts[1] || "";
  var base = "/dashboard/" + workspaceId;
  var POLL_MS = 10000;

  function api(path, options) {
    return fetch(base + path, Object.assign({ credentials: "same-origin" }, options || {})).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        return { ok: res.ok, status: res.status, body: body };
      });
    });
  }

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
      api("/login", {
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

  // ---- dashboard shell ----
  var overviewEl = document.getElementById("overview");
  if (!overviewEl) return; // neither page — app.js loaded somewhere unexpected

  var state = { activeTaskId: null, messagesCursor: null, tasksCursor: null };

  document.getElementById("logout-btn").addEventListener("click", function () {
    api("/logout", { method: "POST" }).then(function () { location.reload(); });
  });

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

  function loadOverview() {
    api("/api/overview").then(function (res) {
      if (res.ok) renderOverview(res.body);
    });
  }

  // ---- guidance ----
  function loadGuidance() {
    api("/api/guidance").then(function (res) {
      if (res.ok) document.getElementById("guidance-text").value = res.body.guidance || "";
    });
  }
  document.getElementById("guidance-save").addEventListener("click", function () {
    var text = document.getElementById("guidance-text").value;
    api("/api/guidance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: text }) });
  });
  document.getElementById("guidance-clear").addEventListener("click", function () {
    api("/api/guidance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clear: true }) }).then(function () {
      document.getElementById("guidance-text").value = "";
    });
  });

  // ---- limits ----
  function loadLimits() {
    api("/api/limits").then(function (res) {
      if (res.ok) document.getElementById("limits-value").value = res.body.maxBodyBytes;
    });
  }
  document.getElementById("limits-save").addEventListener("click", function () {
    var value = Number(document.getElementById("limits-value").value);
    api("/api/limits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxBodyBytes: value }) }).then(loadLimits);
  });
  document.getElementById("limits-reset").addEventListener("click", function () {
    api("/api/limits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxBodyBytes: null }) }).then(loadLimits);
  });

  // ---- new task ----
  document.getElementById("new-task-submit").addEventListener("click", function () {
    var goal = document.getElementById("new-task-goal").value;
    var force = document.getElementById("new-task-force").checked;
    var statusEl = document.getElementById("new-task-status");
    if (!goal.trim()) { statusEl.textContent = "Goal is required."; return; }
    if (force && !confirm("This will BLOCK the currently active task. Continue?")) return;
    statusEl.textContent = "Starting…";
    api("/api/start-task", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: goal, force: force }) }).then(function (res) {
      if (!res.ok || res.body.error) {
        statusEl.textContent = "Failed: " + (res.body.error || res.status);
        return;
      }
      var nudgeStatus = res.body.nudge && res.body.nudge.status;
      statusEl.textContent = "Task " + res.body.task.taskId + " queued. Browser notification: " + (nudgeStatus || "unknown") + ".";
      document.getElementById("new-task-goal").value = "";
      document.getElementById("new-task-force").checked = false;
      loadAll();
    });
  });

  // ---- messages ----
  function renderMessage(m) {
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
        // object through as loadMessages(more), which loadMessages() treats as a
        // truthy "load more" flag (skips clearing the list, and may fetch the
        // next cursor page instead of refreshing the first page).
        api("/api/ack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId: m.messageId }) }).then(function () {
          loadMessages(false);
        });
      });
      item.appendChild(ackBtn);
    }
    var canDiscardDirectly = m.state !== "acked" && !(m.dir === "to_gpt" && state.activeTaskId === m.taskId);
    if (canDiscardDirectly) {
      var discardBtn = el("button", { className: "danger", text: "Discard" });
      discardBtn.addEventListener("click", function () {
        if (!confirm("Discard this message?")) return;
        api("/api/discard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId: m.messageId }) }).then(function (res) {
          if (res.body && res.body.error === "USE_DISCARD_TASK") {
            alert("This message belongs to the active task; discard the task instead.");
          }
          loadMessages();
        });
      });
      item.appendChild(discardBtn);
    } else if (m.dir === "to_gpt" && m.state !== "acked" && state.activeTaskId === m.taskId) {
      item.appendChild(el("span", { className: "note", text: " (part of the active task — use \"Discard task\" below)" }));
    }
    return item;
  }

  function loadMessages(more) {
    var listEl = document.getElementById("messages-list");
    var loadMoreBtn = document.getElementById("messages-load-more");
    var q = "?limit=20" + (more && state.messagesCursor ? "&cursor=" + encodeURIComponent(state.messagesCursor) : "");
    api("/api/messages" + q).then(function (res) {
      if (!res.ok) return;
      if (!more) clearEl(listEl);
      res.body.messages.forEach(function (m) { listEl.appendChild(renderMessage(m)); });
      state.messagesCursor = res.body.nextCursor;
      loadMoreBtn.hidden = !res.body.nextCursor;
    });
  }
  document.getElementById("messages-load-more").addEventListener("click", function () { loadMessages(true); });

  // ---- tasks ----
  function renderTask(t) {
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
        api("/api/discard-task", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: t.taskId }) }).then(loadAll);
      });
      item.appendChild(discardBtn);
    }
    return item;
  }

  function loadTasks(more) {
    var listEl = document.getElementById("tasks-list");
    var loadMoreBtn = document.getElementById("tasks-load-more");
    var q = "?limit=20" + (more && state.tasksCursor ? "&cursor=" + encodeURIComponent(state.tasksCursor) : "");
    api("/api/tasks" + q).then(function (res) {
      if (!res.ok) return;
      if (!more) clearEl(listEl);
      res.body.tasks.forEach(function (t) { listEl.appendChild(renderTask(t)); });
      state.tasksCursor = res.body.nextCursor;
      loadMoreBtn.hidden = !res.body.nextCursor;
    });
  }
  document.getElementById("tasks-load-more").addEventListener("click", function () { loadTasks(true); });

  function loadAll() {
    loadOverview();
    loadGuidance();
    loadLimits();
    loadMessages(false);
    loadTasks(false);
  }

  loadAll();
  setInterval(function () {
    loadOverview();
    loadMessages(false);
    loadTasks(false);
  }, POLL_MS);
})();
