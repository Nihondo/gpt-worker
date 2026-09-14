// Exercises the real BridgeDO queue methods (imported from
// worker/src/index.js, not reimplemented) against an in-memory node:sqlite
// backend. Run with: node --test tests/

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BridgeDO } from "../worker/src/index.js";
import { makeFakeCtx, makeFakeEnv } from "./helpers/fake-do-ctx.mjs";

function makeDO() {
  return new BridgeDO(makeFakeCtx(), makeFakeEnv());
}

describe("localEnqueue: iteration invariants", () => {
  test("INIT must be iteration 0", () => {
    const doo = makeDO();
    const bad = doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 1, body: "x" });
    assert.equal(bad.error, "INVALID_ITERATION");
    const ok = doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "x" });
    assert.ok(ok.message_id);
  });

  test("EXECUTED must be iteration >= 1", () => {
    const doo = makeDO();
    const bad = doo.localEnqueue({ kind: "EXECUTED", task_id: "t1", iteration: 0, body: "x" });
    assert.equal(bad.error, "INVALID_ITERATION");
    const ok = doo.localEnqueue({ kind: "EXECUTED", task_id: "t1", iteration: 1, body: "x" });
    assert.ok(ok.message_id);
  });

  test("rejects unknown kind / wrong types", () => {
    const doo = makeDO();
    assert.equal(doo.localEnqueue({ kind: "PLAN", task_id: "t1", iteration: 0, body: "x" }).error, "INVALID_ARGS");
    assert.equal(doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: "0", body: "x" }).error, "INVALID_ARGS");
    assert.equal(doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0.5, body: "x" }).error, "INVALID_ARGS");
  });
});

describe("localEnqueue: idempotent retry", () => {
  test("re-enqueuing the same task_id+iteration reuses the message_id", () => {
    const doo = makeDO();
    const first = doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "x" });
    const retry = doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "x (retried)" });
    assert.equal(retry.message_id, first.message_id);
    assert.equal(retry.idempotent, true);
    // still exactly one row for this task+iteration
    assert.equal(doo.localList({ task_id: "t1" }).messages.length, 1);
  });
});

describe("queueNext: lease semantics", () => {
  test("returns {empty:true} with nothing queued", () => {
    const doo = makeDO();
    assert.deepEqual(doo.queueNext(), { empty: true });
  });

  test("delivers the oldest pending message and leases it", () => {
    const doo = makeDO();
    doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "first" });
    doo.localEnqueue({ kind: "INIT", task_id: "t2", iteration: 0, body: "second" });
    const first = doo.queueNext();
    assert.equal(first.empty, false);
    assert.equal(first.task_id, "t1");
  });

  test("a second next_task() before the lease expires does not re-deliver it", () => {
    const doo = makeDO();
    doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "x" });
    const first = doo.queueNext();
    assert.equal(first.empty, false);
    const second = doo.queueNext();
    assert.equal(second.empty, true);
  });

  test("an expired lease becomes eligible again", () => {
    const doo = makeDO();
    doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "x" });
    const first = doo.queueNext();
    // Force the lease into the past directly, rather than sleeping in a test.
    doo.sql.exec(`UPDATE msgs SET lease_until = ? WHERE message_id = ?`, Date.now() - 1000, first.message_id);
    const second = doo.queueNext();
    assert.equal(second.empty, false);
    assert.equal(second.message_id, first.message_id);
  });

  test("task_id argument fetches only that task, no fallback to another", () => {
    const doo = makeDO();
    doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "older" });
    doo.localEnqueue({ kind: "INIT", task_id: "t2", iteration: 0, body: "newer" });
    const r = doo.queueNext("t2");
    assert.equal(r.task_id, "t2");
    assert.equal(doo.queueNext("does-not-exist").empty, true);
  });
});

describe("queueSubmit: task_id + iteration matching", () => {
  test("rejects a reply for a task_id/iteration with no open message", () => {
    const doo = makeDO();
    const r = doo.queueSubmit({ task_id: "nope", iteration: 0, state: "PLAN", body: "x" });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.error, "NO_MATCHING_TASK");
  });

  test("acks the matching to_gpt message and enqueues the reply to_local", () => {
    const doo = makeDO();
    doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "x" });
    doo.queueNext(); // GPT "picks up" the INIT
    const r = doo.queueSubmit({ task_id: "t1", iteration: 0, state: "PLAN", body: "do X" });
    assert.equal(r.structuredContent.message_id !== undefined, true);

    // the to_gpt INIT is now acked — a second submit_plan for the same round is rejected
    const dup = doo.queueSubmit({ task_id: "t1", iteration: 0, state: "PLAN", body: "again" });
    assert.equal(dup.structuredContent.error, "NO_MATCHING_TASK");

    // and the reply is waiting on the to_local side
    const local = doo.localList({ task_id: "t1" }).messages;
    assert.equal(local.length, 1);
    assert.equal(local[0].kind, "PLAN");
  });

  test("rejects an oversized body", () => {
    const doo = makeDO();
    doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "x" });
    const huge = "a".repeat(20 * 1024);
    const r = doo.queueSubmit({ task_id: "t1", iteration: 0, state: "PLAN", body: huge });
    assert.equal(r.structuredContent.error, "BODY_TOO_LARGE");
  });
});

