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

describe("tasks title schema migration", () => {
  test("adds nullable title without rewriting existing task rows", () => {
    const ctx = makeFakeCtx();
    ctx.storage.sql.exec(`
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY, goal TEXT NOT NULL, iteration INTEGER NOT NULL,
        protocol_state TEXT NOT NULL, waiting_for TEXT NOT NULL,
        task_started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        terminal_summary TEXT
      )
    `);
    ctx.storage.sql.exec(
      `INSERT INTO tasks (task_id, goal, iteration, protocol_state, waiting_for, task_started_at, updated_at)
       VALUES ('legacy', 'old goal', 0, 'DONE', 'none', 1, 1)`
    );

    const doo = new BridgeDO(ctx, makeFakeEnv());
    assert.equal(doo.getTask("legacy").goal, "old goal");
    assert.equal(doo.getTask("legacy").title, null);
    assert.ok(ctx.storage.sql.exec(`PRAGMA table_info('tasks')`).toArray().some((column) => column.name === "title"));
  });

  test("migrates oldest combined legacy shape where both msgs and tasks lack title", () => {
    const ctx = makeFakeCtx();
    ctx.storage.sql.exec(`
      CREATE TABLE msgs (
        message_id  TEXT PRIMARY KEY,
        dir         TEXT NOT NULL,
        task_id     TEXT NOT NULL,
        iteration   INTEGER NOT NULL,
        kind        TEXT NOT NULL,
        body        TEXT NOT NULL,
        state       TEXT NOT NULL,
        lease_until INTEGER,
        created_at  INTEGER NOT NULL
      )
    `);
    ctx.storage.sql.exec(`
      CREATE TABLE tasks (
        task_id          TEXT PRIMARY KEY,
        goal             TEXT NOT NULL,
        iteration        INTEGER NOT NULL,
        protocol_state   TEXT NOT NULL,
        waiting_for      TEXT NOT NULL,
        task_started_at  INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        terminal_summary TEXT
      )
    `);
    ctx.storage.sql.exec(
      `INSERT INTO tasks (task_id, goal, iteration, protocol_state, waiting_for, task_started_at, updated_at)
       VALUES ('t-old', 'old goal', 0, 'WAITING_PLAN', 'GPT_PLAN', 100, 100)`
    );
    ctx.storage.sql.exec(
      `INSERT INTO msgs (message_id, dir, task_id, iteration, kind, body, state, lease_until, created_at)
       VALUES ('m-old', 'to_gpt', 't-old', 0, 'INIT', 'GOAL:\nold goal', 'pending', NULL, 100)`
    );

    const doo = new BridgeDO(ctx, makeFakeEnv());
    assert.ok(ctx.storage.sql.exec(`PRAGMA table_info('msgs')`).toArray().some((c) => c.name === "title"));
    assert.ok(ctx.storage.sql.exec(`PRAGMA table_info('tasks')`).toArray().some((c) => c.name === "title"));
    assert.equal(doo.getTask("t-old").title, null);
    const msg = doo.sql.exec(`SELECT title, body FROM msgs WHERE message_id = 'm-old'`).toArray()[0];
    assert.equal(msg.title, null);
    assert.equal(msg.body, "GOAL:\nold goal");
  });

  test("migrates intermediate shape where tasks already has title and backfills matching INIT msgs", () => {
    const ctx = makeFakeCtx();
    ctx.storage.sql.exec(`
      CREATE TABLE msgs (
        message_id  TEXT PRIMARY KEY,
        dir         TEXT NOT NULL,
        task_id     TEXT NOT NULL,
        iteration   INTEGER NOT NULL,
        kind        TEXT NOT NULL,
        body        TEXT NOT NULL,
        state       TEXT NOT NULL,
        lease_until INTEGER,
        created_at  INTEGER NOT NULL
      )
    `);
    ctx.storage.sql.exec(`
      CREATE TABLE tasks (
        task_id          TEXT PRIMARY KEY,
        goal             TEXT NOT NULL,
        title            TEXT,
        iteration        INTEGER NOT NULL,
        protocol_state   TEXT NOT NULL,
        waiting_for      TEXT NOT NULL,
        task_started_at  INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        terminal_summary TEXT
      )
    `);
    ctx.storage.sql.exec(
      `INSERT INTO tasks (task_id, goal, title, iteration, protocol_state, waiting_for, task_started_at, updated_at)
       VALUES ('t-int', 'int goal', 'Pre-existing Task Title', 1, 'EXECUTING', 'none', 100, 200)`
    );
    ctx.storage.sql.exec(
      `INSERT INTO msgs (message_id, dir, task_id, iteration, kind, body, state, lease_until, created_at)
       VALUES ('m-init', 'to_gpt', 't-int', 0, 'INIT', 'GOAL:\nint goal', 'acked', NULL, 100),
              ('m-plan', 'to_local', 't-int', 0, 'PLAN', 'Plan body', 'acked', NULL, 150)`
    );

    const doo = new BridgeDO(ctx, makeFakeEnv());
    const initRow = doo.sql.exec(`SELECT title FROM msgs WHERE message_id = 'm-init'`).toArray()[0];
    const planRow = doo.sql.exec(`SELECT title FROM msgs WHERE message_id = 'm-plan'`).toArray()[0];
    assert.equal(initRow.title, "Pre-existing Task Title");
    assert.equal(planRow.title, null);
  });
});

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

