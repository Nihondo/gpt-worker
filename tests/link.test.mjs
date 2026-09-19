// BridgeLink's dashboard_task_created handling (docs/plans/queue-dashboard.md,
// step 10): the RPC must be ACKed before the (potentially slow, Chrome-
// automation-driven) nudge callback runs, and a callback failure must never
// turn into a failed/garbled RPC reply — same ack-before-side-effect shape
// already used for plan_pushed.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeLink } from "../bridge/link.mjs";

/** A minimal fake WebSocket: readyState OPEN and a send() that records every
 *  outgoing frame, without opening a real socket. */
function fakeOpenSocket() {
  const sent = [];
  return {
    readyState: 1, // WebSocket.OPEN
    send: (data) => sent.push(JSON.parse(data)),
    sent,
  };
}

function attachFakeSocket(link) {
  const ws = fakeOpenSocket();
  link.ws = ws;
  return ws;
}

describe("BridgeLink: dashboard_task_created", () => {
  test("ACKs the RPC before invoking the callback", async () => {
    const order = [];
    const link = new BridgeLink({
      workerUrl: "https://example.test",
      workspaceId: "0123456789abcdef",
      linkToken: "tok",
      workspaceRoot: os.tmpdir(),
      onDashboardTaskCreated: (params) => {
        order.push(["callback", params]);
      },
    });
    const ws = attachFakeSocket(link);
    await link.handleMessage(JSON.stringify({ rid: "r1", method: "dashboard_task_created", params: { taskId: "t1" } }));
    order.push(["after-await"]);

    assert.equal(ws.sent.length, 1);
    assert.deepEqual(ws.sent[0], { rid: "r1", ok: true, result: {} });
    // The reply is synchronous (WebSocketPair send), so it necessarily lands
    // before this test's own "after-await" marker; the callback ran too,
    // and did not need to complete before the ACK was sent.
    assert.deepEqual(
      order.map((o) => o[0]),
      ["callback", "after-await"]
    );
  });

  test("a synchronously-throwing callback does not turn the ACK into an error reply", async () => {
    const link = new BridgeLink({
      workerUrl: "https://example.test",
      workspaceId: "0123456789abcdef",
      linkToken: "tok",
      workspaceRoot: os.tmpdir(),
      onDashboardTaskCreated: () => {
        throw new Error("boom");
      },
    });
    const ws = attachFakeSocket(link);
    await assert.doesNotReject(() => link.handleMessage(JSON.stringify({ rid: "r2", method: "dashboard_task_created", params: { taskId: "t2" } })));
    assert.equal(ws.sent.length, 1);
    assert.deepEqual(ws.sent[0], { rid: "r2", ok: true, result: {} });
  });

  test("defaults to a no-op when no callback is supplied", async () => {
    const link = new BridgeLink({
      workerUrl: "https://example.test",
      workspaceId: "0123456789abcdef",
      linkToken: "tok",
      workspaceRoot: os.tmpdir(),
    });
    const ws = attachFakeSocket(link);
    await assert.doesNotReject(() => link.handleMessage(JSON.stringify({ rid: "r3", method: "dashboard_task_created", params: { taskId: "t3" } })));
    assert.deepEqual(ws.sent[0], { rid: "r3", ok: true, result: {} });
  });

  test("params.__gptWorkerActiveTask is not required for this push method (not in GATED_METHODS)", async () => {
    let received;
    const link = new BridgeLink({
      workerUrl: "https://example.test",
      workspaceId: "0123456789abcdef",
      linkToken: "tok",
      workspaceRoot: os.tmpdir(),
      onDashboardTaskCreated: (params) => {
        received = params;
      },
    });
    const ws = attachFakeSocket(link);
    await link.handleMessage(JSON.stringify({ rid: "r4", method: "dashboard_task_created", params: { taskId: "t4" } }));
    assert.equal(ws.sent[0].ok, true);
    assert.deepEqual(received, { taskId: "t4" });
  });
});

