// macOS + Google Chrome only: reuse the workspace's own gpt-worker ChatGPT
// tab (rather than opening a new one every round) and, optionally, submit
// the task prompt for the user. Everything here is best-effort — on any
// failure the caller falls back to the cross-platform `openBrowser()` (a
// fresh tab, no auto-submit).
//
// Submission clicks ChatGPT's send button via Chrome's own
// "execute ... javascript" Apple Event, which needs no window focus — but
// only works once the user has enabled Chrome's View > Developer > "Allow
// JavaScript from Apple Events" (off by default, and not something
// gpt-worker can detect or set). There is deliberately no fallback that
// sends a keystroke to the frontmost window instead: doing so would depend
// on whichever window happens to be focused, which is exactly the kind of
// side effect this background-only design exists to avoid. When submission
// doesn't happen, the caller reports the outcome (see `submitted` on
// `openInChromeAndSubmit`'s return value) so it can point the user at that
// Chrome setting instead of silently misfiring a keystroke elsewhere.
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
import { isExecTimeout } from "./exec-limits.mjs";
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

// A ChatGPT Project gizmo segment is "g-p-<32 lowercase hex chars>", with an
// optional "-<human-readable-slug>" suffix that ChatGPT derives from the
// Project's display name. That suffix is not stable: it changes when the
// Project is renamed, and ChatGPT's own UI omits it entirely on some
// navigation paths (e.g. reopening a conversation from the Project's
// sidebar list lands on ".../g/g-p-<hash>/c/<id>" with no slug, even though
// ".../g/g-p-<hash>-<slug>/c/<id>" is the same conversation). Only the
// 32-hex-char id is the stable part.
const GIZMO_SEGMENT_PATTERN = /^g-p-([0-9a-f]{32})(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/i;

/** The stable id inside a "g-p-<id>[-slug]" gizmo path segment, or null if
 *  the segment doesn't look like that shape at all (callers fall back to
 *  exact-segment matching in that case). */
export function stableGizmoId(segment) {
  const match = GIZMO_SEGMENT_PATTERN.exec(String(segment ?? ""));
  return match ? match[1].toLowerCase() : null;
}

/** Normalize a saved ChatGPT Project landing URL into the tab locations this
 *  workspace may reuse. Query/hash do not define project identity. Also
 *  derives the slug-independent `gizmoId` (see stableGizmoId) when the URL
 *  has the standard "g-p-<hash>[-slug]" shape, so matching survives a
 *  Project rename or a slug-less ChatGPT navigation; `projectURL` /
 *  `conversationPrefix` remain as an exact-segment fallback for URLs that
 *  don't have that shape. */
export function chatGptProjectScope(chatUrl) {
  try {
    const parsed = new URL(chatUrl);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const match = pathname.match(/^\/g\/([^/]+)\/project$/);
    if (!match || !match[1]) return null;
    const projectBase = `${parsed.origin}/g/${match[1]}`;
    return {
      origin: parsed.origin,
      gizmoId: stableGizmoId(match[1]),
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

    if (scope.gizmoId && candidate.origin === scope.origin) {
      const segMatch = candidate.pathname.replace(/\/+$/, "").match(/^\/g\/([^/]+)(?:\/(project|c\/([^/]+)))?$/);
      if (segMatch && stableGizmoId(segMatch[1]) === scope.gizmoId && (segMatch[2] === "project" || segMatch[3])) {
        return true;
      }
    }

    const normalized = candidate.origin + candidate.pathname;
    if (normalized === scope.projectURL) return true;
    if (!normalized.startsWith(scope.conversationPrefix)) return false;
    const conversationId = normalized.slice(scope.conversationPrefix.length);
    return conversationId.length > 0 && !conversationId.startsWith("?") && !conversationId.startsWith("#") && !conversationId.startsWith("/");
  } catch {
    return false;
  }
}

/** Return a query/hash-free same-Project conversation URL, or null. This is
 * a durable browser preference; unlike a Chrome tab ID it can be used to
 * rediscover a conversation after the local browser process changes. */
export function chatGptConversationUrl(candidateUrl, chatUrl) {
  const scope = chatGptProjectScope(chatUrl);
  if (!scope || !matchesChatGptProjectScope(candidateUrl, scope)) return null;
  try {
    const parsed = new URL(candidateUrl);
    if (!/^\/g\/[^/]+\/c\/[^/]+$/.test(parsed.pathname)) return null;
    return parsed.origin + parsed.pathname;
  } catch {
    return null;
  }
}

/** Chrome tab IDs are numeric. Treat any persisted malformed value as absent
 *  rather than interpolating it into AppleScript. */
export function normalizeChromeTabId(tabId) {
  const value = String(tabId ?? "").trim();
  return /^[1-9]\d*$/.test(value) ? value : null;
}

/** Clicks ChatGPT's send button via Chrome's own "execute ... javascript"
 *  Apple Event (needs no window focus) — but only works once the user has
 *  enabled Chrome's View > Developer > "Allow JavaScript from Apple Events"
 *  and relaunched Chrome, which is off by default and not something
 *  gpt-worker can detect or set for them. Selector values are unquoted CSS
 *  idents (valid since none contain spaces or special characters) and
 *  every JS string uses
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

/** Prepare a continuation in an existing ChatGPT conversation without
 * navigating away from it. ChatGPT currently uses a ProseMirror
 * contenteditable composer, with a textarea retained as a fallback.
 * Prioritizes automated workflow continuity: clears whatever text is currently
 * in the composer and inserts the new continuation message.
 * `execCommand("insertText")` dispatches the input change ChatGPT's editor consumes;
 * the textarea branch uses its native setter and an InputEvent for the same reason. */
export function buildChatGptComposerScript(prompt) {
  const message = String(prompt || "");
  const messageLiteral = JSON.stringify(message);
  return `(() => {
  const message = ${messageLiteral};
  const composer = document.querySelector('#prompt-textarea[contenteditable=true]') ||
    document.querySelector('textarea[aria-label*=ChatGPT]');
  if (!composer || !message) return 'RETRY';
  composer.focus();
  if (composer.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(composer, message);
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
  } else {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection.removeAllRanges();
    selection.addRange(range);
    if (!document.execCommand('insertText', false, message)) {
      composer.textContent = message;
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
    }
  }
  return 'READY';
})()`;
}

/** Build the AppleScript separately so its generated syntax can be compiled
 *  in a macOS test without opening or changing a Chrome window. */
export function buildChromeTabScript(url, scope, { enterDelayMs = 1500, tabId, conversationUrl } = {}) {
  const savedTabId = normalizeChromeTabId(tabId) || "";
  const savedConversationUrl = chatGptConversationUrl(conversationUrl, scope.projectURL) || "";
  const safeUrl = escapeForAppleScript(url);
  const safeProjectURL = escapeForAppleScript(scope.projectURL);
  const safeConversationPrefix = escapeForAppleScript(scope.conversationPrefix);
  const safeSavedTabId = escapeForAppleScript(savedTabId);
  const safeSavedConversationUrl = escapeForAppleScript(savedConversationUrl);
  // Slug-independent fast path (see stableGizmoId) — empty when the saved
  // URL doesn't have the standard "g-p-<hash>[-slug]" shape, in which case
  // the exact-segment check below is the only match path, same as before.
  const safeStableGizmoPrefix = scope.gizmoId ? escapeForAppleScript(`${scope.origin}/g/g-p-${scope.gizmoId}`) : "";
  const safeClickJs = escapeForAppleScript(CLICK_SEND_BUTTON_JS);
  let prompt = "";
  try {
    prompt = new URL(url).searchParams.get("prompt") || "";
  } catch {}
  const safeComposerJs = escapeForAppleScript(buildChatGptComposerScript(prompt));
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
  const submitStep = `
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
      end repeat`;

  const prepareContinuationStep = `
      set prepareOutcome to "PENDING"
      set prepareErrorCount to 0
      set prepareAttemptCount to 0
      repeat while prepareOutcome is not "READY" and prepareErrorCount < ${MAX_JS_ERRORS} and prepareAttemptCount < ${MAX_RETRY_ATTEMPTS}
        try
          set prepareOutcome to (execute selectedTab javascript "${safeComposerJs}")
        on error
          set prepareOutcome to "JS_ERROR"
          set prepareErrorCount to prepareErrorCount + 1
        end try
        if prepareOutcome is not "READY" then
          delay ${RETRY_INTERVAL_SEC}
        end if
        set prepareAttemptCount to prepareAttemptCount + 1
      end repeat`;

  return `
    set targetURL to "${safeUrl}"
    set projectURL to "${safeProjectURL}"
    set conversationPrefix to "${safeConversationPrefix}"
    set savedTabID to "${safeSavedTabId}"
    set savedConversationURL to "${safeSavedConversationUrl}"
    set targetIsSavedConversation to savedConversationURL is not ""
    set stableGizmoPrefix to "${safeStableGizmoPrefix}"
    tell application "Google Chrome"
      set selectedTab to missing value
      set selectedWindow to missing value
      set selectedTabIsConversation to false
      if savedTabID is not "" then
        repeat with w in windows
          set tabIndex to 1
          repeat with t in tabs of w
            if ((id of t) as text) is savedTabID then
              set candidateURL to URL of t
              set tabMatchesScope to false
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
              if stableGizmoPrefix is not "" and candidateURL contains stableGizmoPrefix then
                set tabMatchesScope to true
                if candidateURL contains "/c/" then set isConversationTab to true
              else
                if isProjectTab or isConversationTab then set tabMatchesScope to true
              end if
              if tabMatchesScope then
                set selectedTab to t
                set selectedWindow to w
                set selectedTabIndex to tabIndex
                set selectedTabIsConversation to isConversationTab
              end if
              exit repeat
            end if
            set tabIndex to tabIndex + 1
          end repeat
        if selectedTab is not missing value then exit repeat
      end repeat
      end if
      if selectedTab is missing value and savedConversationURL is not "" then
        repeat with w in windows
          set tabIndex to 1
          repeat with t in tabs of w
            set candidateURL to URL of t
            set candidateComparableURL to candidateURL
            set queryPosition to offset of "?" in candidateComparableURL
            if queryPosition > 0 then set candidateComparableURL to text 1 thru (queryPosition - 1) of candidateComparableURL
            set hashPosition to offset of "#" in candidateComparableURL
            if hashPosition > 0 then set candidateComparableURL to text 1 thru (hashPosition - 1) of candidateComparableURL
            if candidateComparableURL is savedConversationURL then
              set selectedTab to t
              set selectedWindow to w
              set selectedTabIndex to tabIndex
              set selectedTabIsConversation to true
              exit repeat
            end if
            set tabIndex to tabIndex + 1
          end repeat
          if selectedTab is not missing value then exit repeat
        end repeat
      end if
      if selectedTab is missing value then
        set didReuseTab to false
        set selectedWindow to make new window
        tell selectedWindow
          set selectedTab to tab 1
          set URL of selectedTab to targetURL
          set active tab index to 1
        end tell
      else
        set didReuseTab to true
        if selectedTabIsConversation then
          ${prepareContinuationStep}
        else
          set URL of selectedTab to targetURL
          set prepareOutcome to "URL"
        end if
        tell selectedWindow
          set active tab index to selectedTabIndex
        end tell
      end if
      set selectedTabID to (id of selectedTab) as text
      set submitOutcome to "SKIPPED"
      if didReuseTab is false then
        if targetIsSavedConversation then
          ${prepareContinuationStep}
        else
          set prepareOutcome to "URL"
        end if
      end if
      if prepareOutcome is "READY" or prepareOutcome is "URL" then
        ${submitStep}
      end if
      set selectedTabURL to URL of selectedTab
    end tell
    if didReuseTab then
      set reuseFlag to "REUSED"
    else
      set reuseFlag to "NEW"
    end if
    return selectedTabID & "|" & submitOutcome & "|" & reuseFlag & "|" & prepareOutcome & "|" & selectedTabURL
  `;
}

/** Reuse only the tab previously assigned to this workspace when it is still
 *  in the saved ChatGPT Project. If it is absent or stale, create a new tab
 *  and return its ID so the caller can associate it with the workspace.
 *
 *  `submitted` is only ever true when the send button was actually clicked
 *  in the background — false means nothing was submitted (e.g. the JS route
 *  never became available/clickable or send button was not ready), so the caller
 *  can tell the user what to do instead of assuming it went through.
 *
 *  `reused` says whether this reused the workspace's existing tab (true —
 *  no window focus change of any kind) or had to open a new Chrome window
 *  (false — that window comes to the front like any new window would,
 *  regardless of `submitted`). Callers should not describe a `submitted:
 *  true` result as "in the background" without also checking `reused`.
 *
 *  When reusing a conversation tab, its URL is deliberately left unchanged:
 *  the task prompt is inserted into that conversation's composer instead.
 *  `prepared` reports whether that injection (or the new-tab URL prompt)
 *  succeeded. */
/** Time budget for one osascript run. A healthy run is bounded by the retry
 *  loops inside the generated script — up to 8 x 0.4s to prepare the composer,
 *  the `enterDelayMs` pause (1.5s by default, user-configurable), then up to
 *  8 x 0.4s to click send: roughly 8s plus Apple Event round-trips. The budget
 *  is a fixed allowance well above that, plus twice the configured delay so a
 *  user who raised `enterDelayMs` is not timed out by their own setting. */
export function osascriptTimeoutMs(enterDelayMs = 1500) {
  const delay = Number.isFinite(Number(enterDelayMs)) ? Math.max(0, Number(enterDelayMs)) : 1500;
  return 25_000 + delay * 2;
}

/** Opens/reuses a Chrome tab and tries to submit. Returns false — never throws
 *  — when automation is unavailable or fails; callers fall back to the plain OS
 *  browser opener. Options besides the ones buildChromeTabScript() reads:
 *   - `log`   : receives one line describing *why* a run failed. Without it the
 *               reason (Chrome stuck behind a dialog, "Allow JavaScript from
 *               Apple Events" off, ...) was thrown away with the catch.
 *   - `_exec` : test seam replacing execFileSync, same convention as
 *               nudgeChatGpt()'s `_openInChrome`. */
export function openInChromeAndSubmit(url, chatUrl, options = {}) {
  if (!isChromeAutomationAvailable()) return false;

  const scope = chatGptProjectScope(chatUrl);
  if (!scope) return false;

  const script = buildChromeTabScript(url, scope, options);
  const exec = options._exec || execFileSync;
  const log = typeof options.log === "function" ? options.log : () => {};
  const timeoutMs = osascriptTimeoutMs(options.enterDelayMs);

  try {
    // Without a timeout, Chrome sitting behind a modal dialog blocked this
    // synchronous call forever — and with it `gpt-worker task`/`report`, or the
    // whole bridge daemon when it came from a dashboard-created task. SIGKILL
    // because osascript stuck on an Apple Event does not honor SIGTERM.
    const output = exec("osascript", ["-e", script], { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" }).trim();
    const [tabIdPart, submitOutcome, reuseFlag, prepareOutcome, selectedTabUrl] = output.split("|");
    const selectedTabId = normalizeChromeTabId(tabIdPart);
    return selectedTabId
      ? {
          tabId: selectedTabId,
          submitted: submitOutcome === "CLICKED",
          reused: reuseFlag === "REUSED",
          prepared: ["READY", "URL"].includes(prepareOutcome),
          preparationOutcome: prepareOutcome || "UNKNOWN",
          conversationUrl: chatGptConversationUrl(selectedTabUrl, chatUrl),
        }
      : false;
  } catch (err) {
    const detail = isExecTimeout(err)
      ? `timed out after ${timeoutMs}ms (Chrome may be showing a modal dialog)`
      : String((err && err.stderr) || (err && err.message) || err).trim().slice(0, 500);
    log(`chrome automation failed: ${detail}`);
    return false;
  }
}
