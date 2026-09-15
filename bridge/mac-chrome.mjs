// macOS + Google Chrome only: reuse the workspace's own gpt-worker ChatGPT
// tab (rather than opening a new one every round) and, optionally, send Enter
// for the user. Everything here is best-effort — on any failure the caller
// falls back to the cross-platform `openBrowser()` (a fresh tab, no auto-Enter).
//
// Why AppleScript and not just `open`: `open <url>` always creates a new
// tab, so tabs pile up over many task/report rounds. Driving Chrome directly
// lets us find and reuse the tab ID previously assigned to this workspace.
//
// A tab ID alone is not enough: it must also still be in this ChatGPT Project.
// This protects unrelated ChatGPT tabs, while the workspace-specific tab ID
// prevents one registered workspace from hijacking another's conversation in
// the same shared Project.

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const CHROME_APP_PATH = "/Applications/Google Chrome.app";

export function isChromeAutomationAvailable() {
  return process.platform === "darwin" && fs.existsSync(CHROME_APP_PATH);
}

export function escapeForAppleScript(str) {
  // AppleScript double-quoted string literals only need backslash and the
  // quote character itself escaped.
  return String(str).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Normalize a saved ChatGPT Project landing URL into the only tab locations
 *  this workspace may reuse. Query/hash do not define project identity. */
export function chatGptProjectScope(chatUrl) {
  try {
    const parsed = new URL(chatUrl);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const match = pathname.match(/^\/g\/([^/]+)\/project$/);
    if (!match || !match[1]) return null;
    const projectBase = `${parsed.origin}/g/${match[1]}`;
    return {
      projectURL: `${projectBase}/project`,
      conversationPrefix: `${projectBase}/c/`,
    };
  } catch {
    return null;
  }
}

/** True only for the Project landing URL or a same-Project conversation with
 *  a non-empty ID. This remains pure so its security boundary is testable
 *  independently of macOS and AppleScript. */
export function matchesChatGptProjectScope(candidateUrl, scope) {
  if (!scope) return false;
  try {
    const candidate = new URL(candidateUrl);
    const normalized = candidate.origin + candidate.pathname;
    if (normalized === scope.projectURL) return true;
    if (!normalized.startsWith(scope.conversationPrefix)) return false;
    const conversationId = normalized.slice(scope.conversationPrefix.length);
    return conversationId.length > 0 && !conversationId.startsWith("?") && !conversationId.startsWith("#") && !conversationId.startsWith("/");
  } catch {
    return false;
  }
}

/** Chrome tab IDs are numeric. Treat any persisted malformed value as absent
 *  rather than interpolating it into AppleScript. */
export function normalizeChromeTabId(tabId) {
  const value = String(tabId ?? "").trim();
  return /^[1-9]\d*$/.test(value) ? value : null;
}

/** Build the AppleScript separately so its generated syntax can be compiled
 *  in a macOS test without opening or changing a Chrome tab. */
export function buildChromeTabScript(url, scope, { autoEnter = false, enterDelayMs = 1500, tabId } = {}) {
  const savedTabId = normalizeChromeTabId(tabId) || "";
  const safeUrl = escapeForAppleScript(url);
  const safeProjectURL = escapeForAppleScript(scope.projectURL);
  const safeConversationPrefix = escapeForAppleScript(scope.conversationPrefix);
  const safeSavedTabId = escapeForAppleScript(savedTabId);
  const enterStep = autoEnter
    ? `delay ${(enterDelayMs / 1000).toFixed(2)}\n    tell application "System Events" to keystroke return`
    : "";

  return `
    set targetURL to "${safeUrl}"
    set projectURL to "${safeProjectURL}"
    set conversationPrefix to "${safeConversationPrefix}"
    set savedTabID to "${safeSavedTabId}"
    tell application "Google Chrome"
      set selectedTab to missing value
      set selectedWindow to missing value
      if savedTabID is not "" then
        repeat with w in windows
          set tabIndex to 1
          repeat with t in tabs of w
            if ((id of t) as text) is savedTabID then
              set candidateURL to URL of t
              set isProjectTab to candidateURL is projectURL or candidateURL starts with projectURL & "?" or candidateURL starts with projectURL & "#"
              set isConversationTab to false
              if candidateURL starts with conversationPrefix then
                if (length of candidateURL) > (length of conversationPrefix) then
                  set remainderURL to text ((length of conversationPrefix) + 1) thru -1 of candidateURL
                  set firstRemainderCharacter to character 1 of remainderURL
                  if firstRemainderCharacter is not "?" and firstRemainderCharacter is not "#" and firstRemainderCharacter is not "/" then
                    set isConversationTab to true
                  end if
                end if
              end if
              if isProjectTab or isConversationTab then
                set selectedTab to t
                set selectedWindow to w
                set selectedTabIndex to tabIndex
              end if
              exit repeat
            end if
            set tabIndex to tabIndex + 1
          end repeat
        if selectedTab is not missing value then exit repeat
      end repeat
      end if
      if selectedTab is missing value then
        if (count of windows) is 0 then
          make new window
        end if
        set selectedWindow to front window
        tell selectedWindow
          set selectedTab to make new tab with properties {URL:targetURL}
          set active tab index to (count of tabs)
          set index to 1
        end tell
      else
        set URL of selectedTab to targetURL
        tell selectedWindow
          set active tab index to selectedTabIndex
          set index to 1
        end tell
      end if
      activate
      set selectedTabID to (id of selectedTab) as text
    end tell
    ${enterStep}
    return selectedTabID
  `;
}

/** Reuse only the tab previously assigned to this workspace when it is still
 *  in the saved ChatGPT Project. If it is absent or stale, create a new tab
 *  and return its ID so the caller can associate it with the workspace. */
export function openInChromeAndSubmit(url, chatUrl, options = {}) {
  if (!isChromeAutomationAvailable()) return false;

  const scope = chatGptProjectScope(chatUrl);
  if (!scope) return false;

  const script = buildChromeTabScript(url, scope, options);

  try {
    const output = execFileSync("osascript", ["-e", script], { encoding: "utf8" });
    const selectedTabId = normalizeChromeTabId(output);
    return selectedTabId ? { tabId: selectedTabId } : false;
  } catch {
    return false;
  }
}
