import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  checkOrigin,
  constantTimeEqual,
  isValidWorkspaceId,
  readJsonWithLimit,
} from "../worker/src/worker-http.js";

describe("worker-http primitives", () => {
  test("validates current and legacy workspace IDs", () => {
    assert.equal(isValidWorkspaceId("0123456789abcdef"), true);
    assert.equal(isValidWorkspaceId("default"), true);
    assert.equal(isValidWorkspaceId("0123456789abcdeg"), false);
    assert.equal(isValidWorkspaceId("short"), false);
  });

  test("constantTimeEqual only accepts equal strings", () => {
    assert.equal(constantTimeEqual("same", "same"), true);
    assert.equal(constantTimeEqual("same", "different"), false);
    assert.equal(constantTimeEqual("same", null), false);
  });

  test("accepts server callers and only the allowed browser origins", () => {
    assert.equal(checkOrigin(new Request("https://worker.test")), true);
    assert.equal(checkOrigin(new Request("https://worker.test", { headers: { origin: "https://chatgpt.com" } })), true);
    assert.equal(checkOrigin(new Request("https://worker.test", { headers: { origin: "https://evil.example" } })), false);
  });

  test("reads JSON under the byte limit and rejects oversized or malformed bodies", async () => {
    assert.deepEqual(await readJsonWithLimit(new Request("https://worker.test", { method: "POST", body: '{"a":1}' }), 32), { value: { a: 1 } });
    assert.deepEqual(await readJsonWithLimit(new Request("https://worker.test", { method: "POST", body: '{"a":1}' }), 2), { tooLarge: true });
    assert.deepEqual(await readJsonWithLimit(new Request("https://worker.test", { method: "POST", body: "not json" }), 32), { parseError: true });
  });
});