describe("queueSetTitle: current INIT lease only", () => {
  function startAndLease(doo, taskId = "t1") {
    doo.localStartTask({ task_id: taskId, goal: "Build title support", text: "GOAL:\nBuild title support" });
    return doo.queueNext(taskId);
  }

  function errorCode(result) {
    return result.structuredContent.error;
  }

  test("stores a normalized title without changing protocol fields or updatedAt", () => {
    const doo = makeDO();
    const next = startAndLease(doo);
    assert.equal(next.task_title, null);
    const before = doo.taskView(doo.getTask("t1"));
    const result = doo.queueSetTitle({ message_id: next.message_id, task_id: "t1", iteration: 0, title: "  Build\n  title\t support  " });
    const after = doo.taskView(doo.getTask("t1"));

    assert.deepEqual(result.structuredContent, { title: "Build title support", idempotent: false });
    assert.equal(after.title, "Build title support");
    assert.equal(after.protocolState, before.protocolState);
    assert.equal(after.iteration, before.iteration);
    assert.equal(after.updatedAt, before.updatedAt);
  });

  test("returns an existing title on INIT re-delivery after a lease expires", () => {
    const doo = makeDO();
    const first = startAndLease(doo);
    doo.queueSetTitle({ message_id: first.message_id, task_id: "t1", iteration: 0, title: "Title once" });
    doo.sql.exec(`UPDATE msgs SET lease_until = ? WHERE message_id = ?`, Date.now() - 1, first.message_id);
    const replay = doo.queueNext("t1");
    assert.equal(replay.task_title, "Title once");
  });

  test("rejects pending, wrong, expired, and stale INIT bindings", () => {
    const doo = makeDO();
    const pending = doo.localStartTask({ task_id: "t1", goal: "one", text: "GOAL:\none" });
    assert.equal(errorCode(doo.queueSetTitle({ message_id: pending.message_id, task_id: "t1", iteration: 0, title: "One" })), "NO_MATCHING_TASK");

    const next = doo.queueNext("t1");
    assert.equal(errorCode(doo.queueSetTitle({ message_id: "wrong", task_id: "t1", iteration: 0, title: "One" })), "NO_MATCHING_TASK");
    assert.equal(errorCode(doo.queueSetTitle({ message_id: next.message_id, task_id: "wrong", iteration: 0, title: "One" })), "NO_MATCHING_TASK");
    assert.equal(errorCode(doo.queueSetTitle({ message_id: next.message_id, task_id: "t1", iteration: 1, title: "One" })), "NO_MATCHING_TASK");

    doo.sql.exec(`UPDATE msgs SET lease_until = ? WHERE message_id = ?`, Date.now() - 1, next.message_id);
    assert.equal(errorCode(doo.queueSetTitle({ message_id: next.message_id, task_id: "t1", iteration: 0, title: "One" })), "NO_MATCHING_TASK");
    assert.equal(doo.getTask("t1").title, null);
  });

  test("rejects title writes after submit_plan has advanced the round", () => {
    const doo = makeDO();
    const next = startAndLease(doo);
    doo.queueSubmit({ task_id: "t1", iteration: 0, state: "PLAN", body: "implement it" });
    assert.equal(errorCode(doo.queueSetTitle({ message_id: next.message_id, task_id: "t1", iteration: 0, title: "Too late" })), "NO_MATCHING_TASK");
  });

  test("is idempotent for the same current title but never overwrites a different one", () => {
    const doo = makeDO();
    const next = startAndLease(doo);
    doo.queueSetTitle({ message_id: next.message_id, task_id: "t1", iteration: 0, title: "First title" });
    assert.deepEqual(
      doo.queueSetTitle({ message_id: next.message_id, task_id: "t1", iteration: 0, title: "First title" }).structuredContent,
      { title: "First title", idempotent: true }
    );
    assert.equal(errorCode(doo.queueSetTitle({ message_id: next.message_id, task_id: "t1", iteration: 0, title: "Replacement" })), "TITLE_ALREADY_SET");
    assert.equal(doo.getTask("t1").title, "First title");
  });

  test("is reachable through the dedicated MCP invokeTool dispatch", async () => {
    const doo = makeDO();
    const next = startAndLease(doo);
    const result = await doo.invokeTool("set_title", {
      message_id: next.message_id,
      task_id: "t1",
      iteration: 0,
      title: "MCP-dispatched title",
    });
    assert.deepEqual(result.structuredContent, { title: "MCP-dispatched title", idempotent: false });
  });

  test("rejects empty, over-limit, and control-character titles", () => {
    const doo = makeDO();
    const next = startAndLease(doo);
    for (const title of [" \t\n ", "😀".repeat(81), "bad\u0001title"]) {
      assert.equal(errorCode(doo.queueSetTitle({ message_id: next.message_id, task_id: "t1", iteration: 0, title })), "INVALID_TITLE");
    }
    assert.equal(
      doo.queueSetTitle({ message_id: next.message_id, task_id: "t1", iteration: 0, title: "😀".repeat(80) }).structuredContent.title,
      "😀".repeat(80)
    );
  });

  test("is exposed by taskView and taskHistory", () => {
    const doo = makeDO();
    const next = startAndLease(doo);
    doo.queueSetTitle({ message_id: next.message_id, task_id: "t1", iteration: 0, title: "Remembered title" });
    const sub = doo.queueSubmit({ task_id: "t1", iteration: 0, state: "DONE", body: "done" });
    doo.localAck({ message_id: sub.structuredContent.message_id });
    doo.localCompleteTask({ task_id: "t1" });
    assert.equal(doo.taskView(doo.getTask("t1")).title, "Remembered title");
    assert.equal(doo.taskHistory({}).tasks[0].title, "Remembered title");
  });

  test("set_title updates msgs.title for the INIT message", () => {
    const doo = makeDO();
    const next = startAndLease(doo);
    doo.queueSetTitle({ message_id: next.message_id, task_id: "t1", iteration: 0, title: "INIT Title" });
    const row = doo.sql.exec(`SELECT title FROM msgs WHERE message_id = ?`, next.message_id).toArray()[0];
    assert.equal(row.title, "INIT Title");
  });

  test("submit_plan preserves explicit title and falls back to auto-derived title", () => {
    const doo = makeDO();
    // Round 0: explicit title in submit_plan
    const next0 = startAndLease(doo, "t1", "GOAL:\nFirst goal");
    const sub0 = doo.queueSubmit({
      task_id: "t1",
      iteration: 0,
      state: "PLAN",
      body: "# Implementation Details\n1. Do something",
      title: "Custom Plan Title",
    });
    const row0 = doo.sql.exec(`SELECT title FROM msgs WHERE message_id = ?`, sub0.structuredContent.message_id).toArray()[0];
    assert.equal(row0.title, "Custom Plan Title");
    assert.equal(sub0.structuredContent.title, "Custom Plan Title");

    // Ack and report iteration 1
    doo.localAck({ message_id: sub0.structuredContent.message_id });
    const rep = doo.localReportTask({
      task_id: "t1",
      changed: 2,
      tests: "All tests passing",
      text: "RESULT:\nExecution finished.\n\nCHANGED_FILES:\n2\n\nTESTS:\nAll tests passing",
      title: "Executed round 1",
    });
    const repRow = doo.sql.exec(`SELECT title FROM msgs WHERE message_id = ?`, rep.message_id).toArray()[0];
    assert.equal(repRow.title, "Executed round 1");

    // Round 1: omit title in submit_plan -> derived from body
    const next1 = doo.queueNext("t1");
    assert.equal(next1.title, "Executed round 1");
    const sub1 = doo.queueSubmit({
      task_id: "t1",
      iteration: 1,
      state: "DONE",
      body: "## Wrap-up\nAll items completed successfully.",
    });
    const row1 = doo.sql.exec(`SELECT title FROM msgs WHERE message_id = ?`, sub1.structuredContent.message_id).toArray()[0];
    assert.equal(row1.title, "Wrap-up");
    assert.equal(sub1.structuredContent.title, "Wrap-up");
  });

  test("localReportTask auto-derives title from tests if omitted", () => {
    const doo = makeDO();
    startAndLease(doo, "t2", "GOAL:\nSecond goal");
    const sub = doo.queueSubmit({ task_id: "t2", iteration: 0, state: "PLAN", body: "plan" });
    doo.localAck({ message_id: sub.structuredContent.message_id });

    const rep = doo.localReportTask({
      task_id: "t2",
      changed: 1,
      tests: "Added 3 regression tests",
      text: "RESULT:\nExecution finished.\n\nCHANGED_FILES:\n1\n\nTESTS:\nAdded 3 regression tests",
    });
    const repRow = doo.sql.exec(`SELECT title FROM msgs WHERE message_id = ?`, rep.message_id).toArray()[0];
    assert.equal(repRow.title, "Added 3 regression tests");
  });

  test("localReportTask with tests '(not run)' leaves title null instead of boilerplate", () => {
    const doo = makeDO();
    startAndLease(doo, "t3", "GOAL:\nThird goal");
    const sub = doo.queueSubmit({ task_id: "t3", iteration: 0, state: "PLAN", body: "plan" });
    doo.localAck({ message_id: sub.structuredContent.message_id });

    const rep = doo.localReportTask({
      task_id: "t3",
      changed: 1,
      tests: "(not run)",
      text: "RESULT:\nExecution finished.\n\nCHANGED_FILES:\n1\n\nTESTS:\n(not run)",
    });
    const repRow = doo.sql.exec(`SELECT title FROM msgs WHERE message_id = ?`, rep.message_id).toArray()[0];
    assert.equal(repRow.title, null);
  });

  test("handoff EXECUTED with tests '(not run)' derives title from handoff reason", () => {
    const doo = makeDO();
    startAndLease(doo, "t4", "GOAL:\nFourth goal");
    const sub = doo.queueSubmit({ task_id: "t4", iteration: 0, state: "PLAN", body: "plan" });
    doo.localAck({ message_id: sub.structuredContent.message_id });

    const rep = doo.localReportTask({
      task_id: "t4",
      changed: 0,
      tests: "(not run)",
      text: "RESULT:\nExecution finished.\n\nCHANGED_FILES:\n0\n\nTESTS:\n(not run)\n\nHANDOFF:\nreason: rate limit reached",
    });
    const repRow = doo.sql.exec(`SELECT title FROM msgs WHERE message_id = ?`, rep.message_id).toArray()[0];
    assert.equal(repRow.title, "rate limit reached");
  });

  test("queueSubmit PLAN starting with HANDOFF_BRIEF does not derive HANDOFF_BRIEF as title", () => {
    const doo = makeDO();
    startAndLease(doo, "t5", "GOAL:\nFifth goal");
    const sub = doo.queueSubmit({
      task_id: "t5",
      iteration: 0,
      state: "PLAN",
      body: "HANDOFF_BRIEF:\nResume implementing the dashboard widget",
    });
    const row = doo.sql.exec(`SELECT title FROM msgs WHERE message_id = ?`, sub.structuredContent.message_id).toArray()[0];
    assert.equal(row.title, "Resume implementing the dashboard widget");
    assert.equal(sub.structuredContent.title, "Resume implementing the dashboard widget");
  });

  test("rejects invalid titles across localStartTask, localReportTask, localEnqueue, and queueSubmit", () => {
    const doo = makeDO();
    const tooLong = "a".repeat(81);
    const withCtrl = "Title\u0001WithCtrl";
    const onlyWhitespace = "   ";

    // localStartTask
    assert.equal(doo.localStartTask({ task_id: "inv1", goal: "g", text: "GOAL:\ng", title: tooLong }).error, "INVALID_TITLE");
    assert.equal(doo.localStartTask({ task_id: "inv2", goal: "g", text: "GOAL:\ng", title: withCtrl }).error, "INVALID_TITLE");
    assert.equal(doo.localStartTask({ task_id: "inv2b", goal: "g", text: "GOAL:\ng", title: onlyWhitespace }).error, "INVALID_TITLE");

    // Start valid task
    doo.localStartTask({ task_id: "inv3", goal: "g", text: "GOAL:\ng", title: "Valid Title" });
    const leased = doo.queueNext("inv3");

    // queueSubmit
    const invSub = doo.queueSubmit({ task_id: "inv3", iteration: 0, state: "PLAN", body: "body", title: tooLong });
    assert.equal(invSub.isError, true);
    assert.equal(invSub.structuredContent.error, "INVALID_TITLE");

    const invSubCtrl = doo.queueSubmit({ task_id: "inv3", iteration: 0, state: "PLAN", body: "body", title: withCtrl });
    assert.equal(invSubCtrl.isError, true);
    assert.equal(invSubCtrl.structuredContent.error, "INVALID_TITLE");

    // Valid queueSubmit
    const okSub = doo.queueSubmit({ task_id: "inv3", iteration: 0, state: "PLAN", body: "body" });
    doo.localAck({ message_id: okSub.structuredContent.message_id });

    // localReportTask
    assert.equal(
      doo.localReportTask({ task_id: "inv3", changed: 0, tests: "t", text: "txt", title: tooLong }).error,
      "INVALID_TITLE"
    );
    assert.equal(
      doo.localReportTask({ task_id: "inv3", changed: 0, tests: "t", text: "txt", title: withCtrl }).error,
      "INVALID_TITLE"
    );

    // localEnqueue
    assert.equal(
      doo.localEnqueue({ kind: "EXECUTED", task_id: "inv3", iteration: 2, body: "txt", title: tooLong }).error,
      "INVALID_TITLE"
    );
    assert.equal(
      doo.localEnqueue({ kind: "EXECUTED", task_id: "inv3", iteration: 2, body: "txt", title: onlyWhitespace }).error,
      "INVALID_TITLE"
    );
  });

  test("whitespace including newlines and tabs is normalized to single spaces across all title paths", () => {
    const doo = makeDO();
    const multiLine = "  Start\n  Task\t Title  ";
    doo.localStartTask({ task_id: "norm1", goal: "goal", text: "GOAL:\ngoal", title: multiLine });
    assert.equal(doo.getTask("norm1").title, "Start Task Title");
    const leased = doo.queueNext("norm1");
    assert.equal(leased.title, "Start Task Title");

    // queueSubmit with newlines
    const sub = doo.queueSubmit({
      task_id: "norm1",
      iteration: 0,
      state: "PLAN",
      body: "plan",
      title: "Plan\nWith\n\tNewlines",
    });
    assert.equal(sub.structuredContent.title, "Plan With Newlines");
    const subRow = doo.sql.exec(`SELECT title FROM msgs WHERE message_id = ?`, sub.structuredContent.message_id).toArray()[0];
    assert.equal(subRow.title, "Plan With Newlines");
    doo.localAck({ message_id: sub.structuredContent.message_id });

    // localReportTask with newlines
    const rep = doo.localReportTask({
      task_id: "norm1",
      changed: 0,
      tests: "t",
      text: "txt",
      title: "Report\n\t Title",
    });
    assert.equal(rep.title, "Report Title");
    const repRow = doo.sql.exec(`SELECT title FROM msgs WHERE message_id = ?`, rep.message_id).toArray()[0];
    assert.equal(repRow.title, "Report Title");
  });

  test("deriveMessageTitle truncates lines exceeding 80 code points in a code-point-safe manner", () => {
    const doo = makeDO();
    startAndLease(doo, "t-trunc", "GOAL:\nTruncation test");
    const longEmojiHeading = "## " + "🚀".repeat(100);
    const sub = doo.queueSubmit({
      task_id: "t-trunc",
      iteration: 0,
      state: "PLAN",
      body: longEmojiHeading,
    });
    const title = sub.structuredContent.title;
    assert.equal(Array.from(title).length, 80);
    assert.equal(title, "🚀".repeat(79) + "…");
  });
});

