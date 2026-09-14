import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { escapeForAppleScript, isChromeAutomationAvailable } from "../bridge/mac-chrome.mjs";

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
