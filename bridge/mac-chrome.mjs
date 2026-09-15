// macOS + Google Chrome only: reuse the workspace's own gpt-worker ChatGPT
// tab (rather than opening a new one every round) and, optionally, submit
// the task prompt for the user. Everything here is best-effort — on any
// failure the caller falls back to the cross-platform `openBrowser()` (a
// fresh tab, no auto-Enter).
//
// Submission itself is two-tiered: first try clicking ChatGPT's send button
// via Chrome's own "execute ... javascript" Apple Event, which needs no
// window focus — but only works once the user has enabled Chrome's View >
// Developer > "Allow JavaScript from Apple Events" (off by default, and not
// something gpt-worker can detect or set). If that's unavailable or the
// button never becomes clickable, fall back to a `keystroke return` sent to
// the frontmost window, same as before this existed.
//
// Why AppleScript and not just `open`: `open <url>` always creates a new
// tab, so tabs pile up over many task/report rounds. Driving Chrome directly
// lets us find and reuse the tab ID previously assigned to this workspace
// without explicitly activating Chrome.
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

/** Clicks ChatGPT's send button via Chrome's own "execute ... javascript"
 *  Apple Event (needs no window focus, unlike the `keystroke return`
 *  fallback below) — but only works once the user has enabled Chrome's
 *  View > Developer > "Allow JavaScript from Apple Events" and relaunched
 *  Chrome, which is off by default and not something gpt-worker can detect
 *  or set for them. Selector values are unquoted CSS idents (valid since
 *  none contain spaces or special characters) and every JS string uses
 *  single quotes, so this snippet has no double quotes or backslashes and
 *  needs no escaping beyond the routine escapeForAppleScript() pass applied
 *  where it's interpolated. */
const CLICK_SEND_BUTTON_JS = `(() => {
  const btn = document.querySelector('[data-testid=send-button]') ||
    document.querySelector('button[aria-label*=Send]') ||
    document.querySelector('button[aria-label*=送信]');
  if (!btn || btn.disabled) return 'RETRY';
  btn.click();
  return 'CLICKED';
})()`;

/** Build the AppleScript separately so its generated syntax can be compiled
 *  in a macOS test without opening or changing a Chrome window. */
export function buildChromeTabScript(url, scope, { autoEnter = false, enterDelayMs = 1500, tabId } = {}) {
  const savedTabId = normalizeChromeTabId(tabId) || "";
  const safeUrl = escapeForAppleScript(url);
  const safeProjectURL = escapeForAppleScript(scope.projectURL);
  const safeConversationPrefix = escapeForAppleScript(scope.conversationPrefix);
  const safeSavedTabId = escapeForAppleScript(savedTabId);
  const safeClickJs = escapeForAppleScript(CLICK_SEND_BUTTON_JS);
  // Measured empirically: after navigating a tab to a ChatGPT Project URL
  // with a ?prompt= query, the page load + React hydration + prompt
  // prefill + send-button enable can take several seconds — a single
  // check right after enterDelayMs is not reliable, so this polls instead
  // of trusting one fixed delay.
  const RETRY_INTERVAL_SEC = 0.4;
  const MAX_RETRY_ATTEMPTS = 8;
  // A single "execute ... javascript" error is not proof the Apple Events
  // permission is off — a tab mid-navigation can throw too — so errors get
  // a couple of retries of their own rather than aborting the whole loop
  // on the first one. Genuinely missing permission fails the same way on
  // every attempt, so this still bails quickly (no meaningful added
  // latency) for the common case of a user who never enabled it.
  const MAX_JS_ERRORS = 2;
  const submitStep = autoEnter
    ? `
      delay ${(enterDelayMs / 1000).toFixed(2)}
      set submitOutcome to "PENDING"
      set jsErrorCount to 0
      set attemptCount to 0
      repeat while submitOutcome is not "CLICKED" and jsErrorCount < ${MAX_JS_ERRORS} and attemptCount < ${MAX_RETRY_ATTEMPTS}
        try
          set submitOutcome to (execute selectedTab javascript "${safeClickJs}")
        on error
          set submitOutcome to "JS_ERROR"
          set jsErrorCount to jsErrorCount + 1
        end try
        if submitOutcome is not "CLICKED" then
          delay ${RETRY_INTERVAL_SEC}
        end if
        set attemptCount to attemptCount + 1
      end repeat
      if submitOutcome is not "CLICKED" then
        tell application "System Events" to keystroke return
      end if`
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
        set selectedWindow to make new window
        tell selectedWindow
          set selectedTab to tab 1
          set URL of selectedTab to targetURL
          set active tab index to 1
        end tell
      else
        set URL of selectedTab to targetURL
        tell selectedWindow
          set active tab index to selectedTabIndex
        end tell
      end if
      set selectedTabID to (id of selectedTab) as text
      ${submitStep}
    end tell
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