describe("localAck / localDiscard / localDiscardTask", () => {
  test("localAck only clears to_local messages, never to_gpt", () => {
    const doo = makeDO();
    const enq = doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "x" });
    doo.localAck({ message_id: enq.message_id }); // wrong direction — no-op
    assert.equal(doo.localList({ task_id: "t1" }).messages.length, 1);
  });

  test("localDiscard clears a message regardless of direction when task is terminal", () => {
    const doo = makeDO();
    const enq = doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "x" });
    // Active task check protects active tasks:
    assert.equal(doo.localDiscard({ message_id: enq.message_id }).error, "USE_DISCARD_TASK");
    // Once task is terminal, localDiscard succeeds regardless of direction (clears to_gpt):
    doo.sql.exec("UPDATE tasks SET protocol_state = 'DONE' WHERE task_id = 't1'");
    const res = doo.localDiscard({ message_id: enq.message_id });
    assert.equal(res.ok, true);
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
    const s1 = doo.queueSubmit({ task_id: "t1", iteration: 0, state: "DONE", body: "finished t1" });
    doo.localAck({ message_id: s1.structuredContent.message_id });
    doo.localCompleteTask({ task_id: "t1" });

    doo.localEnqueue({ kind: "INIT", task_id: "t2", iteration: 0, body: "goal 2" });
    const s2 = doo.queueSubmit({ task_id: "t2", iteration: 0, state: "PLAN", body: "still working on t2" });
    doo.localAck({ message_id: s2.structuredContent.message_id });

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
      const s = doo.queueSubmit({ task_id: t, iteration: 0, state: "DONE", body: `done ${t}` });
      doo.localAck({ message_id: s.structuredContent.message_id });
      doo.localCompleteTask({ task_id: t });
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
    const subPlan = doo.queueSubmit({ task_id: "t1", iteration: 0, state: "PLAN", body: "implement" });
    assert.equal(doo.activeTask().protocol_state, "WAITING_LOCAL");
    assert.equal(doo.activeTask().waiting_for, "LOCAL_PLAN_ACK");
    doo.localAck({ message_id: subPlan.structuredContent.message_id });
    assert.equal(doo.activeTask().protocol_state, "EXECUTING");

    const report = doo.localReportTask({ task_id: "t1", changed: 1, tests: "ok", text: "EXECUTED" });
    assert.equal(report.task.iteration, 1);
    assert.equal(report.task.protocolState, "WAITING_REVIEW");

    doo.queueNext("t1");
    const subDone = doo.queueSubmit({ task_id: "t1", iteration: 1, state: "DONE", body: "complete" });
    assert.equal(doo.activeTask().protocol_state, "WAITING_LOCAL");
    assert.equal(doo.activeTask().waiting_for, "LOCAL_DONE_ACK");
    doo.localAck({ message_id: subDone.structuredContent.message_id });
    assert.equal(doo.activeTask(), null);
    assert.deepEqual(doo.taskHistory({}).tasks[0], {
      task_id: "t1",
      title: null,
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

  // docs/plans/queue-dashboard.md's "localStartTask() の失敗時の整合性":
  // an oversized body must be rejected *before* any tasks/msgs row is
  // written, so a rejected start_task never leaves an orphaned WAITING_PLAN
  // task with zero queued INIT.
  describe("localStartTask: enqueue-failure consistency", () => {
    test("an oversized body is rejected before the tasks row is created (no active task afterward)", () => {
      const doo = makeDO();
      doo.localMaxBodyBytesSet({ maxBodyBytes: 4096 });
      const result = doo.localStartTask({ task_id: "t1", goal: "g", text: "x".repeat(5000) });
      assert.equal(result.error, "BODY_TOO_LARGE");
      assert.equal(doo.getTask("t1"), null);
      assert.equal(doo.activeTask(), null);
    });

    test("force + oversized body does not lose the previous active task", () => {
      const doo = makeDO();
      doo.localStartTask({ task_id: "t1", goal: "first", text: "INIT" });
      doo.localMaxBodyBytesSet({ maxBodyBytes: 4096 });
      const result = doo.localStartTask({ task_id: "t2", goal: "second", text: "x".repeat(5000), force: true });
      assert.equal(result.error, "BODY_TOO_LARGE");
      // The preflight runs before the force-discard of the previous task,
      // so t1 must still be the (untouched) active task — not BLOCKED, and
      // no orphaned t2 row either.
      assert.equal(doo.activeTask().task_id, "t1");
      assert.equal(doo.getTask("t1").protocol_state, "WAITING_PLAN");
      assert.equal(doo.getTask("t2"), null);
    });

    test("an existing task_id is rejected before any mutation, even with force on the same active task", () => {
      const doo = makeDO();
      doo.localStartTask({ task_id: "t1", goal: "first", text: "INIT" });
      const result = doo.localStartTask({ task_id: "t1", goal: "first again", text: "INIT", force: true });
      assert.equal(result.error, "TASK_EXISTS");
      // Must not have discarded/BLOCKed the very task this call collided with.
      assert.equal(doo.getTask("t1").protocol_state, "WAITING_PLAN");
      assert.equal(doo.activeTask().task_id, "t1");
    });

    test("collision with a retained terminal task_id is a controlled error, not a thrown SQL exception", () => {
      const doo = makeDO();
      doo.localStartTask({ task_id: "t1", goal: "first", text: "INIT" });
      doo.localDiscardTask({ task_id: "t1" }); // now BLOCKED, but the row is retained (see retention window)
      assert.doesNotThrow(() => {
        const result = doo.localStartTask({ task_id: "t1", goal: "second", text: "INIT" });
        assert.equal(result.error, "TASK_EXISTS");
      });
      assert.equal(doo.getTask("t1").protocol_state, "BLOCKED");
    });
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

describe("next_task: operating instructions", () => {
  test("the empty branch carries no instructions payload", async () => {
    const doo = makeDO();
    const result = await doo.invokeTool("next_task", {});
    assert.deepEqual(result.structuredContent, { empty: true });
  });

  test("dedicated connector: non-empty result includes the dedicated variant", async () => {
    const doo = makeDO();
    doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "goal" });
    const result = await doo.invokeTool("next_task", {});
    const { operating_instructions, task_id, iteration, kind, body } = result.structuredContent;
    assert.match(operating_instructions, /planning and review partner for gpt-worker/);
    assert.doesNotMatch(operating_instructions, /call list_workspaces first/);
    assert.equal(task_id, "t1");
    assert.equal(iteration, 0);
    assert.equal(kind, "INIT");
    assert.equal(body, "goal");
  });

  test("shared connector: non-empty result includes the shared variant", async () => {
    const doo = makeDO();
    doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "goal" });
    const result = await doo.invokeTool("next_task", {}, { connector: "shared" });
    assert.match(result.structuredContent.operating_instructions, /call list_workspaces first/);
  });

  test("an untitled INIT exposes task_title:null and the title lifecycle instruction", async () => {
    const doo = makeDO();
    doo.localStartTask({ task_id: "t1", goal: "goal", text: "GOAL:\ngoal" });
    const result = await doo.invokeTool("next_task", {});
    assert.equal(result.structuredContent.task_title, null);
    assert.match(result.structuredContent.operating_instructions, /task_title[\s\S]*set_title/);
  });

  test("a re-delivered INIT exposes its persisted task_title", async () => {
    const doo = makeDO();
    doo.localStartTask({ task_id: "t1", goal: "goal", text: "GOAL:\ngoal" });
    const first = await doo.invokeTool("next_task", {});
    doo.queueSetTitle({
      message_id: first.structuredContent.message_id,
      task_id: "t1",
      iteration: 0,
      title: "Persisted task title",
    });
    doo.sql.exec(`UPDATE msgs SET lease_until = ? WHERE message_id = ?`, Date.now() - 1, first.structuredContent.message_id);
    const replay = await doo.invokeTool("next_task", {});
    assert.equal(replay.structuredContent.task_title, "Persisted task title");
  });

  test("handleHubRelay (the shared connector's only path to invokeTool) always renders the shared variant", async () => {
    const doo = makeDO();
    doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "goal" });
    const response = await doo.handleHubRelay(
      new Request("https://gpt-worker.internal/hub", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "next_task", arguments: {} }),
      })
    );
    const body = await response.json();
    assert.match(body.structuredContent.operating_instructions, /call list_workspaces first/);
  });

  test("the operating_instructions tool itself returns the connector-appropriate variant and version", async () => {
    const doo = makeDO();
    const dedicated = await doo.invokeTool("operating_instructions", {});
    assert.doesNotMatch(dedicated.structuredContent.instructions, /call list_workspaces first/);
    assert.equal(typeof dedicated.structuredContent.operating_instructions_version, "string");
    const shared = await doo.invokeTool("operating_instructions", {}, { connector: "shared" });
    assert.match(shared.structuredContent.instructions, /call list_workspaces first/);
    assert.equal(typeof shared.structuredContent.operating_instructions_version, "string");
  });

  test("next_task includes operating_instructions_version and omits operating_instructions when version matches", async () => {
    const doo = makeDO();
    doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "goal 1" });
    const first = await doo.invokeTool("next_task", {});
    const version = first.structuredContent.operating_instructions_version;
    assert.equal(typeof version, "string");
    assert.ok(version.length > 0);
    assert.ok(first.structuredContent.operating_instructions);

    // Lease expired, call again with matching known_instructions_version
    doo.sql.exec(`UPDATE msgs SET lease_until = ? WHERE message_id = ?`, Date.now() - 1, first.structuredContent.message_id);
    const cached = await doo.invokeTool("next_task", { known_instructions_version: version });
    assert.equal(cached.structuredContent.operating_instructions_version, version);
    assert.equal(cached.structuredContent.operating_instructions, undefined);
    assert.equal(cached.structuredContent.task_id, "t1");
    assert.equal(cached.structuredContent.body, "goal 1");

    // Call with stale/mismatched version returns full instructions
    doo.sql.exec(`UPDATE msgs SET lease_until = ? WHERE message_id = ?`, Date.now() - 1, first.structuredContent.message_id);
    const stale = await doo.invokeTool("next_task", { known_instructions_version: "outdated-hash" });
    assert.equal(stale.structuredContent.operating_instructions_version, version);
    assert.ok(stale.structuredContent.operating_instructions);
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

