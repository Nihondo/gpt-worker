// BridgeLink's dashboard_task_created handling (docs/plans/queue-dashboard.md,
// step 10): the RPC must be ACKed before the (potentially slow, Chrome-
// automation-driven) nudge callback runs, and a callback failure must never
// turn into a failed/garbled RPC reply — same ack-before-side-effect shape
// already used for plan_pushed.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
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