describe("BridgeLink: workspace_batch", () => {
  function makeTestWorkspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-batch-test-"));
    fs.writeFileSync(path.join(dir, "hello.txt"), "hello world\n");
    fs.writeFileSync(path.join(dir, "notes.txt"), "some notes\n");
    return dir;
  }

  test("returns one reply for one WS request, preserving order and ids", async () => {
    const root = makeTestWorkspace();
    const link = new BridgeLink({
      workerUrl: "https://example.test",
      workspaceId: "0123456789abcdef",
      linkToken: "tok",
      workspaceRoot: root,
    });
    const ws = attachFakeSocket(link);

    await link.handleMessage(
      JSON.stringify({
        rid: "b1",
        method: "workspace_batch",
        params: {
          __gptWorkerActiveTask: true,
          calls: [
            { id: "call-info", name: "workspace_info" },
            { id: "call-read-1", name: "read_file", arguments: { path: "hello.txt" } },
            { id: "call-read-2", name: "read_file", arguments: { path: "notes.txt" } },
          ],
        },
      })
    );

    assert.equal(ws.sent.length, 1);
    const reply = ws.sent[0];
    assert.equal(reply.rid, "b1");
    assert.equal(reply.ok, true);
    assert.ok(reply.result);
    assert.equal(Array.isArray(reply.result.results), true);
    assert.equal(reply.result.results.length, 3);

    assert.equal(reply.result.results[0].id, "call-info");
    assert.equal(reply.result.results[0].name, "workspace_info");
    assert.equal(reply.result.results[0].ok, true);

    assert.equal(reply.result.results[1].id, "call-read-1");
    assert.equal(reply.result.results[1].name, "read_file");
    assert.equal(reply.result.results[1].ok, true);
    assert.equal(reply.result.results[1].result.text, "hello world\n");

    assert.equal(reply.result.results[2].id, "call-read-2");
    assert.equal(reply.result.results[2].name, "read_file");
    assert.equal(reply.result.results[2].ok, true);
    assert.equal(reply.result.results[2].result.text, "some notes\n");

    fs.rmSync(root, { recursive: true, force: true });
  });

  test("returns no_active_task when task is not active", async () => {
    const root = makeTestWorkspace();
    const link = new BridgeLink({
      workerUrl: "https://example.test",
      workspaceId: "0123456789abcdef",
      linkToken: "tok",
      workspaceRoot: root,
    });
    const ws = attachFakeSocket(link);

    await link.handleMessage(
      JSON.stringify({
        rid: "b2",
        method: "workspace_batch",
        params: {
          calls: [{ id: "c1", name: "workspace_info" }],
        },
      })
    );

    assert.equal(ws.sent.length, 1);
    assert.equal(ws.sent[0].rid, "b2");
    assert.equal(ws.sent[0].ok, true);
    assert.deepEqual(ws.sent[0].result, { status: "no_active_task" });

    fs.rmSync(root, { recursive: true, force: true });
  });

  test("rejects invalid top-level schema (not array, empty, exceeds limit)", async () => {
    const root = makeTestWorkspace();
    const link = new BridgeLink({
      workerUrl: "https://example.test",
      workspaceId: "0123456789abcdef",
      linkToken: "tok",
      workspaceRoot: root,
    });

    // 1. calls not an array
    let ws = attachFakeSocket(link);
    await link.handleMessage(
      JSON.stringify({
        rid: "err1",
        method: "workspace_batch",
        params: { __gptWorkerActiveTask: true, calls: "not-array" },
      })
    );
    assert.equal(ws.sent[0].result.status, "error");
    assert.equal(ws.sent[0].result.code, "INVALID_ARGS");

    // 2. calls empty
    ws = attachFakeSocket(link);
    await link.handleMessage(
      JSON.stringify({
        rid: "err2",
        method: "workspace_batch",
        params: { __gptWorkerActiveTask: true, calls: [] },
      })
    );
    assert.equal(ws.sent[0].result.status, "error");
    assert.equal(ws.sent[0].result.code, "INVALID_ARGS");

    // 3. calls exceeds limit (MAX_BATCH_CALLS = 8, pass 9)
    ws = attachFakeSocket(link);
    const nineCalls = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, name: "workspace_info" }));
    await link.handleMessage(
      JSON.stringify({
        rid: "err3",
        method: "workspace_batch",
        params: { __gptWorkerActiveTask: true, calls: nineCalls },
      })
    );
    assert.equal(ws.sent[0].result.status, "error");
    assert.equal(ws.sent[0].result.code, "INVALID_ARGS");

    fs.rmSync(root, { recursive: true, force: true });
  });

  test("rejects non-whitelisted tools, recursive batch, and push methods as INVALID_ARGS", async () => {
    const root = makeTestWorkspace();
    const link = new BridgeLink({
      workerUrl: "https://example.test",
      workspaceId: "0123456789abcdef",
      linkToken: "tok",
      workspaceRoot: root,
    });

    const invalidTools = ["workspace_batch", "workspace_guidance", "plan_pushed", "dashboard_task_created", "non_existent"];
    for (const tool of invalidTools) {
      const ws = attachFakeSocket(link);
      await link.handleMessage(
        JSON.stringify({
          rid: `rej-${tool}`,
          method: "workspace_batch",
          params: { __gptWorkerActiveTask: true, calls: [{ id: "c1", name: tool }] },
        })
      );
      assert.equal(ws.sent[0].result.status, "error", `Expected error for ${tool}`);
      assert.equal(ws.sent[0].result.code, "INVALID_ARGS");
    }

    // Invalid call structure: empty id or non-object arguments
    let ws = attachFakeSocket(link);
    await link.handleMessage(
      JSON.stringify({
        rid: "bad-id",
        method: "workspace_batch",
        params: { __gptWorkerActiveTask: true, calls: [{ id: "", name: "read_file" }] },
      })
    );
    assert.equal(ws.sent[0].result.code, "INVALID_ARGS");

    ws = attachFakeSocket(link);
    await link.handleMessage(
      JSON.stringify({
        rid: "bad-args",
        method: "workspace_batch",
        params: { __gptWorkerActiveTask: true, calls: [{ id: "c1", name: "read_file", arguments: "not-obj" }] },
      })
    );
    assert.equal(ws.sent[0].result.code, "INVALID_ARGS");

    fs.rmSync(root, { recursive: true, force: true });
  });

  test("subcall error does not fail the entire batch", async () => {
    const root = makeTestWorkspace();
    const link = new BridgeLink({
      workerUrl: "https://example.test",
      workspaceId: "0123456789abcdef",
      linkToken: "tok",
      workspaceRoot: root,
    });
    const ws = attachFakeSocket(link);

    await link.handleMessage(
      JSON.stringify({
        rid: "sub-err",
        method: "workspace_batch",
        params: {
          __gptWorkerActiveTask: true,
          calls: [
            { id: "c-fail", name: "read_file", arguments: { path: "does-not-exist.txt" } },
            { id: "c-ok", name: "read_file", arguments: { path: "hello.txt" } },
          ],
        },
      })
    );

    assert.equal(ws.sent.length, 1);
    const reply = ws.sent[0];
    assert.equal(reply.ok, true);
    assert.equal(reply.result.results.length, 2);

    assert.equal(reply.result.results[0].id, "c-fail");
    assert.equal(reply.result.results[0].ok, false);
    assert.equal(reply.result.results[0].error.error, "NOT_FOUND");

    assert.equal(reply.result.results[1].id, "c-ok");
    assert.equal(reply.result.results[1].ok, true);
    assert.equal(reply.result.results[1].result.text, "hello world\n");

    fs.rmSync(root, { recursive: true, force: true });
  });
});