describe("alarm(): retention sweeps for msgs and tasks", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function insertTask(doo, { taskId, protocolState, updatedAt }) {
    doo.sql.exec(
      `INSERT INTO tasks (task_id, goal, iteration, protocol_state, waiting_for, task_started_at, updated_at, terminal_summary)
       VALUES (?, 'goal', 1, ?, 'none', ?, ?, 'summary')`,
      taskId,
      protocolState,
      updatedAt,
      updatedAt
    );
  }

  test("purges acked msgs older than 7 days, keeps newer/unacked ones", async () => {
    const doo = makeDO();
    const old = doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "old" });
    const recent = doo.localEnqueue({ kind: "INIT", task_id: "t2", iteration: 0, body: "recent" });
    const unacked = doo.localEnqueue({ kind: "INIT", task_id: "t3", iteration: 0, body: "unacked" });
    doo.sql.exec(`UPDATE msgs SET state = 'acked', created_at = ? WHERE message_id = ?`, Date.now() - 8 * DAY_MS, old.message_id);
    doo.sql.exec(`UPDATE msgs SET state = 'acked', created_at = ? WHERE message_id = ?`, Date.now() - 1 * DAY_MS, recent.message_id);
    doo.sql.exec(`UPDATE msgs SET created_at = ? WHERE message_id = ?`, Date.now() - 8 * DAY_MS, unacked.message_id);

    await doo.alarm();

    const ids = doo.sql.exec(`SELECT message_id FROM msgs`).toArray().map((r) => r.message_id);
    assert.ok(!ids.includes(old.message_id), "acked message older than 7 days should be purged");
    assert.ok(ids.includes(recent.message_id), "acked message within 7 days should survive");
    assert.ok(ids.includes(unacked.message_id), "unacked message should survive regardless of age");
  });

  test("purges terminal tasks older than 30 days, keeps newer/active ones", async () => {
    const doo = makeDO();
    insertTask(doo, { taskId: "old-done", protocolState: "DONE", updatedAt: Date.now() - 31 * DAY_MS });
    insertTask(doo, { taskId: "old-blocked", protocolState: "BLOCKED", updatedAt: Date.now() - 31 * DAY_MS });
    insertTask(doo, { taskId: "recent-done", protocolState: "DONE", updatedAt: Date.now() - 1 * DAY_MS });
    insertTask(doo, { taskId: "old-active", protocolState: "AWAITING_PLAN", updatedAt: Date.now() - 31 * DAY_MS });

    await doo.alarm();

    const ids = doo.sql.exec(`SELECT task_id FROM tasks`).toArray().map((r) => r.task_id);
    assert.ok(!ids.includes("old-done"), "terminal task older than 30 days should be purged");
    assert.ok(!ids.includes("old-blocked"), "terminal task older than 30 days should be purged");
    assert.ok(ids.includes("recent-done"), "terminal task within 30 days should survive");
    assert.ok(ids.includes("old-active"), "active task should survive regardless of age");
  });

  test("purges expired dashboard sessions, keeps unexpired ones", async () => {
    const doo = makeDO();
    doo.provision();
    const expired = await doo.createDashboardSession();
    doo.sql.exec(`UPDATE dashboard_sessions SET expires_at = ?`, Date.now() - 1000);
    const fresh = await doo.createDashboardSession();

    await doo.alarm();

    assert.equal(await doo.verifyDashboardSession(expired.raw), false);
    assert.equal(await doo.verifyDashboardSession(fresh.raw), true);
  });
});

