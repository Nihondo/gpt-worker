(function () {
  "use strict";
  var HUB_BASE = "/dashboard/hub";
  var LIST_POLL_MS = 60000;
  var ACTIVE_POLL_MS = 30000;
  var IDLE_POLL_MS = 120000;
  function api(base, path, options) {
    return fetch(base + path, Object.assign({ credentials: "same-origin" }, options || {})).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
    });
  }
  function hubApi(path, options) { return api(HUB_BASE, path, options); }
  function wsApiFor(workspaceId, path, options) { return api(HUB_BASE + "/api/workspaces/" + workspaceId, path, options); }

  var loginForm = document.getElementById("login-form");
  if (loginForm) {
    loginForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var tokenInput = document.getElementById("owner_token"), errorEl = document.getElementById("login-error"); errorEl.hidden = true;
      hubApi("/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ownerToken: tokenInput.value }) }).then(function (res) {
        if (res.ok) { location.reload(); return; }
        errorEl.textContent = res.status === 403 ? "Invalid owner token." : "Login failed (" + res.status + ")."; errorEl.hidden = false;
      });
    });
    return;
  }
  var listEl = document.getElementById("workspace-list");
  if (!listEl) return;

  document.getElementById("logout-btn").addEventListener("click", function () { hubApi("/logout", { method: "POST" }).then(function () { location.reload(); }); });
  Promise.all([import("./workspace-panel.js"), import("./common-app.js")]).then(function (modules) {
    var createWorkspacePanel = modules[0].createWorkspacePanel, helpers = modules[1];
    var state = { workspaceId: null, selectionGen: 0 };
    var detailEl = document.getElementById("workspace-detail"), detailTitleEl = document.getElementById("detail-title"), panel;
    function updateWorkspaceSelection(workspaceId) {
      Array.prototype.forEach.call(document.querySelectorAll(".workspace-choice"), function (button) {
        var selected = button.getAttribute("data-workspace-id") === workspaceId;
        button.classList.toggle("selected", selected);
        if (selected) button.setAttribute("aria-current", "true"); else button.removeAttribute("aria-current");
      });
    }
    function renderWorkspaceList(data) {
      helpers.clearEl(listEl);
      var workspaces = data.workspaces || [];
      workspaces.forEach(function (w) {
        var item = helpers.el("div", { className: "workspace-item" });
        var nameBtn = helpers.el("button", { className: "workspace-choice" + (w.workspaceId === state.workspaceId ? " selected" : ""), text: w.name });
        nameBtn.setAttribute("data-workspace-id", w.workspaceId);
        if (w.workspaceId === state.workspaceId) nameBtn.setAttribute("aria-current", "true");
        nameBtn.addEventListener("click", function () { selectWorkspace(w.workspaceId, w.name); }); item.appendChild(nameBtn);
        var status = w.error ? "Unavailable" : (w.overview && w.overview.activeTask ? "In progress" : "Idle");
        item.appendChild(helpers.el("span", { className: "workspace-status" + (status === "In progress" ? " active" : ""), text: status })); listEl.appendChild(item);
      });
      if (!workspaces.length) listEl.appendChild(helpers.el("p", { className: "note", text: "No workspaces registered yet." }));
    }
    function loadWorkspaceList() { return hubApi("/api/workspaces").then(function (res) { if (res.ok) renderWorkspaceList(res.body); }); }
    function updateWorkspaceRowStatus(workspaceId, overview, error) {
      var btn = listEl.querySelector('.workspace-choice[data-workspace-id="' + workspaceId + '"]');
      if (!btn || !btn.parentElement) return;
      var statusSpan = btn.parentElement.querySelector(".workspace-status");
      if (!statusSpan) return;
      var status = error ? "Unavailable" : (overview && overview.activeTask ? "In progress" : "Idle");
      statusSpan.textContent = status;
      statusSpan.className = "workspace-status" + (status === "In progress" ? " active" : "");
    }
    function refreshSingleWorkspaceStatus(workspaceId) {
      wsApiFor(workspaceId, "/overview").then(function (res) {
        if (res.ok) {
          updateWorkspaceRowStatus(workspaceId, res.body, null);
        } else {
          updateWorkspaceRowStatus(workspaceId, null, res.body && res.body.error ? res.body.error : "ERROR");
        }
      }).catch(function () {
        updateWorkspaceRowStatus(workspaceId, null, "ERROR");
      });
    }
    panel = createWorkspacePanel({
      request: function (target, path, options) { return wsApiFor(target.workspaceId, path, options); },
      isCurrent: function (target) { return state.workspaceId === target.workspaceId && state.selectionGen === target.generation; },
      onOverview: function (data, target) {
        if (state.workspaceId === target.workspaceId && state.selectionGen === target.generation) {
          updateWorkspaceRowStatus(target.workspaceId, data, null);
        }
      },
      onActivityStateChanged: function () { if (state.workspaceId && !document.hidden && !wsHealthy) scheduleNextActivity(); },
      discardMessageRefresh: "all",
    });

    var RECONNECT_CAP_MS = 60000;
    var ws = null;
    var wsHealthy = false;
    var hasConnectedOnce = false;
    var initialLoadDone = false;
    var reconnectTimer = null;
    var reconnectDelay = 5000;
    var pendingRegistry = false;
    var pendingHubSettings = false;
    var pendingWorkspaceEvents = {};

    var listTimer = null;
    var listPolling = false;
    function clearListTimer() {
      if (listTimer) { clearTimeout(listTimer); listTimer = null; }
    }
    function scheduleNextList() {
      clearListTimer();
      if (document.hidden || wsHealthy) return;
      listTimer = setTimeout(function () { runListPoll(); }, LIST_POLL_MS);
    }
    function runListPoll() {
      clearListTimer();
      if (document.hidden || wsHealthy || listPolling) return;
      listPolling = true;
      Promise.resolve(loadWorkspaceList()).then(function () {
        listPolling = false;
        if (!document.hidden && !wsHealthy) scheduleNextList();
      }, function () {
        listPolling = false;
        if (!document.hidden && !wsHealthy) scheduleNextList();
      });
    }

    var activityTimer = null;
    var activityPolling = false;
    function clearActivityTimer() {
      if (activityTimer) { clearTimeout(activityTimer); activityTimer = null; }
    }
    function scheduleNextActivity() {
      clearActivityTimer();
      if (document.hidden || !state.workspaceId || wsHealthy) return;
      var delay = panel.hasActiveTask() ? ACTIVE_POLL_MS : IDLE_POLL_MS;
      activityTimer = setTimeout(function () { runActivityPoll(); }, delay);
    }
    function runActivityPoll() {
      clearActivityTimer();
      if (document.hidden || !state.workspaceId || wsHealthy || activityPolling) return;
      activityPolling = true;
      Promise.resolve(panel.pollActivity()).then(function () {
        activityPolling = false;
        if (!document.hidden && state.workspaceId && !wsHealthy) scheduleNextActivity();
      }, function () {
        activityPolling = false;
        if (!document.hidden && state.workspaceId && !wsHealthy) scheduleNextActivity();
      });
    }

    function clearReconnectTimer() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    }

    function scheduleReconnect() {
      if (reconnectTimer || document.hidden || wsHealthy) return;
      var delay = reconnectDelay;
      reconnectDelay = reconnectDelay === 5000 ? 15000 : reconnectDelay === 15000 ? 30000 : RECONNECT_CAP_MS;
      reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        if (!wsHealthy && !document.hidden) connectWs();
      }, delay);
    }

    function handleWsDown(socket) {
      if (socket && socket !== ws) return;
      ws = null;
      wsHealthy = false;
      if (!document.hidden) {
        scheduleNextList();
        if (state.workspaceId) scheduleNextActivity();
        scheduleReconnect();
      }
    }

    function handleWorkspaceInvalidate(workspaceId, scope) {
      if (scope === "settings") {
        if (state.workspaceId === workspaceId) panel.refreshAll();
      } else {
        if (state.workspaceId === workspaceId) {
          panel.pollActivity();
        } else {
          refreshSingleWorkspaceStatus(workspaceId);
        }
      }
    }

    function handleHubInvalidate(scope) {
      if (scope === "registry") {
        loadWorkspaceList();
      } else if (scope === "settings") {
        loadHubBrowserSettings();
        if (state.workspaceId) panel.refreshAll();
      }
    }

    function connectWs() {
      if (ws || document.hidden) return;
      var wsProto = location.protocol === "https:" ? "wss:" : "ws:";
      var wsUrl = wsProto + "//" + location.host + HUB_BASE + "/ws";
      var socket;
      try {
        socket = new WebSocket(wsUrl);
      } catch (err) {
        handleWsDown(null);
        return;
      }
      ws = socket;
      socket.onopen = function () {
        if (socket !== ws) return;
        wsHealthy = true;
        reconnectDelay = 5000;
        clearReconnectTimer();
        clearListTimer();
        clearActivityTimer();
        if (hasConnectedOnce) {
          loadWorkspaceList();
          loadHubBrowserSettings();
          if (state.workspaceId) panel.refreshAll();
        } else {
          hasConnectedOnce = true;
          if (initialLoadDone) {
            loadWorkspaceList();
            loadHubBrowserSettings();
            if (state.workspaceId) panel.refreshAll();
          }
        }
      };
      socket.onmessage = function (ev) {
        if (socket !== ws) return;
        var data;
        try { data = JSON.parse(ev.data); } catch { return; }
        if (!data || data.type !== "invalidate") return;
        if (document.hidden || !initialLoadDone) {
          if (data.workspaceId) {
            var prev = pendingWorkspaceEvents[data.workspaceId];
            pendingWorkspaceEvents[data.workspaceId] = (prev === "settings" || data.scope === "settings") ? "settings" : "activity";
          } else {
            if (data.scope === "registry") pendingRegistry = true;
            if (data.scope === "settings") pendingHubSettings = true;
          }
          return;
        }
        if (data.workspaceId) {
          handleWorkspaceInvalidate(data.workspaceId, data.scope);
        } else {
          handleHubInvalidate(data.scope);
        }
      };
      socket.onclose = function () { handleWsDown(socket); };
      socket.onerror = function () { handleWsDown(socket); };
    }

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        clearListTimer();
        clearActivityTimer();
        clearReconnectTimer();
      } else {
        if (wsHealthy) {
          if (pendingRegistry) {
            pendingRegistry = false;
            loadWorkspaceList();
          }
          if (pendingHubSettings) {
            pendingHubSettings = false;
            loadHubBrowserSettings();
            if (state.workspaceId) panel.refreshAll();
          }
          var wKeys = Object.keys(pendingWorkspaceEvents);
          if (wKeys.length) {
            var events = pendingWorkspaceEvents;
            pendingWorkspaceEvents = {};
            wKeys.forEach(function (wId) {
              handleWorkspaceInvalidate(wId, events[wId]);
            });
          }
        } else {
          reconnectDelay = 5000;
          clearReconnectTimer();
          connectWs();
          runListPoll();
          if (state.workspaceId) runActivityPoll();
        }
      }
    });

    function selectWorkspace(id, name) {
      state.workspaceId = id; updateWorkspaceSelection(id); state.selectionGen += 1;
      var target = Object.freeze({ workspaceId: id, generation: state.selectionGen });
      detailEl.hidden = false; detailTitleEl.textContent = name + " (" + id + ")";
      document.getElementById("guidance-text").value = ""; document.getElementById("limits-value").value = ""; document.getElementById("chat-project-override").value = ""; document.getElementById("conversation-url").value = ""; document.getElementById("new-task-status").textContent = "";
      document.getElementById("chat-project-override-error").hidden = true; document.getElementById("conversation-url-error").hidden = true;
      Array.prototype.forEach.call(document.querySelectorAll(".hub-gated"), function (gated) { gated.hidden = false; });
      clearActivityTimer();
      var activation = panel.activate(target, { clearView: true });
      activation.then(function () {
        if (state.workspaceId === id && state.selectionGen === target.generation) {
          if (!document.hidden && !wsHealthy) scheduleNextActivity();
        }
      }, function () {
        if (state.workspaceId === id && state.selectionGen === target.generation) {
          if (!document.hidden && !wsHealthy) scheduleNextActivity();
        }
      });
    }
    function loadHubBrowserSettings() { return hubApi("/api/browser-settings").then(function (res) { if (res.ok) document.getElementById("hub-shared-project-url").value = res.body.chatUrl || ""; }); }
    function saveHubBrowserSettings(value, failure) {
      var error = document.getElementById("hub-shared-project-error"); error.hidden = true; error.textContent = "";
      hubApi("/api/browser-settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatUrl: value }) }).then(function (res) {
        if (!res.ok || res.body.error) { error.hidden = false; error.textContent = res.body.message || res.body.error || failure; } else loadHubBrowserSettings();
      });
    }
    document.getElementById("hub-shared-project-save").addEventListener("click", function () { saveHubBrowserSettings(document.getElementById("hub-shared-project-url").value.trim() || null, "Failed to save shared project URL."); });
    document.getElementById("hub-shared-project-clear").addEventListener("click", function () { saveHubBrowserSettings(null, "Failed to clear shared project URL."); });
    connectWs();
    function onHubInitialLoadSettled() {
      initialLoadDone = true;
      if (!document.hidden) {
        if (pendingRegistry) {
          pendingRegistry = false;
          loadWorkspaceList();
        }
        if (pendingHubSettings) {
          pendingHubSettings = false;
          loadHubBrowserSettings();
          if (state.workspaceId) panel.refreshAll();
        }
        var wKeys = Object.keys(pendingWorkspaceEvents);
        if (wKeys.length) {
          var events = pendingWorkspaceEvents;
          pendingWorkspaceEvents = {};
          wKeys.forEach(function (wId) {
            handleWorkspaceInvalidate(wId, events[wId]);
          });
        }
        if (!wsHealthy) scheduleNextList();
      }
    }
    Promise.all([loadWorkspaceList(), loadHubBrowserSettings()]).then(onHubInitialLoadSettled, onHubInitialLoadSettled);
  });
})();