describe("localAck / localDiscard / localDiscardTask", () => {
  test("localAck only clears to_local messages, never to_gpt", () => {
    const doo = makeDO();
    const enq = doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "x" });
    doo.localAck({ message_id: enq.message_id }); // wrong direction — no-op
    assert.equal(doo.localList({ task_id: "t1" }).messages.length, 1);
  });

  test("localDiscard clears a message regardless of direction", () => {
    const doo = makeDO();
    const enq = doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "x" });
    doo.localDiscard({ message_id: enq.message_id });
    assert.equal(doo.localList({ task_id: "t1" }).messages.length, 0);
  });

  test("localDiscardTask clears every open to_gpt message for that task, leaving others alone", () => {
    const doo = makeDO();
    doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "x" });
    doo.localEnqueue({ kind: "INIT", task_id: "t2", iteration: 0, body: "y" });
    doo.localDiscardTask({ task_id: "t1" });
    assert.equal(doo.localList({ task_id: "t1" }).messages.length, 0);
    assert.equal(doo.localList({ task_id: "t2" }).messages.length, 1);
    // next_task() no longer offers the discarded task's message
    assert.equal(doo.queueNext("t1").empty, true);
  });
});

describe("taskHistory", () => {
  test("empty when nothing has reached a terminal state yet", () => {
    const doo = makeDO();
    doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "x" });
    assert.deepEqual(doo.taskHistory({}), { tasks: [] });
  });

  test("includes acked DONE/BLOCKED, newest first, but not an in-flight PLAN", () => {
    const doo = makeDO();
    doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "goal 1" });
    doo.queueSubmit({ task_id: "t1", iteration: 0, state: "DONE", body: "finished t1" });

    doo.localEnqueue({ kind: "INIT", task_id: "t2", iteration: 0, body: "goal 2" });
    doo.queueSubmit({ task_id: "t2", iteration: 0, state: "PLAN", body: "still working on t2" });

    const history = doo.taskHistory({});
    assert.equal(history.tasks.length, 1);
    assert.equal(history.tasks[0].task_id, "t1");
    assert.equal(history.tasks[0].outcome, "DONE");
    assert.equal(history.tasks[0].summary, "finished t1");
  });

  test("respects limit", () => {
    const doo = makeDO();
    for (const t of ["a", "b", "c"]) {
      doo.localEnqueue({ kind: "INIT", task_id: t, iteration: 0, body: "x" });
      doo.queueSubmit({ task_id: t, iteration: 0, state: "DONE", body: `done ${t}` });
    }
    assert.equal(doo.taskHistory({ limit: 2 }).tasks.length, 2);
  });
});

describe("Worker-owned task state", () => {
  test("start, plan, report and done transition the remote task without a local checkpoint", () => {
    const doo = makeDO();
    const started = doo.localStartTask({ task_id: "t1", goal: "ship it", text: "INIT" });
    assert.equal(started.task.protocolState, "WAITING_PLAN");
    assert.equal(doo.activeTask().task_id, "t1");

    doo.queueNext("t1");
    doo.queueSubmit({ task_id: "t1", iteration: 0, state: "PLAN", body: "implement" });
    assert.equal(doo.activeTask().protocol_state, "EXECUTING");

    const report = doo.localReportTask({ task_id: "t1", changed: 1, tests: "ok", text: "EXECUTED" });
    assert.equal(report.task.iteration, 1);
    assert.equal(report.task.protocolState, "WAITING_REVIEW");

    doo.queueNext("t1");
    doo.queueSubmit({ task_id: "t1", iteration: 1, state: "DONE", body: "complete" });
    assert.equal(doo.activeTask(), null);
    assert.deepEqual(doo.taskHistory({}).tasks[0], {
      task_id: "t1",
      outcome: "DONE",
      summary: "complete",
      created_at: doo.getTask("t1").updated_at,
    });
  });

  test("refuses a second task unless force replaces the active remote task", () => {
    const doo = makeDO();
    doo.localStartTask({ task_id: "t1", goal: "first", text: "INIT" });
    assert.equal(doo.localStartTask({ task_id: "t2", goal: "second", text: "INIT" }).error, "ACTIVE_TASK");
    const forced = doo.localStartTask({ task_id: "t2", goal: "second", text: "INIT", force: true });
    assert.equal(forced.task.taskId, "t2");
    assert.equal(doo.getTask("t1").protocol_state, "BLOCKED");
  });

  test("stores trusted guidance remotely and exposes it only through the dedicated method", () => {
    const doo = makeDO();
    assert.deepEqual(doo.workspaceGuidance(), { set: false });
    doo.localGuidanceSet({ text: "Run lint first." });
    assert.deepEqual(doo.workspaceGuidance(), { set: true, guidance: "Run lint first." });
    doo.localGuidanceClear();
    assert.deepEqual(doo.workspaceGuidance(), { set: false });
  });
});

describe("localList: lease display and task_id filter", () => {
  test("shows an expired lease as pending, not leased", () => {
    const doo = makeDO();
    const enq = doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "x" });
    doo.queueNext(); // leases it
    doo.sql.exec(`UPDATE msgs SET lease_until = ? WHERE message_id = ?`, Date.now() - 1000, enq.message_id);
    const msg = doo.localList({ task_id: "t1" }).messages[0];
    assert.equal(msg.state, "pending");
  });
});