describe("WAITING_LOCAL and LOCAL_DECISION lifecycle", () => {
  test("PLAN submission moves task to WAITING_LOCAL / LOCAL_PLAN_ACK and Ack moves to EXECUTING", () => {
    const doo = makeDO();
    doo.localStartTask({ task_id: "t-plan", goal: "implement plan", text: "INIT" });
    doo.queueNext("t-plan");
    const sub = doo.queueSubmit({
      task_id: "t-plan",
      iteration: 0,
      state: "PLAN",
      body: "Here is the plan",
    });
    assert.ok(sub.structuredContent.message_id);

    const taskMid = doo.getTask("t-plan");
    assert.equal(taskMid.protocol_state, "WAITING_LOCAL");
    assert.equal(taskMid.waiting_for, "LOCAL_PLAN_ACK");

    // Local receives and acks the PLAN message
    const msg = doo.localList({ task_id: "t-plan" }).messages.find((m) => m.dir === "to_local");
    assert.ok(msg);
    const ackRes = doo.localAck({ message_id: msg.message_id });
    assert.equal(ackRes.ok, true);

    const taskAfter = doo.getTask("t-plan");
    assert.equal(taskAfter.protocol_state, "EXECUTING");
    assert.equal(taskAfter.waiting_for, "none");
  });

  test("BLOCKED submission moves task to WAITING_LOCAL / LOCAL_BLOCKED_ACK and Ack moves to BLOCKED / USER", () => {
    const doo = makeDO();
    doo.localStartTask({ task_id: "t-block", goal: "blocked task", text: "INIT" });
    doo.queueNext("t-block");
    const sub = doo.queueSubmit({
      task_id: "t-block",
      iteration: 0,
      state: "BLOCKED",
      body: "Need clarification",
    });
    assert.ok(sub.structuredContent.message_id);

    const taskMid = doo.getTask("t-block");
    assert.equal(taskMid.protocol_state, "WAITING_LOCAL");
    assert.equal(taskMid.waiting_for, "LOCAL_BLOCKED_ACK");
    assert.equal(taskMid.terminal_summary, "Need clarification");

    const msg = doo.localList({ task_id: "t-block" }).messages.find((m) => m.dir === "to_local");
    assert.ok(msg);
    const ackRes = doo.localAck({ message_id: msg.message_id });
    assert.equal(ackRes.ok, true);

    const taskAfter = doo.getTask("t-block");
    assert.equal(taskAfter.protocol_state, "BLOCKED");
    assert.equal(taskAfter.waiting_for, "USER");
  });

  test("DONE submission at iter >= 1 moves to WAITING_LOCAL / LOCAL_DONE_ACK and Ack moves to DONE", () => {
    const doo = makeDO();
    doo.localStartTask({ task_id: "t-done-iter1", goal: "implemented task", text: "INIT" });
    doo.queueNext("t-done-iter1");
    doo.queueSubmit({ task_id: "t-done-iter1", iteration: 0, state: "PLAN", body: "Plan" });
    const planMsg = doo.localList({ task_id: "t-done-iter1" }).messages.find((m) => m.dir === "to_local");
    doo.localAck({ message_id: planMsg.message_id });

    // Local reports iteration 1
    doo.localReportTask({ task_id: "t-done-iter1", changed: 1, tests: "ok", text: "Done implementation" });
    doo.queueNext("t-done-iter1"); // leased by gpt

    const sub = doo.queueSubmit({
      task_id: "t-done-iter1",
      iteration: 1,
      state: "DONE",
      body: "All verified and completed",
    });
    assert.ok(sub.structuredContent.message_id);

    const taskMid = doo.getTask("t-done-iter1");
    assert.equal(taskMid.protocol_state, "WAITING_LOCAL");
    assert.equal(taskMid.waiting_for, "LOCAL_DONE_ACK");
    assert.equal(taskMid.terminal_summary, "All verified and completed");

    const msg = doo.localList({ task_id: "t-done-iter1" }).messages.find((m) => m.dir === "to_local" && m.state === "pending");
    assert.ok(msg);
    const ackRes = doo.localAck({ message_id: msg.message_id });
    assert.equal(ackRes.ok, true);

    const taskAfter = doo.getTask("t-done-iter1");
    assert.equal(taskAfter.protocol_state, "DONE");
    assert.equal(taskAfter.waiting_for, "none");
    assert.equal(taskAfter.terminal_summary, "All verified and completed");
  });

  test("DONE submission at iter 0 (review-only) moves to LOCAL_DECISION on Ack, then can complete_task", () => {
    const doo = makeDO();
    doo.localStartTask({ task_id: "t-review", goal: "review task", text: "INIT" });
    doo.queueNext("t-review");
    const sub = doo.queueSubmit({
      task_id: "t-review",
      iteration: 0,
      state: "DONE",
      body: "Review complete: looks good or please fix typo",
    });
    assert.ok(sub.structuredContent.message_id);

    const taskMid = doo.getTask("t-review");
    assert.equal(taskMid.protocol_state, "WAITING_LOCAL");
    assert.equal(taskMid.waiting_for, "LOCAL_DONE_ACK");

    const msg = doo.localList({ task_id: "t-review" }).messages.find((m) => m.dir === "to_local");
    assert.ok(msg);
    const ackRes = doo.localAck({ message_id: msg.message_id });
    assert.equal(ackRes.ok, true);

    const taskDecision = doo.getTask("t-review");
    assert.equal(taskDecision.protocol_state, "WAITING_LOCAL");
    assert.equal(taskDecision.waiting_for, "LOCAL_DECISION");
    assert.equal(taskDecision.terminal_summary, "Review complete: looks good or please fix typo");

    // Local chooses to complete task directly
    const compRes = doo.localCompleteTask({ task_id: "t-review" });
    assert.equal(compRes.ok, true);

    const taskDone = doo.getTask("t-review");
    assert.equal(taskDone.protocol_state, "DONE");
    assert.equal(taskDone.waiting_for, "none");
    assert.equal(taskDone.terminal_summary, "Review complete: looks good or please fix typo");
  });

  test("DONE submission at iter 0 moves to LOCAL_DECISION on Ack, then can continue_task to EXECUTING", () => {
    const doo = makeDO();
    doo.localStartTask({ task_id: "t-continue", goal: "review then implement", text: "INIT" });
    doo.queueNext("t-continue");
    doo.queueSubmit({
      task_id: "t-continue",
      iteration: 0,
      state: "DONE",
      body: "Review finished. Implement suggestions.",
    });

    const msg = doo.localList({ task_id: "t-continue" }).messages.find((m) => m.dir === "to_local");
    assert.ok(msg);
    doo.localAck({ message_id: msg.message_id });

    // Local chooses to continue task
    const contRes = doo.localContinueTask({ task_id: "t-continue" });
    assert.equal(contRes.ok, true);

    const taskCont = doo.getTask("t-continue");
    assert.equal(taskCont.protocol_state, "EXECUTING");
    assert.equal(taskCont.waiting_for, "none");
    assert.equal(taskCont.terminal_summary, null, "terminal_summary should be cleared on continue");

    // Now local can report round 1 using the real localReportTask contract
    const rep = doo.localReportTask({
      task_id: "t-continue",
      changed: 1,
      tests: "All tests pass",
      text: "Implemented suggested changes",
    });
    assert.equal(rep.task.iteration, 1);
    assert.equal(rep.task.protocolState, "WAITING_REVIEW");
    assert.equal(doo.getTask("t-continue").waiting_for, "GPT_REVIEW");
  });

  test("localCompleteTask and localContinueTask reject tasks not in LOCAL_DECISION", () => {
    const doo = makeDO();
    doo.localStartTask({ task_id: "t-exec", goal: "in progress", text: "INIT" });

    const badComp = doo.localCompleteTask({ task_id: "t-exec" });
    assert.equal(badComp.error, "INVALID_STATE");

    const badCont = doo.localContinueTask({ task_id: "t-exec" });
    assert.equal(badCont.error, "INVALID_STATE");
  });

  test("duplicate localAck is idempotent and does not corrupt task state", () => {
    const doo = makeDO();
    doo.localStartTask({ task_id: "t-idemp", goal: "idempotent test", text: "INIT" });
    doo.queueNext("t-idemp");
    doo.queueSubmit({
      task_id: "t-idemp",
      iteration: 0,
      state: "PLAN",
      body: "Plan",
    });

    const msg = doo.localList({ task_id: "t-idemp" }).messages.find((m) => m.dir === "to_local");
    assert.ok(msg);
    const firstAck = doo.localAck({ message_id: msg.message_id });
    assert.equal(firstAck.ok, true);

    const secondAck = doo.localAck({ message_id: msg.message_id });
    assert.equal(secondAck.ok, true);

    const task = doo.getTask("t-idemp");
    assert.equal(task.protocol_state, "EXECUTING");
  });

  test("localAck on stale/wrong-iteration message does not overwrite newer task state", () => {
    const doo = makeDO();
    doo.localStartTask({ task_id: "t-stale", goal: "stale test", text: "INIT" });
    doo.queueNext("t-stale");
    const subPlan = doo.queueSubmit({ task_id: "t-stale", iteration: 0, state: "PLAN", body: "Plan" });
    doo.localAck({ message_id: subPlan.structuredContent.message_id });
    // Advance task to iteration 1 WAITING_REVIEW
    doo.localReportTask({ task_id: "t-stale", changed: 1, tests: "ok", text: "EXECUTED" });
    assert.equal(doo.getTask("t-stale").iteration, 1);
    assert.equal(doo.getTask("t-stale").protocol_state, "WAITING_REVIEW");

    // Acking the old iteration 0 message again does not drag the task back to EXECUTING
    const staleAck = doo.localAck({ message_id: subPlan.structuredContent.message_id });
    assert.equal(staleAck.ok, true);
    const task = doo.getTask("t-stale");
    assert.equal(task.iteration, 1);
    assert.equal(task.protocol_state, "WAITING_REVIEW");
  });

  test("localDiscard refuses to directly discard messages belonging to active tasks", () => {
    const doo = makeDO();
    doo.localStartTask({ task_id: "t-protect", goal: "protected", text: "INIT" });
    doo.queueNext("t-protect");
    const sub = doo.queueSubmit({ task_id: "t-protect", iteration: 0, state: "PLAN", body: "Plan" });

    // Active WAITING_LOCAL reply cannot be directly discarded
    const badDiscard = doo.localDiscard({ message_id: sub.structuredContent.message_id });
    assert.equal(badDiscard.error, "USE_DISCARD_TASK");
    assert.equal(doo.getTask("t-protect").protocol_state, "WAITING_LOCAL");

    // But after discarding the whole task, direct discard on any leftover is allowed
    doo.localDiscardTask({ task_id: "t-protect" });
    assert.equal(doo.getTask("t-protect").protocol_state, "BLOCKED");
    const okDiscard = doo.localDiscard({ message_id: sub.structuredContent.message_id });
    assert.equal(okDiscard.ok, true);
  });

  test("localDiscardTask automatically acks pending to_local messages in WAITING_LOCAL", () => {
    const doo = makeDO();
    doo.localStartTask({ task_id: "t-discard", goal: "will be discarded", text: "INIT" });
    doo.queueNext("t-discard");
    doo.queueSubmit({
      task_id: "t-discard",
      iteration: 0,
      state: "PLAN",
      body: "Plan",
    });

    assert.equal(doo.getTask("t-discard").protocol_state, "WAITING_LOCAL");
    const discardRes = doo.localDiscardTask({ task_id: "t-discard" });
    assert.equal(discardRes.ok, true);

    // Unacked list is now empty
    const unacked = doo.localList({ task_id: "t-discard" }).messages;
    assert.equal(unacked.length, 0);

    // DB inspection confirms all message rows are indeed acked
    const stored = doo.sql.exec(`SELECT state FROM msgs WHERE task_id = 't-discard'`).toArray();
    assert.ok(stored.length > 0, "should have stored messages");
    assert.ok(stored.every((m) => m.state === "acked"), "all messages must be acked in DB");
    assert.equal(doo.getTask("t-discard").protocol_state, "BLOCKED");
  });
});

