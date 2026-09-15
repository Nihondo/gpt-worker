import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  chatGptProjectScope,
  buildChromeTabScript,
  escapeForAppleScript,
  isChromeAutomationAvailable,
  matchesChatGptProjectScope,
  normalizeChromeTabId,
} from "../bridge/mac-chrome.mjs";

const projectURL = "https://chatgpt.com/g/g-p-example-gpt-worker/project";
const scope = {
  projectURL,
  conversationPrefix: "https://chatgpt.com/g/g-p-example-gpt-worker/c/",
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
});

describe("autoEnter submit step", () => {
  test("omits the submit step entirely when autoEnter is off (the default)", () => {
    const script = buildChromeTabScript(`${projectURL}?prompt=test`, scope);
    assert.doesNotMatch(script, /execute selectedTab javascript/);
    assert.doesNotMatch(script, /keystroke return/);
  });

  test("tries clicking ChatGPT's send button via Chrome's own JS execution before falling back to keystroke return", () => {
    const script = buildChromeTabScript(`${projectURL}?prompt=test`, scope, { autoEnter: true, enterDelayMs: 2000 });

    assert.match(script, /delay 2\.00/);
    assert.match(script, /execute selectedTab javascript "/);
    // send-button click JS must reach AppleScript with no unescaped quotes
    assert.match(script, /document\.querySelector\('\[data-testid=send-button\]'\)/);
    assert.match(script, /repeat while submitOutcome is not "CLICKED"/);
    // the keystroke fallback must still run whenever the JS route never clicks
    assert.match(script, /if submitOutcome is not "CLICKED" then\s*\n\s*tell application "System Events" to keystroke return/);
  });

  test("tolerates a couple of execute-javascript errors as retryable (a mid-navigation tab can throw transiently) rather than bailing on the first one", () => {
    const script = buildChromeTabScript(`${projectURL}?prompt=test`, scope, { autoEnter: true });
    assert.match(script, /on error\s*\n\s*set submitOutcome to "JS_ERROR"\s*\n\s*set jsErrorCount to jsErrorCount \+ 1\s*\n\s*end try/);
    assert.match(script, /repeat while submitOutcome is not "CLICKED" and jsErrorCount < \d+ and attemptCount < \d+/);
  });

  test("still falls back to keystroke once errors (not just disabled-button retries) are exhausted", () => {
    const script = buildChromeTabScript(`${projectURL}?prompt=test`, scope, { autoEnter: true });
    const maxErrorsMatch = script.match(/jsErrorCount < (\d+)/);
    assert.ok(maxErrorsMatch, "expected a jsErrorCount cap in the generated script");
    assert.ok(Number(maxErrorsMatch[1]) >= 2, "a single transient error must not be treated as permanent");
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
