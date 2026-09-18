// Browser "nudge" orchestration: everything involved in getting ChatGPT to
// notice a queued task/report, extracted out of bridge/cli.mjs
// (docs/plans/queue-dashboard.md, step 9) so it can be called from two
// places with identical semantics:
//   - bridge/cli.mjs's cmdTask/cmdHandoff (the existing CLI path, stdout
//     visible to whoever ran the command directly), and
//   - the daemon's dashboard_task_created RPC handler (bridge/link.mjs),
//     reached when a task is created through the Web dashboard rather than
//     the CLI — stdout there is discarded (detached process), so its
//     `log` callback routes through appendLog() instead. See cmdStart's
//     `--__daemon` wiring in cli.mjs.
//
// Every pure helper here is unit-tested via tests/cli-parse-args.test.mjs,
// which imports them by name from bridge/cli.mjs — cli.mjs re-exports this
// module's public names verbatim (`export * from "./chat-nudge.mjs"`) so
// that import path keeps working unchanged.

import { execFileSync } from "node:child_process";
import { updateWorkerConfigAtomic } from "./state.mjs";
import { chatGptConversationUrl, isChromeAutomationAvailable, openInChromeAndSubmit } from "./mac-chrome.mjs";

/** Best-effort: open a URL in the user's regular (non-automated) browser.
 *  Used to pop ChatGPT to the right project with the connector mention
 *  pre-filled in the composer (see `gpt-worker chat-url`) — this still
 *  requires the user to press Enter/Send themselves; nothing here drives
 *  the browser or reads its contents. Never fatal if it fails (headless
 *  environment, unknown platform, ...). */
