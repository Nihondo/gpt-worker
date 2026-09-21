// The pure side of the workspace_bundle hint that `gpt-worker wait` / `status`
// show (bridge/cli-runtime.mjs). What is decided here is only *when to speak*;
// whether there is a hint at all is the Worker's call (BridgeDO.bundleHint,
// tested in tests/queue.test.mjs). The wording says "may" throughout on purpose:
// a pending approval dialog and ChatGPT reading the archive look the same from here.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { bundleHintMessages, bundleStatusLine, bundleTimeoutMessage, formatAgeMs } from "../bridge/cli-runtime.mjs";

const hint = (ageMs, at = 1_000) => ({ code: "BUNDLE_RETURNED", at, ageMs });

describe("formatAgeMs", () => {
  test("reads naturally from seconds to hours", () => {
    assert.equal(formatAgeMs(0), "0s");
    assert.equal(formatAgeMs(42_000), "42s");
    assert.equal(formatAgeMs(89_000), "89s");
    assert.equal(formatAgeMs(120_000), "2 min");
    assert.equal(formatAgeMs(3_540_000), "59 min");
    assert.equal(formatAgeMs(3_900_000), "1 h 5 min");
    assert.equal(formatAgeMs(7_200_000), "2 h");
  });

  test("never prints nonsense for a missing or negative age", () => {
    assert.equal(formatAgeMs(undefined), "0s");
    assert.equal(formatAgeMs(-5_000), "0s");
    assert.equal(formatAgeMs("soon"), "0s");
  });
});

describe("bundleHintMessages", () => {
  test("announces a new hint immediately, without worrying yet", () => {
    const { lines, seen } = bundleHintMessages(hint(5_000), null);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /ChatGPT called workspace_bundle and was handed the archive \(5s ago\)/);
    assert.match(lines[0], /answer in the ChatGPT window/);
    assert.deepEqual(seen, { at: 1_000, adviceAgeMs: null });
  });

  test("the first reminder waits until the silence has lasted two minutes", () => {
    let seen = bundleHintMessages(hint(5_000), null).seen;
    let out = bundleHintMessages(hint(60_000), seen);
    assert.deepEqual(out.lines, []);
    out = bundleHintMessages(hint(119_000), out.seen);
    assert.deepEqual(out.lines, []);
    out = bundleHintMessages(hint(125_000), out.seen);
    assert.equal(out.lines.length, 1);
    assert.match(out.lines[0], /2 min since ChatGPT was handed a workspace_bundle archive, with no reply/);
    assert.match(out.lines[0], /may still be reading it/);
    assert.equal(out.seen.adviceAgeMs, 125_000);
  });

  test("then repeats only every five minutes", () => {
    let out = bundleHintMessages(hint(130_000), { at: 1_000, adviceAgeMs: 125_000 });
    assert.deepEqual(out.lines, []);
    out = bundleHintMessages(hint(424_000), out.seen);
    assert.deepEqual(out.lines, []);
    out = bundleHintMessages(hint(426_000), out.seen);
    assert.equal(out.lines.length, 1);
    assert.equal(out.seen.adviceAgeMs, 426_000);
  });

  test("a hint first seen when already old says both things at once", () => {
    const { lines } = bundleHintMessages(hint(600_000), null);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /called workspace_bundle/);
    assert.match(lines[1], /10 min since/);
  });

  test("the same hint is never announced twice; a different bundle starts over", () => {
    const first = bundleHintMessages(hint(5_000), null);
    assert.deepEqual(bundleHintMessages(hint(6_000), first.seen).lines, []);
    const another = bundleHintMessages(hint(5_000, 9_000), first.seen);
    assert.equal(another.lines.length, 1);
    assert.deepEqual(another.seen, { at: 9_000, adviceAgeMs: null });
  });

  test("no hint, or a malformed one, says nothing and keeps what was remembered", () => {
    const seen = { at: 1_000, adviceAgeMs: null };
    assert.deepEqual(bundleHintMessages(null, seen), { lines: [], seen });
    assert.deepEqual(bundleHintMessages(undefined, null), { lines: [], seen: null });
    assert.deepEqual(bundleHintMessages({ code: "BUNDLE_RETURNED" }, seen), { lines: [], seen });
  });
});

describe("bundleTimeoutMessage", () => {
  test("starts with the usual sentence, counts time since the hint arrived, and offers the next step", () => {
    const line = bundleTimeoutMessage(hint(60_000), 90_000);
    assert.match(line, /^No message yet\. /);
    assert.match(line, /archive 3 min ago and has not replied since/);
    assert.match(line, /may be waiting for you to approve opening the attachment in the ChatGPT window/);
    assert.match(line, /Run 'gpt-worker wait' again to keep waiting\.$/);
  });

  test("a negative elapsed time is treated as none", () => {
    assert.match(bundleTimeoutMessage(hint(60_000), -5_000), /archive 60s ago/);
  });
});

describe("bundleStatusLine", () => {
  test("is one line and hedges", () => {
    const line = bundleStatusLine(hint(180_000));
    assert.equal(line.includes("\n"), false);
    assert.match(line, /3 min ago and has not continued/);
    assert.match(line, /may be waiting for your approval/);
  });
});
