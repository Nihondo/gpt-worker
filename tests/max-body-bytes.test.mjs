// The `body` size cap is per-workspace and configurable (gpt-worker limits),
// not a fixed constant — see worker/src/index.js's `maxBodyBytes()` and
// `localMaxBodyBytesGet/Set()`. This exercises the real BridgeDO methods
// directly, the same way tests/queue.test.mjs does.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BridgeDO } from "../worker/src/index.js";
import { makeFakeCtx, makeFakeEnv } from "./helpers/fake-do-ctx.mjs";

function makeDO() {
  return new BridgeDO(makeFakeCtx(), makeFakeEnv());
}

describe("maxBodyBytes(): default and configured value", () => {
  test("defaults to 16 KiB for a never-configured workspace", () => {
    const doo = makeDO();
    assert.equal(doo.maxBodyBytes(), 16 * 1024);
  });

  test("localMaxBodyBytesGet reports the default alongside floor/ceiling", () => {
    const doo = makeDO();
    const got = doo.localMaxBodyBytesGet();
    assert.equal(got.maxBodyBytes, 16 * 1024);
    assert.equal(got.default, 16 * 1024);
    assert.equal(got.floor, 4 * 1024);
    assert.equal(got.ceiling, 256 * 1024);
  });

  test("localMaxBodyBytesSet raises the cap and maxBodyBytes reflects it", () => {
    const doo = makeDO();
    const set = doo.localMaxBodyBytesSet({ maxBodyBytes: 128 * 1024 });
    assert.equal(set.maxBodyBytes, 128 * 1024);
    assert.equal(doo.maxBodyBytes(), 128 * 1024);
  });

  test("localMaxBodyBytesSet(null) resets to the default", () => {
    const doo = makeDO();
    doo.localMaxBodyBytesSet({ maxBodyBytes: 64 * 1024 });
    assert.equal(doo.maxBodyBytes(), 64 * 1024);
    doo.localMaxBodyBytesSet({ maxBodyBytes: null });
    assert.equal(doo.maxBodyBytes(), 16 * 1024);
  });

  test("rejects a value below the floor", () => {
    const doo = makeDO();
    const result = doo.localMaxBodyBytesSet({ maxBodyBytes: 1024 });
    assert.equal(result.error, "INVALID_ARGS");
    assert.equal(doo.maxBodyBytes(), 16 * 1024, "an invalid set must not change the effective value");
  });

  test("rejects a value above the ceiling", () => {
    const doo = makeDO();
    const result = doo.localMaxBodyBytesSet({ maxBodyBytes: 1024 * 1024 });
    assert.equal(result.error, "INVALID_ARGS");
    assert.equal(doo.maxBodyBytes(), 16 * 1024);
  });

  test("rejects a non-integer value", () => {
    const doo = makeDO();
    const result = doo.localMaxBodyBytesSet({ maxBodyBytes: 20000.5 });
    assert.equal(result.error, "INVALID_ARGS");
  });

  test("maxRequestBytes tracks maxBodyBytes plus the fixed envelope overhead", () => {
    const doo = makeDO();
    assert.equal(doo.maxRequestBytes(), 16 * 1024 + 2 * 1024);
    doo.localMaxBodyBytesSet({ maxBodyBytes: 100 * 1024 });
    assert.equal(doo.maxRequestBytes(), 100 * 1024 + 2 * 1024);
  });
});

describe("size enforcement actually uses the configured cap", () => {
  test("localEnqueue rejects a body over the default cap, accepts it once raised", () => {
    const doo = makeDO();
    const big = "x".repeat(17 * 1024); // over the 16 KiB default
    const rejected = doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: big });
    assert.equal(rejected.error, "BODY_TOO_LARGE");

    doo.localMaxBodyBytesSet({ maxBodyBytes: 32 * 1024 });
    const accepted = doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: big });
    assert.ok(accepted.message_id, "the same body must be accepted once the workspace's cap covers it");
  });

  test("queueSubmit rejects a body over the configured cap and names the effective limit", () => {
    const doo = makeDO();
    doo.localStartTask({ task_id: "t1", goal: "g", text: "GOAL:\ng" });
    doo.queueNext(); // lease the INIT so the round is "in flight" for submit_plan's bookkeeping, matching real use
    const big = "x".repeat(17 * 1024);
    const result = doo.queueSubmit({ task_id: "t1", iteration: 0, state: "PLAN", body: big });
    assert.equal(result.structuredContent.error, "BODY_TOO_LARGE");
    assert.match(result.structuredContent.message, /16384 bytes/);
    assert.match(result.structuredContent.message, /gpt-worker limits/);
  });
});
