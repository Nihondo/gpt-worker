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
// open elsewhere by overwriting its URL. Matching on the saved chat-url's
// own path prefix means only a tab this tool itself would have opened is
// ever reused.

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

/** matchPrefix: the chat-url's own path (no query string) — e.g.
 *  "https://chatgpt.com/g/g-p-xxxx-gptworker/project". Only a tab whose URL
 *  starts with exactly this is reused; anything else is left alone and a
 *  new tab is created instead. */
export function openInChromeAndSubmit(url, matchPrefix, { autoEnter = false, enterDelayMs = 1500 } = {}) {
  if (!isChromeAutomationAvailable()) return false;

  const safeUrl = escapeForAppleScript(url);
  const safePrefix = escapeForAppleScript(matchPrefix);
  const enterStep = autoEnter
    ? `delay ${(enterDelayMs / 1000).toFixed(2)}\n    tell application "System Events" to keystroke return`
    : "";

  const script = `
    set targetURL to "${safeUrl}"
    set matchPrefix to "${safePrefix}"
    tell application "Google Chrome"
      set foundTab to false
      repeat with w in windows
        set tabIndex to 1
        repeat with t in tabs of w
          if (URL of t) starts with matchPrefix then
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