describe("localBrowserSettings", () => {
  test("refuses on unprovisioned workspace", () => {
    const doo = makeDO();
    assert.equal(doo.localBrowserSettingsGet().error, "NOT_PROVISIONED");
    assert.equal(doo.localBrowserSettingsSet({}).error, "NOT_PROVISIONED");
  });

  test("fresh provision initializes browser settings with null values", () => {
    const doo = makeDO();
    doo.provision();
    const settings = doo.localBrowserSettingsGet();
    assert.equal(settings.initialized, true);
    assert.equal(settings.chatUrlOverride, null);
    assert.equal(settings.conversationUrl, null);
  });

  test("validates and canonicalizes URLs, clears conversation on override change", () => {
    const doo = makeDO();
    doo.provision();

    // Negative override URLs: non-https, non-chatgpt domain
    assert.equal(doo.localBrowserSettingsSet({ chatUrlOverride: "http://chatgpt.com/g/g-p-11112222333344445555666677778888/project" }).error, "INVALID_ARGS");
    assert.equal(doo.localBrowserSettingsSet({ chatUrlOverride: "https://example.com/g/g-p-11112222333344445555666677778888/project" }).error, "INVALID_ARGS");

    // Negative conversation URLs: non-https, arbitrary origin
    assert.equal(doo.localBrowserSettingsSet({ conversationUrl: "http://chatgpt.com/g/g-p-11112222333344445555666677778888/c/c-12345" }).error, "INVALID_ARGS");
    assert.equal(doo.localBrowserSettingsSet({ conversationUrl: "https://evil.com/g/g-p-11112222333344445555666677778888/c/c-12345" }).error, "INVALID_ARGS");

    // Valid override + matching conversation
    const proj = "https://chatgpt.com/g/g-p-11112222333344445555666677778888-myproj/project?prompt=test";
    const conv = "https://chatgpt.com/g/g-p-11112222333344445555666677778888-myproj/c/c-12345?query=ignored#hash";
    const saved = doo.localBrowserSettingsSet({
      chatUrlOverride: proj,
      conversationUrl: conv,
    });
    assert.equal(saved.initialized, true);
    assert.equal(saved.chatUrlOverride, "https://chatgpt.com/g/g-p-11112222333344445555666677778888-myproj/project?prompt=test");
    assert.equal(saved.conversationUrl, "https://chatgpt.com/g/g-p-11112222333344445555666677778888-myproj/c/c-12345");

    // Conversation from different project rejected
    const differentConv = "https://chatgpt.com/g/g-p-99999999999999999999999999999999/c/c-99999";
    const mismatch = doo.localBrowserSettingsSet({ conversationUrl: differentConv });
    assert.equal(mismatch.error, "INVALID_ARGS");

    // Changing override without specifying conversation clears conversation
    const newProj = "https://chatgpt.com/g/g-p-22222222222222222222222222222222/project";
    const changed = doo.localBrowserSettingsSet({ chatUrlOverride: newProj });
    assert.equal(changed.chatUrlOverride, newProj);
    assert.equal(changed.conversationUrl, null);

    // Has no side-effect on tasks or queue
    assert.equal(doo.activeTask(), null);
    assert.equal(doo.localList({}).messages.length, 0);
  });
});

