// The handoff round reuses the ordinary EXECUTED body and only appends a
// HANDOFF section. Two properties matter and are pinned here:
//
//   1. Without a handoff, the body must be byte-identical to what `report`
//      produced before this feature existed — a handoff must never change an
//      ordinary round.
//   2. The HANDOFF section carries the signal and the operator's reason only.
//      What ChatGPT should do with it lives in worker/src/instructions.md and
//      is never restated in a message body (see reference/protocol.md).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildExecutedBody } from "../bridge/cli.mjs";
import { operatingInstructions } from "../worker/src/instructions.js";

describe("buildExecutedBody without a handoff", () => {
  test("matches the pre-feature body exactly", () => {
    const body = buildExecutedBody({ changed: "a.mjs, b.mjs", tests: "npm test: pass" });
    assert.equal(body, "RESULT:\nExecution finished.\n\nCHANGED_FILES:\na.mjs, b.mjs\n\nTESTS:\nnpm test: pass");
  });

  test("keeps the (not run) fallback for empty tests", () => {
    const body = buildExecutedBody({ changed: "a.mjs", tests: "" });
    assert.match(body, /\nTESTS:\n\(not run\)$/);
  });

  test("adds no HANDOFF section for any falsy handoff", () => {
    for (const handoff of [undefined, null, false, 0, ""]) {
      const body = buildExecutedBody({ changed: "a.mjs", tests: "ok", handoff });
      assert.doesNotMatch(body, /HANDOFF/, `handoff=${JSON.stringify(handoff)} should not add a section`);
    }
  });
});

describe("buildExecutedBody with a handoff", () => {
  test("appends a HANDOFF section carrying the reason", () => {
    const body = buildExecutedBody({
      changed: "a.mjs",
      tests: "npm test: pass",
      handoff: { reason: "rate limit approaching" },
    });
    assert.match(body, /\n\nHANDOFF:\nreason: rate limit approaching$/);
  });

  test("carries either direction's reason through unchanged — no separate trigger field", () => {
    // A deliberate design choice, not an oversight: `report_task` doesn't
    // know or care which local agent is calling it, so the same command and
    // the same single-field body cover both "I'm stopping" and "I'm
    // claiming an abandoned round" — see CLAUDE.md. Do not reintroduce a
    // `trigger` field for this.
    for (const reason of ["rate limit approaching", "previous agent stopped without reporting; taking over"]) {
      const body = buildExecutedBody({ changed: "a.mjs", tests: "ok", handoff: { reason } });
      assert.doesNotMatch(body, /trigger:/, "HANDOFF must not grow a trigger/mode field");
      assert.match(body, new RegExp(`reason: ${reason}$`));
    }
  });

  test("preserves the ordinary sections ahead of it", () => {
    const plain = buildExecutedBody({ changed: "a.mjs", tests: "ok" });
    const withHandoff = buildExecutedBody({ changed: "a.mjs", tests: "ok", handoff: { reason: "x" } });
    assert.ok(withHandoff.startsWith(plain), "handoff must only append, never rewrite earlier sections");
  });

  test("falls back to (not given) when no reason is supplied", () => {
    for (const reason of [undefined, "", "   "]) {
      const body = buildExecutedBody({ changed: "a.mjs", tests: "ok", handoff: { reason } });
      assert.match(body, /\nreason: \(not given\)$/, `reason=${JSON.stringify(reason)}`);
    }
  });

  test("trims the reason", () => {
    const body = buildExecutedBody({ changed: "a.mjs", tests: "ok", handoff: { reason: "  rate limit  " } });
    assert.match(body, /\nreason: rate limit$/);
  });

  test("does not restate the operating protocol in the body", () => {
    const body = buildExecutedBody({ changed: "a.mjs", tests: "ok", handoff: { reason: "rate limit" } });
    // The body states what happened; instructions.md states what to do about it.
    assert.doesNotMatch(body, /HANDOFF_BRIEF/);
    assert.doesNotMatch(body, /\bmust\b|\bshould\b|\bReply\b/i);
  });
});

describe("operating instructions cover both directions of a handoff", () => {
  for (const connector of ["shared", "dedicated"]) {
    test(`${connector} connector explains stopping vs claiming, with a single command`, () => {
      const text = operatingInstructions(connector);
      assert.match(text, /HANDOFF section/, "must tell ChatGPT what a HANDOFF section means");
      assert.match(text, /gpt-worker handoff/, "must name the one command that covers both directions");
      assert.doesNotMatch(text, /gpt-worker claim/, "must not describe a separate claim command");
      assert.doesNotMatch(text, /trigger field|trigger:/, "must not describe a trigger/mode field");
      assert.match(text, /taking over a round the previous agent left without ever reporting/, "must describe the claiming direction in plain language");
      assert.match(text, /may honestly say little or nothing was verified/, "unverified CHANGED_FILES/TESTS must be explicitly sanctioned");
    });
  }
});

describe("operating instructions cover the handoff round", () => {
  for (const connector of ["shared", "dedicated"]) {
    test(`${connector} connector explains HANDOFF_BRIEF`, () => {
      const text = operatingInstructions(connector);
      assert.match(text, /HANDOFF_BRIEF:/, "must name the marker the local CLI looks for");
      // The receiving agent starts cold, so the brief has to restate the goal
      // and the reasoning rather than assume the conversation is shared.
      assert.match(text, /never saw the original request/);
      assert.match(text, /git_status and git_diff/, "brief must be grounded in the real working tree");
    });
  }
});