export function openBrowser(url) {
  try {
    if (process.platform === "darwin") execFileSync("open", [url], { stdio: "ignore" });
    else if (process.platform === "win32") execFileSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
    else execFileSync("xdg-open", [url], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Append " continue task <full task_id>" to the saved chat-url's prompt
 *  query param. A plain Project URL gets the default @gpt-worker mention, so
 *  the pre-filled composer text both mentions the connector and names the
 *  exact task — letting
 *  ChatGPT call next_task(task_id=...) instead of guessing which task is
 *  meant when more than one could be pending. Falls back to the saved URL
 *  unchanged if it isn't parseable or there is no active task. */
export function buildChatOpenUrl(chatUrl, taskId) {
  if (!taskId) return chatUrl;
  try {
    const u = new URL(chatUrl);
    const base = u.searchParams.get("prompt") || "@gpt-worker";
    u.searchParams.set("prompt", `${base} continue task ${taskId}`.trim());
    return u.toString();
  } catch {
    return chatUrl;
  }
}

export function isChatGptUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname === "chatgpt.com";
  } catch {
    return false;
  }
}

export function workspaceChromeTabId(settings, workspaceId) {
  const tabs = settings?.chromeTabsByWorkspace;
  if (!workspaceId || !tabs || typeof tabs !== "object" || Array.isArray(tabs)) return null;
  const tabId = tabs[workspaceId];
  return typeof tabId === "string" && /^[1-9]\d*$/.test(tabId) ? tabId : null;
}

export function workspaceChatUrl(settings, workspaceId) {
  const urls = settings?.chatUrlsByWorkspace;
  if (!workspaceId || !urls || typeof urls !== "object" || Array.isArray(urls)) return null;
  const url = urls[workspaceId];
  return typeof url === "string" && isChatGptUrl(url) ? url : null;
}

export function effectiveChatUrl(settings, workspaceId) {
  return workspaceChatUrl(settings, workspaceId) || settings?.chatUrl || null;
}

export function workspaceConversationUrl(settings, workspaceId, chatUrl = effectiveChatUrl(settings, workspaceId)) {
  const urls = settings?.conversationUrlsByWorkspace;
  if (!workspaceId || !urls || typeof urls !== "object" || Array.isArray(urls)) return null;
  return chatGptConversationUrl(urls[workspaceId], chatUrl);
}

/** A deliberately allowlisted view of local browser-facing preferences. Do
 *  not return worker URLs, tokens, or raw config objects from this helper. */
export function safeBrowserConfig(settings, workspaces, workspaceId = null) {
  const workspaceViews = (Array.isArray(workspaces) ? workspaces : [])
    .filter((workspace) => !workspaceId || workspace.workspaceId === workspaceId)
    .map((workspace) => ({
      workspaceId: workspace.workspaceId,
      workspacePath: workspace.workspacePath || null,
      chatUrlOverride: workspaceChatUrl(settings, workspace.workspaceId),
      effectiveChatUrl: effectiveChatUrl(settings, workspace.workspaceId),
      conversationUrl: workspaceConversationUrl(settings, workspace.workspaceId),
    }));
  return {
    sharedChatUrl: settings?.chatUrl || null,
    enterDelayMs: Number.isFinite(settings?.enterDelayMs) ? settings.enterDelayMs : null,
    workspaces: workspaceViews,
  };
}

export function withWorkspaceChromeTab(settings, workspaceId, tabId) {
  if (!settings || !workspaceId || !/^[1-9]\d*$/.test(String(tabId))) return settings;
  if (workspaceChromeTabId(settings, workspaceId) === String(tabId)) return settings;
  return {
    ...settings,
    chromeTabsByWorkspace: {
      ...(settings.chromeTabsByWorkspace && typeof settings.chromeTabsByWorkspace === "object" && !Array.isArray(settings.chromeTabsByWorkspace)
        ? settings.chromeTabsByWorkspace
        : {}),
      [workspaceId]: String(tabId),
    },
  };
}

export function withoutWorkspaceChromeTab(settings, workspaceId) {
  const tabs = settings?.chromeTabsByWorkspace;
  if (!settings || !workspaceId || !tabs || typeof tabs !== "object" || Array.isArray(tabs) || !Object.hasOwn(tabs, workspaceId)) return settings;
  const nextTabs = { ...tabs };
  delete nextTabs[workspaceId];
  const next = { ...settings };
  if (Object.keys(nextTabs).length === 0) delete next.chromeTabsByWorkspace;
  else next.chromeTabsByWorkspace = nextTabs;
  return next;
}

export function withWorkspaceConversationUrl(settings, workspaceId, conversationUrl, { clearTab = true } = {}) {
  const canonicalUrl = settings && workspaceId ? chatGptConversationUrl(conversationUrl, effectiveChatUrl(settings, workspaceId)) : null;
  if (!canonicalUrl) return settings;
  if (settings.conversationUrlsByWorkspace?.[workspaceId] === canonicalUrl) return settings;
  const next = {
    ...settings,
    conversationUrlsByWorkspace: {
      ...(settings.conversationUrlsByWorkspace && typeof settings.conversationUrlsByWorkspace === "object" && !Array.isArray(settings.conversationUrlsByWorkspace)
        ? settings.conversationUrlsByWorkspace
        : {}),
      [workspaceId]: canonicalUrl,
    },
  };
  return clearTab ? withoutWorkspaceChromeTab(next, workspaceId) : next;
}

export function withoutWorkspaceConversationUrl(settings, workspaceId) {
  const urls = settings?.conversationUrlsByWorkspace;
  if (!settings || !workspaceId || !urls || typeof urls !== "object" || Array.isArray(urls) || !Object.hasOwn(urls, workspaceId)) return settings;
  const nextUrls = { ...urls };
  delete nextUrls[workspaceId];
  const next = { ...settings };
  if (Object.keys(nextUrls).length === 0) delete next.conversationUrlsByWorkspace;
  else next.conversationUrlsByWorkspace = nextUrls;
  return next;
}

export function withoutWorkspaceChatConversation(settings, workspaceId) {
  return withoutWorkspaceChromeTab(withoutWorkspaceConversationUrl(settings, workspaceId), workspaceId);
}

/** Set a workspace-only Project URL. A tab can be kept only when the actual
 *  effective URL did not change. */
export function withWorkspaceChatUrl(settings, workspaceId, chatUrl) {
  if (!settings || !workspaceId || !isChatGptUrl(chatUrl)) return settings;
  const previousEffectiveUrl = effectiveChatUrl(settings, workspaceId);
  const currentOverride = workspaceChatUrl(settings, workspaceId);
  if (currentOverride === chatUrl) return settings;
  const next = {
    ...settings,
    chatUrlsByWorkspace: {
      ...(settings.chatUrlsByWorkspace && typeof settings.chatUrlsByWorkspace === "object" && !Array.isArray(settings.chatUrlsByWorkspace)
        ? settings.chatUrlsByWorkspace
        : {}),
      [workspaceId]: chatUrl,
    },
  };
  return previousEffectiveUrl === chatUrl ? next : withoutWorkspaceChatConversation(next, workspaceId);
}

/** Remove a workspace-only Project URL and return the workspace to the
 *  machine-wide default. */
export function withoutWorkspaceChatUrl(settings, workspaceId) {
  const urls = settings?.chatUrlsByWorkspace;
  if (!settings || !workspaceId || !urls || typeof urls !== "object" || Array.isArray(urls) || !Object.hasOwn(urls, workspaceId)) return settings;
  const previousEffectiveUrl = effectiveChatUrl(settings, workspaceId);
  const nextUrls = { ...urls };
  delete nextUrls[workspaceId];
  const next = { ...settings };
  if (Object.keys(nextUrls).length === 0) delete next.chatUrlsByWorkspace;
  else next.chatUrlsByWorkspace = nextUrls;
  return previousEffectiveUrl === effectiveChatUrl(next, workspaceId) ? next : withoutWorkspaceChatConversation(next, workspaceId);
}

export function withoutWorkspaceChatSettings(settings, workspaceId) {
  return withoutWorkspaceChatConversation(withoutWorkspaceChatUrl(settings, workspaceId), workspaceId);
}

export function withChatUrl(settings, chatUrl) {
  const next = { ...settings, chatUrl };
  if (settings?.chatUrl === chatUrl) return next;
  const tabs = settings?.chromeTabsByWorkspace;
  if (tabs && typeof tabs === "object" && !Array.isArray(tabs)) {
    const overrideTabs = Object.fromEntries(Object.entries(tabs).filter(([workspaceId]) => workspaceChatUrl(settings, workspaceId)));
    if (Object.keys(overrideTabs).length === 0) delete next.chromeTabsByWorkspace;
    else next.chromeTabsByWorkspace = overrideTabs;
  }
  const conversations = settings?.conversationUrlsByWorkspace;
  if (conversations && typeof conversations === "object" && !Array.isArray(conversations)) {
    const overrideConversations = Object.fromEntries(Object.entries(conversations).filter(([workspaceId]) => workspaceChatUrl(settings, workspaceId)));
    if (Object.keys(overrideConversations).length === 0) delete next.conversationUrlsByWorkspace;
    else next.conversationUrlsByWorkspace = overrideConversations;
  }
  return next;
}

/** Drives Chrome (or falls back to the plain OS browser opener) to get
 *  ChatGPT's attention for a queued task/report. `log` defaults to
 *  console.log for the CLI's own direct callers (cmdTask/cmdHandoff); the
 *  daemon's dashboard_task_created handler passes an appendLog()-backed
 *  logger instead, since a detached daemon's stdout is discarded (see this
 *  module's header comment). */
export function nudgeChatGpt(settings, taskId, workspaceId, { log = console.log } = {}) {
  const chatUrl = effectiveChatUrl(settings, workspaceId);
  if (!chatUrl) {
    log('Ask the user to tell ChatGPT "continue" in the gpt-worker project (set a one-click link with: gpt-worker chat-url <url>).');
    return;
  }
  const conversationUrl = workspaceConversationUrl(settings, workspaceId, chatUrl);
  const url = buildChatOpenUrl(conversationUrl || chatUrl, taskId);

  const chromeResult = isChromeAutomationAvailable()
    ? openInChromeAndSubmit(url, chatUrl, {
        enterDelayMs: settings.enterDelayMs,
        tabId: workspaceChromeTabId(settings, workspaceId),
        conversationUrl,
      })
    : false;
  if (chromeResult) {
    updateWorkerConfigAtomic((current) => {
      if (!current || effectiveChatUrl(current, workspaceId) !== chatUrl) return current;
      let next = withWorkspaceChromeTab(current, workspaceId, chromeResult.tabId);
      if (chromeResult.conversationUrl) next = withWorkspaceConversationUrl(next, workspaceId, chromeResult.conversationUrl, { clearTab: false });
      return next;
    });
    // A reused tab never changes window focus; a first-run/replacement tab
    // opens a new Chrome window, which comes to the front like any new
    // window would — regardless of whether auto-submit also succeeded. Say
    // which one happened rather than always claiming "in the background".
    const where = chromeResult.reused ? "this workspace's Chrome tab" : "a new Chrome window for this workspace (it came to the front)";
    if (chromeResult.submitted) {
      log(
        chromeResult.reused
          ? "Sent to ChatGPT automatically in the background (workspace tab reused, no window focus change) — check that it went through."
          : `Sent to ChatGPT automatically in ${where} — check that it went through.`
      );
    } else if (chromeResult.reused && !chromeResult.prepared) {
      log(
        "Reused this workspace's existing ChatGPT conversation without changing it, but could not prepare the continuation — leave the conversation open and enable Chrome's View > Developer > \"Allow JavaScript from Apple Events\", then relaunch Chrome."
      );
    } else {
      log(
        `Opened ChatGPT in ${where} with the connector mention (and this task's id) ready, but could not auto-submit — press Enter/Send there.\n` +
          'For background auto-submit next time this tab is reused, enable Chrome\'s View > Developer > "Allow JavaScript from Apple Events" and relaunch Chrome.'
      );
    }
    return;
  }

  if (openBrowser(url)) {
    log("Opened ChatGPT with the connector mention (and this task's id) ready — press Enter/Send there.");
  } else {
    log('Ask the user to tell ChatGPT "continue" in the gpt-worker project (set a one-click link with: gpt-worker chat-url <url>).');
  }
}
