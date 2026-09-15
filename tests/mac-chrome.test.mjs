import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  chatGptProjectScope,
  buildChatGptComposerScript,
  buildChromeTabScript,
  escapeForAppleScript,
  isChromeAutomationAvailable,
  matchesChatGptProjectScope,
  normalizeChromeTabId,
  stableGizmoId,
} from "../bridge/mac-chrome.mjs";

const projectURL = "https://chatgpt.com/g/g-p-example-gpt-worker/project";
const scope = {
  origin: "https://chatgpt.com",
  gizmoId: null,
  projectURL,
  conversationPrefix: "https://chatgpt.com/g/g-p-example-gpt-worker/c/",
};

// A realistic gizmo hash — "example-gpt-worker" above isn't 32 hex chars,
// so it never exercises the slug-independent stableGizmoId fast path.
const gizmoHash = "6aa7981baaa081918029bb0c40b5c795";
const realProjectURL = `https://chatgpt.com/g/g-p-${gizmoHash}-gpt-worker/project`;
const realScope = {
  origin: "https://chatgpt.com",
  gizmoId: gizmoHash,
  projectURL: realProjectURL,
  conversationPrefix: `https://chatgpt.com/g/g-p-${gizmoHash}-gpt-worker/c/`,
};

describe("escapeForAppleScript", () => {
  test("escapes double quotes and backslashes so the string stays one AppleScript literal", () => {
    assert.equal(escapeForAppleScript('say "hi"'), 'say \\"hi\\"');
    assert.equal(escapeForAppleScript("a\\b"), "a\\\\b");
  });

  test("a URL with a query string round-trips safely (no unescaped quotes introduced)", () => {
    const url = 'https://chatgpt.com/g/g-p-x/project?prompt=@gptworker continue task "weird"';
    const escaped = escapeForAppleScript(url);
    assert.ok(!/(^|[^\\])"/.test(escaped) === false || escaped.includes('\\"'));
    // every double quote in the input must be preceded by a backslash in the output
    assert.equal((escaped.match(/\\"/g) || []).length, (url.match(/"/g) || []).length);
  });
});

describe("isChromeAutomationAvailable", () => {
  test("is false on any non-darwin platform regardless of filesystem state", () => {
    if (process.platform !== "darwin") {
      assert.equal(isChromeAutomationAvailable(), false);
    }
  });
});

describe("normalizeChromeTabId", () => {
  test("accepts Chrome's positive numeric tab IDs as strings", () => {
    assert.equal(normalizeChromeTabId(540586144), "540586144");
    assert.equal(normalizeChromeTabId("42"), "42");
    assert.equal(normalizeChromeTabId(" 42 "), "42");
  });

  test("rejects empty, non-numeric, and unsafe persisted IDs", () => {
    for (const value of [undefined, null, "", "0", "-1", "1.5", "1; tell application \"Finder\""]) {
      assert.equal(normalizeChromeTabId(value), null, String(value));
    }
  });
});

describe("workspace tab AppleScript", () => {
  test("creates a dedicated new window without explicitly foregrounding Chrome", () => {
    const script = buildChromeTabScript(`${projectURL}?prompt=test`, scope);

    assert.match(script, /set selectedWindow to make new window/);
    assert.match(script, /set selectedTab to tab 1/);
    assert.doesNotMatch(script, /make new tab/);
    assert.doesNotMatch(script, /\n\s*activate\s*\n/);
    assert.doesNotMatch(script, /set index to 1/);
  });

  test("targets only the saved tab ID while retaining the Project scope check", () => {
    const script = buildChromeTabScript(`${projectURL}?prompt=test`, scope, { tabId: "540586144" });

    assert.match(script, /set savedTabID to "540586144"/);
    assert.match(script, /if \(\(id of t\) as text\) is savedTabID then/);
    assert.match(script, /set isProjectTab to candidateURL is projectURL/);
    assert.match(script, /set selectedTabID to \(id of selectedTab\) as text/);
  });

  test("does not interpolate malformed persisted values into the script", () => {
    const script = buildChromeTabScript(projectURL, scope, { tabId: '1; tell application "Finder"' });
    assert.match(script, /set savedTabID to ""/);
    assert.doesNotMatch(script, /Finder/);
  });

  test("returns tab, submission, reuse, and preparation outcomes so the caller can distinguish an injected continuation from a new-tab URL prompt", () => {
    const script = buildChromeTabScript(`${projectURL}?prompt=test`, scope, { tabId: "540586144" });
    assert.match(script, /set didReuseTab to false/);
    assert.match(script, /set didReuseTab to true/);
    assert.match(script, /if selectedTabIsConversation then\s*[\s\S]*set prepareOutcome to "PENDING"[\s\S]*else\s*set URL of selectedTab to targetURL\s*set prepareOutcome to "URL"/);
    assert.match(script, /set selectedTabIsConversation to isConversationTab/);
    assert.match(script, /if didReuseTab then\s*\n\s*set reuseFlag to "REUSED"\s*\n\s*else\s*\n\s*set reuseFlag to "NEW"\s*\n\s*end if/);
    assert.match(script, /return selectedTabID & "\|" & submitOutcome & "\|" & reuseFlag & "\|" & prepareOutcome/);
  });
});

describe("existing-conversation composer preparation", () => {
  test("uses ChatGPT's contenteditable composer and reports a user draft as busy instead of overwriting it", () => {
    const script = buildChatGptComposerScript("@gpt-worker continue task abc123");
    assert.match(script, /#prompt-textarea\[contenteditable=true\]/);
    assert.match(script, /if \(existingText\.trim\(\)\) return 'COMPOSER_BUSY'/);
    assert.match(script, /document\.execCommand\('insertText', false, message\)/);
    assert.match(script, /new InputEvent\('input', \{ bubbles: true, inputType: 'insertText', data: message \}\)/);
  });

  test("encodes arbitrary prompt text as a JavaScript literal rather than interpolating it as code", () => {
    const script = buildChatGptComposerScript('continue "quoted" \\ task');
    assert.ok(script.includes(`const message = ${JSON.stringify('continue "quoted" \\ task')};`));
    assert.doesNotMatch(script, /const message = continue/);
  });

  test("includes the continuation preparation before auto-submit when reusing a conversation tab", () => {
    const script = buildChromeTabScript(`${projectURL}?prompt=%40gpt-worker%20continue%20task%20abc123`, scope, {
      autoEnter: true,
      tabId: "540586144",
    });
    assert.match(script, /set prepareOutcome to "PENDING"/);
    assert.match(script, /continue task abc123/);
    assert.match(script, /if prepareOutcome is "READY" or prepareOutcome is "URL" then[\s\S]*execute selectedTab javascript/);
  });
});

describe("autoEnter submit step", () => {
  test("omits the send-button click when autoEnter is off (the default), while retaining safe composer preparation for a reused conversation", () => {
    const script = buildChromeTabScript(`${projectURL}?prompt=test`, scope);
    assert.doesNotMatch(script, /data-testid=send-button/);
    assert.doesNotMatch(script, /keystroke return/);
    assert.doesNotMatch(script, /System Events/);
    assert.match(script, /set submitOutcome to "SKIPPED"/);
    assert.match(script, /return selectedTabID & "\|" & submitOutcome/);
  });

  test("tries clicking ChatGPT's send button via Chrome's own JS execution, with no keystroke fallback of any kind", () => {
    const script = buildChromeTabScript(`${projectURL}?prompt=test`, scope, { autoEnter: true, enterDelayMs: 2000 });

    assert.match(script, /delay 2\.00/);
    assert.match(script, /execute selectedTab javascript "/);
    // send-button click JS must reach AppleScript with no unescaped quotes
    assert.match(script, /document\.querySelector\('\[data-testid=send-button\]'\)/);
    assert.match(script, /repeat while submitOutcome is not "CLICKED"/);
    // no System Events / keystroke fallback anywhere — a failed JS submit must
    // stay a no-op rather than sending a keystroke to whatever window has focus
    assert.doesNotMatch(script, /keystroke/);
    assert.doesNotMatch(script, /System Events/);
  });

  test("tolerates a couple of execute-javascript errors as retryable (a mid-navigation tab can throw transiently) rather than bailing on the first one", () => {
    const script = buildChromeTabScript(`${projectURL}?prompt=test`, scope, { autoEnter: true });
    assert.match(script, /on error\s*\n\s*set submitOutcome to "JS_ERROR"\s*\n\s*set jsErrorCount to jsErrorCount \+ 1\s*\n\s*end try/);
    assert.match(script, /repeat while submitOutcome is not "CLICKED" and jsErrorCount < \d+ and attemptCount < \d+/);
  });

  test("leaves submitOutcome as the last failure reason (not CLICKED) once errors or disabled-button retries are exhausted, for the caller to report", () => {
    const script = buildChromeTabScript(`${projectURL}?prompt=test`, scope, { autoEnter: true });
    const maxErrorsMatch = script.match(/jsErrorCount < (\d+)/);
    assert.ok(maxErrorsMatch, "expected a jsErrorCount cap in the generated script");
    assert.ok(Number(maxErrorsMatch[1]) >= 2, "a single transient error must not be treated as permanent");
    // the loop's own exit condition is the only thing that stops retries — nothing forces submitOutcome to CLICKED
    assert.doesNotMatch(script, /set submitOutcome to "CLICKED"/);
  });
});

describe("ChatGPT Project tab scope", () => {
  test("normalizes a Project landing URL while ignoring trailing slash, query and hash", () => {
    assert.deepEqual(chatGptProjectScope(`${projectURL}/?prompt=@gpt-worker#composer`), scope);
  });

  test("rejects malformed and non-Project saved URLs", () => {
    for (const value of ["not a URL", "https://chatgpt.com/c/conversation", "https://chatgpt.com/g/g-p-example-gpt-worker/c/conversation"]) {
      assert.equal(chatGptProjectScope(value), null, value);
    }
  });

  test("matches the Project landing URL and same-Project conversations", () => {
    for (const value of [
      projectURL,
      `${projectURL}?prompt=@gpt-worker`,
      `${projectURL}#composer`,
      "https://chatgpt.com/g/g-p-example-gpt-worker/c/1234",
      "https://chatgpt.com/g/g-p-example-gpt-worker/c/1234?foo=bar#composer",
    ]) {
      assert.equal(matchesChatGptProjectScope(value, scope), true, value);
    }
  });

  test("rejects empty conversations and unrelated ChatGPT URLs", () => {
    for (const value of [
      "https://chatgpt.com/g/g-p-example-gpt-worker/c/",
      "https://chatgpt.com/g/g-p-example-gpt-worker/c/?foo=bar",
      "https://chatgpt.com/g/g-p-example-gpt-worker/c/#composer",
      "https://chatgpt.com/g/g-p-other-project/project",
      "https://chatgpt.com/g/g-p-other-project/c/1234",
      "https://chatgpt.com/c/1234",
      "https://chatgpt.com/g/g-p-example-gpt-worker/project-evil",
      "https://chatgpt.com/g/g-p-example-gpt-worker/c//nested",
      "http://chatgpt.com/g/g-p-example-gpt-worker/c/1234",
      "https://example.com/g/g-p-example-gpt-worker/c/1234",
    ]) {
      assert.equal(matchesChatGptProjectScope(value, scope), false, value);
    }
  });
});

describe("stableGizmoId", () => {
  test("extracts the 32-hex-char id and ignores any -slug suffix", () => {
    assert.equal(stableGizmoId(`g-p-${gizmoHash}`), gizmoHash);
    assert.equal(stableGizmoId(`g-p-${gizmoHash}-gpt-worker`), gizmoHash);
    assert.equal(stableGizmoId(`g-p-${gizmoHash.toUpperCase()}-GPTWorker`), gizmoHash);
  });

  test("returns null for anything that isn't a 32-hex-char g-p- segment", () => {
    for (const value of ["g-p-example-gpt-worker", `g-${gizmoHash}`, `g-p-${gizmoHash.slice(0, 31)}`, "", undefined]) {
      assert.equal(stableGizmoId(value), null, String(value));
    }
  });
});

describe("ChatGPT Project tab scope: slug-independent gizmo id matching", () => {
  test("chatGptProjectScope derives gizmoId only for the real g-p-<hash>[-slug] shape", () => {
    assert.equal(chatGptProjectScope(realProjectURL).gizmoId, gizmoHash);
    assert.equal(chatGptProjectScope(projectURL).gizmoId, null);
  });

  test("matches a same-gizmo conversation whether the URL keeps, drops, or changes the slug", () => {
    for (const value of [
      realProjectURL,
      `https://chatgpt.com/g/g-p-${gizmoHash}/project`, // slug dropped
      `https://chatgpt.com/g/g-p-${gizmoHash}-gptworker/project`, // Project renamed (different slug)
      `https://chatgpt.com/g/g-p-${gizmoHash}-gpt-worker/c/6aa8cee8-e7c8-83e8-b6d0-7d8143fc8004`,
      `https://chatgpt.com/g/g-p-${gizmoHash}/c/6aa8cee8-e7c8-83e8-b6d0-7d8143fc8004`, // reopened from the sidebar: no slug
    ]) {
      assert.equal(matchesChatGptProjectScope(value, realScope), true, value);
    }
  });

  test("still rejects a different gizmo hash even with a similar slug, and a bare gizmo segment with no /project or /c/", () => {
    const otherHash = "0".repeat(32);
    for (const value of [
      `https://chatgpt.com/g/g-p-${otherHash}-gpt-worker/project`,
      `https://chatgpt.com/g/g-p-${gizmoHash}-gpt-worker`,
      `https://example.com/g/g-p-${gizmoHash}-gpt-worker/project`,
    ]) {
      assert.equal(matchesChatGptProjectScope(value, realScope), false, value);
    }
  });

  test("buildChromeTabScript embeds a slug-independent containment check for real gizmo ids, and omits it otherwise", () => {
    const realScript = buildChromeTabScript(`${realProjectURL}?prompt=test`, realScope, { tabId: "540586144" });
    assert.match(realScript, new RegExp(`set stableGizmoPrefix to "https://chatgpt\\.com/g/g-p-${gizmoHash}"`));
    assert.match(realScript, /if stableGizmoPrefix is not "" and candidateURL contains stableGizmoPrefix then/);

    const fallbackScript = buildChromeTabScript(`${projectURL}?prompt=test`, scope, { tabId: "540586144" });
    assert.match(fallbackScript, /set stableGizmoPrefix to ""/);
  });
});
