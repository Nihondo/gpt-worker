(function () {
  "use strict";
  var parts = location.pathname.split("/").filter(Boolean);
  var workspaceId = parts[1] || "";
  var base = "/dashboard/" + workspaceId;
  var ACTIVE_POLL_MS = 30000;
  var IDLE_POLL_MS = 120000;

  function api(path, options) {
    return fetch(base + path, Object.assign({ credentials: "same-origin" }, options || {})).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
    });
  }

  var loginForm = document.getElementById("login-form");
  if (loginForm) {
    loginForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var tokenInput = document.getElementById("owner_token");
      var errorEl = document.getElementById("login-error");
      errorEl.hidden = true;
      api("/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ownerToken: tokenInput.value }) }).then(function (res) {
        if (res.ok) { location.reload(); return; }
        errorEl.textContent = res.status === 403 ? "Invalid owner token." : "Login failed (" + res.status + ").";
        errorEl.hidden = false;
      });
    });
    return;
  }
  if (!document.getElementById("overview")) return;

  document.getElementById("logout-btn").addEventListener("click", function () { api("/logout", { method: "POST" }).then(function () { location.reload(); }); });
  var RECONNECT_CAP_MS = 60000;
  var target = Object.freeze({ workspaceId: workspaceId });
  import("./workspace-panel.js").then(function (module) {
    var ws = null;
    var wsHealthy = false;
    var hasConnectedOnce = false;
    var initialLoadDone = false;
    var reconnectTimer = null;
    var reconnectDelay = 5000;
    var pendingInvalidate = null;
    var timer = null;
    var polling = false;

    var panel = module.createWorkspacePanel({
      request: function (requestTarget, path, options) { return api("/api" + path, options); },
      isCurrent: function (requestTarget) { return requestTarget === target; },
      discardMessageRefresh: "messages",
      onActivityStateChanged: function () { if (!document.hidden && !wsHealthy) scheduleNext(); },
    });

    function clearTimer() {
      if (timer) { clearTimeout(timer); timer = null; }
    }

    function scheduleNext() {
      clearTimer();
      if (document.hidden || wsHealthy) return;
      var delay = panel.hasActiveTask() ? ACTIVE_POLL_MS : IDLE_POLL_MS;
      timer = setTimeout(function () { runPoll(); }, delay);
    }

    function runPoll() {
      clearTimer();
      if (document.hidden || wsHealthy || polling) return;
      polling = true;
      Promise.resolve(panel.pollActivity()).then(function () {
        polling = false;
        if (!document.hidden && !wsHealthy) scheduleNext();
      }, function () {
        polling = false;
        if (!document.hidden && !wsHealthy) scheduleNext();
      });
    }

    function handleInvalidate(scope) {
      if (scope === "settings" || scope === "registry") {
        panel.refreshAll();
      } else {
        panel.pollActivity();
      }
    }

    function mergeScope(prev, next) {
      if (prev === "settings" || next === "settings") return "settings";
      if (prev === "registry" || next === "registry") return "registry";
      return "activity";
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
        scheduleNext();
        scheduleReconnect();
      }
    }

    function connectWs() {
      if (ws || document.hidden) return;
      var wsProto = location.protocol === "https:" ? "wss:" : "ws:";
      var wsUrl = wsProto + "//" + location.host + base + "/ws";
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
        clearTimer();
        if (hasConnectedOnce) {
          panel.refreshAll();
        } else {
          hasConnectedOnce = true;
          if (initialLoadDone) {
            panel.refreshAll();
          }
        }
      };
      socket.onmessage = function (ev) {
        if (socket !== ws) return;
        var data;
        try { data = JSON.parse(ev.data); } catch { return; }
        if (!data || data.type !== "invalidate") return;
        if (document.hidden || !initialLoadDone) {
          pendingInvalidate = mergeScope(pendingInvalidate, data.scope);
          return;
        }
        handleInvalidate(data.scope);
      };
      socket.onclose = function () { handleWsDown(socket); };
      socket.onerror = function () { handleWsDown(socket); };
    }

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        clearTimer();
        clearReconnectTimer();
      } else {
        if (wsHealthy) {
          if (pendingInvalidate) {
            var scope = pendingInvalidate;
            pendingInvalidate = null;
            handleInvalidate(scope);
          }
        } else {
          reconnectDelay = 5000;
          clearReconnectTimer();
          connectWs();
          runPoll();
        }
      }
    });

    connectWs();
    var activation = panel.activate(target);
    function onInitialLoadSettled() {
      initialLoadDone = true;
      if (pendingInvalidate && !document.hidden) {
        var scope = pendingInvalidate;
        pendingInvalidate = null;
        handleInvalidate(scope);
      }
      if (!document.hidden && !wsHealthy) scheduleNext();
    }
    activation.then(onInitialLoadSettled, onInitialLoadSettled);
  });
})();
