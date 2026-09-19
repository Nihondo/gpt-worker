(function () {
  "use strict";
  var parts = location.pathname.split("/").filter(Boolean);
  var workspaceId = parts[1] || "";
  var base = "/dashboard/" + workspaceId;
  var POLL_MS = 10000;

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
    panel.activate(target);
    setInterval(function () { panel.pollActivity(); }, POLL_MS);
  });
})();
