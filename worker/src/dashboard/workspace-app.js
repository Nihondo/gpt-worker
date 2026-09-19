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
  var target = Object.freeze({ workspaceId: workspaceId });
  import("./workspace-panel.js").then(function (module) {
    var panel = module.createWorkspacePanel({
      request: function (requestTarget, path, options) { return api("/api" + path, options); },
      isCurrent: function (requestTarget) { return requestTarget === target; },
      discardMessageRefresh: "messages",
    });

    var timer = null;
    var polling = false;

    function clearTimer() {
      if (timer) { clearTimeout(timer); timer = null; }
    }

    function scheduleNext() {
      clearTimer();
      if (document.hidden) return;
      var delay = panel.hasActiveTask() ? ACTIVE_POLL_MS : IDLE_POLL_MS;
      timer = setTimeout(function () { runPoll(); }, delay);
    }

    function runPoll() {
      clearTimer();
      if (document.hidden || polling) return;
      polling = true;
      Promise.resolve(panel.pollActivity()).then(function () {
        polling = false;
        if (!document.hidden) scheduleNext();
      }, function () {
        polling = false;
        if (!document.hidden) scheduleNext();
      });
    }

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        clearTimer();
      } else {
        runPoll();
      }
    });

    var activation = panel.activate(target);
    activation.then(function () {
      if (!document.hidden) scheduleNext();
    }, function () {
      if (!document.hidden) scheduleNext();
    });
  });
})();
