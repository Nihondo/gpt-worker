(function () {
  "use strict";
  var HUB_BASE = "/dashboard/hub";
  var POLL_MS = 10000;
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
    panel = createWorkspacePanel({
      request: function (target, path, options) { return wsApiFor(target.workspaceId, path, options); },
      isCurrent: function (target) { return state.workspaceId === target.workspaceId && state.selectionGen === target.generation; },
      onTaskStarted: function () { loadWorkspaceList(); },
      discardMessageRefresh: "all",
    });
    function selectWorkspace(id, name) {
      state.workspaceId = id; updateWorkspaceSelection(id); state.selectionGen += 1;
      var target = Object.freeze({ workspaceId: id, generation: state.selectionGen });
      detailEl.hidden = false; detailTitleEl.textContent = name + " (" + id + ")";
      document.getElementById("guidance-text").value = ""; document.getElementById("limits-value").value = ""; document.getElementById("chat-project-override").value = ""; document.getElementById("conversation-url").value = ""; document.getElementById("new-task-status").textContent = "";
      document.getElementById("chat-project-override-error").hidden = true; document.getElementById("conversation-url-error").hidden = true;
      Array.prototype.forEach.call(document.querySelectorAll(".hub-gated"), function (gated) { gated.hidden = false; });
      panel.activate(target, { clearView: true });
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
    loadWorkspaceList(); loadHubBrowserSettings();
    setInterval(function () { loadWorkspaceList(); if (state.workspaceId) panel.refreshAll(); }, POLL_MS);
  });
})();
