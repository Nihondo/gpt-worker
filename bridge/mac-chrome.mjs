// macOS + Google Chrome only: reuse an existing gpt-worker ChatGPT tab
// (rather than opening a new one every round) and, optionally, send Enter
// for the user. Everything here is best-effort — on any failure the caller
// falls back to the cross-platform `openBrowser()` (a fresh tab, no auto-Enter).
//
// Why AppleScript and not just `open`: `open <url>` always creates a new
// tab, so tabs pile up over many task/report rounds. Driving Chrome directly
// lets us find and reuse the one tab already showing this workspace's
// ChatGPT project.
//
// Why the tab match is scoped to *this workspace's* project path (not just
// "any chatgpt.com tab"): an earlier draft matched any `https://chatgpt.com/`
// tab, which would silently hijack an unrelated conversation the user has
// open elsewhere by overwriting its URL. A ChatGPT Project landing URL moves
// from `/project` to `/c/<conversation-id>` after sending, so both shapes are
// matched within the same project scope and nothing broader is reused.

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

/** Reuse only a tab in the saved ChatGPT Project. A valid Project landing
 *  URL may have become `/c/<conversation-id>` after a prior submission. */
export function openInChromeAndSubmit(url, chatUrl, { autoEnter = false, enterDelayMs = 1500 } = {}) {
  if (!isChromeAutomationAvailable()) return false;

  const scope = chatGptProjectScope(chatUrl);
  if (!scope) return false;

  const safeUrl = escapeForAppleScript(url);
  const safeProjectURL = escapeForAppleScript(scope.projectURL);
  const safeConversationPrefix = escapeForAppleScript(scope.conversationPrefix);
  const enterStep = autoEnter
    ? `delay ${(enterDelayMs / 1000).toFixed(2)}\n    tell application "System Events" to keystroke return`
    : "";

  const script = `
    set targetURL to "${safeUrl}"
    set projectURL to "${safeProjectURL}"
    set conversationPrefix to "${safeConversationPrefix}"
    tell application "Google Chrome"
      set foundTab to false
      repeat with w in windows
        set tabIndex to 1
        repeat with t in tabs of w
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
            set URL of t to targetURL
            set active tab index of w to tabIndex
            set index of w to 1
            set foundTab to true
            exit repeat
          end if
          set tabIndex to tabIndex + 1
        end repeat
        if foundTab then exit repeat
      end repeat
      if not foundTab then
        if (count of windows) is 0 then
          make new window
        end if
        tell front window to make new tab with properties {URL:targetURL}
      end if
      activate
    end tell
    ${enterStep}
  `;

  try {
    execFileSync("osascript", ["-e", script], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