// Transport seam (bridge-transport.js): BridgeDO keeps the Cloudflare runtime
// entrypoints (webSocketMessage/webSocketClose/webSocketError) and the
// callLocal/localStatus/handleLocalRoute compatibility methods as thin
// delegates, so these go through BridgeDO only — never the transport's
// closure state directly.
describe("local transport delegates", () => {
  function makeDOWithSockets() {
    const ctx = makeFakeCtx();
    const sockets = [];
    ctx.getWebSockets = () => sockets;
    return { doo: new BridgeDO(ctx, makeFakeEnv()), sockets };
  }

  test("callLocal resolves through the webSocketMessage runtime entrypoint (shared pending state)", async () => {
    const { doo, sockets } = makeDOWithSockets();
    const frames = [];
    sockets.push({ send: (frame) => frames.push(JSON.parse(frame)) });

    const call = doo.callLocal("read_file", { path: "a.txt" });
    assert.equal(frames.length, 1);
    assert.equal(frames[0].method, "read_file");
    assert.deepEqual(frames[0].params, { path: "a.txt" });

    // Stale/unsolicited and unparseable frames are ignored, not resolved.
    doo.webSocketMessage(null, JSON.stringify({ rid: "unknown", ok: true }));
    doo.webSocketMessage(null, "not json");
    const reply = { rid: frames[0].rid, ok: true, result: { content: "hello" } };
    doo.webSocketMessage(null, JSON.stringify(reply));
    assert.deepEqual(await call, reply);
  });

  test("webSocketClose and webSocketError resolve pending calls as local_disconnected", async () => {
    for (const entrypoint of ["webSocketClose", "webSocketError"]) {
      const { doo, sockets } = makeDOWithSockets();
      sockets.push({ send() {} });
      const call = doo.callLocal("x", {});
      doo[entrypoint]();
      assert.deepEqual(await call, { ok: false, error: { status: "local_disconnected" } }, entrypoint);
    }
  });

  test("callLocal reports local_offline with no socket or when send throws", async () => {
    const { doo, sockets } = makeDOWithSockets();
    assert.deepEqual(await doo.callLocal("x", {}), { ok: false, error: { status: "local_offline" } });
    sockets.push({ send() { throw new Error("closed"); } });
    assert.deepEqual(await doo.callLocal("x", {}), { ok: false, error: { status: "local_offline" } });
  });

  test("localStatus combines connection state with protocol queue counts", () => {
    const { doo, sockets } = makeDOWithSockets();
    assert.deepEqual(doo.localStatus(), { connected: false, pendingToGpt: 0, pendingToLocal: 0 });
    doo.localStartTask({ task_id: "t1", goal: "g", text: "GOAL:\ng" });
    sockets.push({});
    assert.deepEqual(doo.localStatus(), { connected: true, pendingToGpt: 1, pendingToLocal: 0 });
  });

  test("localMigrateLegacyState migrates one valid legacy task and is a no-op while a task is active", () => {
    const doo = makeDO();
    const migrated = doo.localMigrateLegacyState({
      taskId: "legacy-1", goal: "old goal", iteration: 2, protocolState: "EXECUTING", waitingFor: "none", taskStartedAt: 1234,
    });
    assert.equal(migrated.migrated, true);
    assert.equal(migrated.task.taskId, "legacy-1");
    assert.equal(migrated.task.goal, "old goal");
    assert.equal(migrated.task.iteration, 2);
    assert.equal(migrated.task.protocolState, "EXECUTING");
    assert.equal(migrated.task.taskStartedAt, 1234);

    const again = doo.localMigrateLegacyState({ taskId: "legacy-2", goal: "g", iteration: 0, protocolState: "WAITING_PLAN" });
    assert.equal(again.migrated, false);
    assert.equal(again.task.taskId, "legacy-1");
    assert.equal(doo.getTask("legacy-2"), null);

    assert.equal(makeDO().localMigrateLegacyState({ taskId: "x", goal: "g", iteration: 0, protocolState: "DONE" }).error, "INVALID_ARGS");
  });

  test("handleLocalRoute dispatches ops through the transport with token/method/op checks", async () => {
    const doo = makeDO();
    const { cliToken } = doo.provision();
    doo.localStartTask({ task_id: "t1", goal: "g", text: "GOAL:\ng" });
    const post = (token, body) =>
      doo.handleLocalRoute(new Request("https://x/local", { method: "POST", body: JSON.stringify(body) }), token);

    assert.equal((await post("wrong-token", { op: "status" })).status, 404);
    assert.equal((await doo.handleLocalRoute(new Request("https://x/local", { method: "GET" }), cliToken)).status, 405);
    assert.equal((await post(cliToken, { op: "no_such_op" })).status, 400);
    assert.deepEqual(await (await post(cliToken, { op: "status" })).json(), { connected: false, pendingToGpt: 1, pendingToLocal: 0 });
    assert.equal((await (await post(cliToken, { op: "active_task" })).json()).task.taskId, "t1");
  });
});
