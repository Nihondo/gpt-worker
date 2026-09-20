// The task commands (`wait`, `discard-task`, `report`, `handoff`) run as the real
// CLI process against a fake Worker (tests/helpers/fake-worker.mjs). Nothing in
// the CLI is stubbed: what is asserted is what a coding agent would actually
// see — exit code, stdout, stderr — because that is the contract SKILL.md
// tells agents to act on.
//
// The fixture worker.json deliberately has no chatUrl, so nudgeChatGpt() takes
// its early return and never reaches Chrome automation or opens a browser.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli, startFakeWorker } from "./helpers/fake-worker.mjs";

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-task-config-"));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-task-state-"));
process.env.GPT_WORKER_CONFIG_DIR = configDir;
process.env.GPT_WORKER_STATE_ROOT = stateDir;
const { writeTokensAtomic, workspaceStateDir } = await import("../bridge/state.mjs?cli-task-test");
const { findStuckAck } = await import("../bridge/cli-task.mjs?cli-task-test");

after(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const WORKSPACE_ID = "0123456789abcdef";
const CLI_TOKEN = "cli-token";
const CLI_ENV = {
  GPT_WORKER_CONFIG_DIR: configDir,
  GPT_WORKER_STATE_ROOT: stateDir,
  // Fast retries and a short pause between wait's reconnect attempts.
  GPT_WORKER_RETRY_BASE_MS: "1",
  GPT_WORKER_WAIT_RETRY_MS: "20",
};

function task(overrides = {}) {
  return {
    taskId: "t1",
    goal: "Fix the bug\nwith detail",
    title: "Fix the bug",
    iteration: 0,
    protocolState: "WAITING_PLAN",
    waitingFor: "GPT_PLAN",
    ...overrides,
  };
}

const PLAN = { message_id: "m1", task_id: "t1", iteration: 0, kind: "PLAN", dir: "to_local", body: "Step 1: edit a.js" };

/** A fresh provisioned workspace pointing at `server`. Returns its root, a
 *  runner bound to it, and a reader for its bridge.log. */
function makeWorkspace(server) {
  fs.writeFileSync(path.join(configDir, "worker.json"), JSON.stringify({ workerUrl: server.url, adminToken: "admin-token" }), { mode: 0o600 });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gw-task-ws-")));
  writeTokensAtomic(root, { workspaceId: WORKSPACE_ID, gptToken: "g", linkToken: "l", cliToken: CLI_TOKEN });
  return {
    root,
    run: (args, opts) => runCli([...args, "-w", root], { env: CLI_ENV, ...opts }),
    log: () => {
      try {
        return fs.readFileSync(path.join(workspaceStateDir(root), "bridge.log"), "utf8");
      } catch {
        return "";
      }
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** Routes /local ops through `ops`; anything else (the /admin lookups made by
 *  the chat-settings loader) is answered with an empty object.
 *
 *  A plain object in `ops` is the response *body* of a 200. Anything else a
 *  reply can be — a status code, a dropped connection, a delay — must be given
 *  as a function returning a fake-worker reply description, e.g.
 *  `() => ({ status: 500 })` or `() => ({ destroy: true })`. */
function opsHandler(ops) {
  return (call) => {
    if (!call.path.startsWith("/local/")) return { body: {} };
    const handler = ops[call.op];
    if (handler === undefined) return { body: {} };
    return typeof handler === "function" ? handler(call) : { body: handler };
  };
}

async function withWorker(handler, fn) {
  const server = await startFakeWorker(handler);
  const ws = makeWorkspace(server);
  try {
    return await fn({ server, ws });
  } finally {
    await server.close();
    ws.cleanup();
  }
}

const ACK_OK = { ok: true, acked: true, transitioned: true, task: task({ protocolState: "EXECUTING", waitingFor: "none" }) };
const ACK_STUCK = {
  ok: true,
  acked: true,
  transitioned: false,
  reason: "STATE_MISMATCH",
  task: task({ protocolState: "WAITING_LOCAL", waitingFor: "LOCAL_PLAN_ACK" }),
};

describe("wait: delivering a reply", () => {
  test("prints the reply, acks it, and exits 0 when the task advanced", async () => {
    await withWorker(
      opsHandler({ active_task: { task: task() }, poll: { messages: [PLAN] }, ack: ACK_OK }),
      async ({ server, ws }) => {
        const res = await ws.run(["wait", "--timeout", "5"]);
        assert.equal(res.code, 0, res.stderr);
        assert.match(res.stdout, /=== PLAN \(task t1, iteration 0\) ===/);
        assert.match(res.stdout, /Step 1: edit a\.js/);
        assert.doesNotMatch(res.stderr, /WARNING/);
        assert.deepEqual(server.calls("ack")[0].body, { op: "ack", message_id: "m1" });
      }
    );
  });

  test("a reply that acked but left the task stuck exits 3 — after printing the reply", async () => {
    await withWorker(
      opsHandler({ active_task: { task: task() }, poll: { messages: [PLAN] }, ack: ACK_STUCK }),
      async ({ ws }) => {
        const res = await ws.run(["wait", "--timeout", "5"]);
        assert.equal(res.code, 3);
        // The agent still needs the reply even though the task did not advance.
        assert.match(res.stdout, /Step 1: edit a\.js/);
        assert.match(res.stderr, /the task did not advance/);
        assert.match(res.stderr, /STATE_MISMATCH/);
        assert.match(res.stderr, /WAITING_LOCAL/);
        assert.match(res.stderr, new RegExp(`gpt-worker discard-task -w ${ws.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} --yes`));
        assert.match(ws.log(), /wait: ack did not advance task t1 \(STATE_MISMATCH/);
      }
    );
  });

  test("cases that leave nothing to recover are not flagged", async () => {
    const cases = {
      // The first ack applied the transition; only its response was lost.
      "a retried ack whose first attempt did apply": {
        ...ACK_STUCK,
        already_acked: true,
        task: task({ protocolState: "EXECUTING", waitingFor: "none" }),
      },
      // An iteration-0 DONE legitimately parks in LOCAL_DECISION, which is
      // WAITING_LOCAL but not waiting for an ack.
      "a re-acked iteration-0 DONE parked in LOCAL_DECISION": {
        ...ACK_STUCK,
        already_acked: true,
        task: task({ protocolState: "WAITING_LOCAL", waitingFor: "LOCAL_DECISION" }),
      },
      "a task that is already terminal": { ...ACK_STUCK, task: task({ protocolState: "BLOCKED", waitingFor: "USER" }) },
      "an older Worker that predates the ack fields": { ok: true },
    };
    for (const [name, ack] of Object.entries(cases)) {
      await withWorker(
        opsHandler({ active_task: { task: task() }, poll: { messages: [PLAN] }, ack }),
        async ({ ws }) => {
          const res = await ws.run(["wait", "--timeout", "5"]);
          assert.equal(res.code, 0, `${name}: ${res.stderr}`);
          assert.match(res.stdout, /Step 1: edit a\.js/);
        }
      );
    }
  });

  test("a retried ack that hides a real wedge is still caught: the task is still waiting for an ack", async () => {
    // The first ack marked the message delivered but failed to transition
    // (KIND_MISMATCH) and its response was lost; the retry says already_acked.
    // The task still waiting for a local ack is the proof it never advanced.
    const hidden = { ...ACK_STUCK, already_acked: true, reason: "KIND_MISMATCH", task: task({ protocolState: "WAITING_LOCAL", waitingFor: "LOCAL_DONE_ACK" }) };
    await withWorker(opsHandler({ active_task: { task: task() }, poll: { messages: [PLAN] }, ack: hidden }), async ({ ws }) => {
      const res = await ws.run(["wait", "--timeout", "5"]);
      assert.equal(res.code, 3, res.stderr);
      assert.match(res.stdout, /Step 1: edit a\.js/);
      assert.match(res.stderr, /KIND_MISMATCH/);
    });
  });

  // A Worker that remembers what it recorded. Scenario tests below drive it with
  // `mode`, and every mode drops the connection so the response is lost:
  //   "applyThenDrop"    records the ack AND advances the task
  //   "neverApply"       records nothing
  //   "ackedNoTransition" marks the message delivered but does NOT advance the
  //                      task (localAck acks the message before it validates the
  //                      transition, so a mismatch does exactly this)
  function statefulAckWorker(mode) {
    const state = { applied: false, messageAcked: false, dropAcks: true };
    const stuckTask = task({ protocolState: "WAITING_LOCAL", waitingFor: "LOCAL_PLAN_ACK" });
    const movedOn = task({ protocolState: "EXECUTING", waitingFor: "none" });
    const pending = () => (state.applied || state.messageAcked ? [] : [PLAN]);
    const handler = opsHandler({
      active_task: () => ({ body: { task: state.applied ? movedOn : stuckTask } }),
      poll: () => ({ body: { messages: pending() } }),
      // `gpt-worker queue` prints created_at and body_preview, so give it a
      // message shaped like the Worker's real `list` rows.
      list: () => ({ body: { messages: pending().map((m) => ({ ...m, state: "pending", created_at: 1_700_000_000_000, body_preview: m.body })) } }),
      ack: () => {
        if (!state.dropAcks) {
          state.applied = true;
          return { body: { ...ACK_OK, task: movedOn } };
        }
        if (mode === "applyThenDrop") state.applied = true;
        if (mode === "ackedNoTransition") state.messageAcked = true;
        return { destroy: true };
      },
    });
    return { state, handler };
  }

  test("an ack that landed but was never confirmed: the reply is not redelivered, and the message says to act on it once", async () => {
    const { state, handler } = statefulAckWorker("applyThenDrop");
    await withWorker(handler, async ({ ws }) => {
      const first = await ws.run(["wait", "--timeout", "5"]);
      assert.equal(first.code, 4, first.stderr);
      assert.match(first.stdout, /Step 1: edit a\.js/, "the body was printed even though the ack could not be confirmed");
      assert.equal(state.applied, true, "the Worker did record the ack");
      // The guidance must not promise a redelivery it cannot know will happen.
      assert.match(first.stderr, /it is unknown whether it recorded the acknowledgement/);
      assert.match(first.stderr, /gpt-worker state -w /);
      assert.match(first.stderr, /will NOT deliver this reply again/);
      assert.doesNotMatch(first.stderr, /you may see it twice|Nothing was lost/);

      // What the message describes really happens: the task moved on and a
      // second wait has nothing to deliver.
      const second = await ws.run(["wait", "--timeout", "1"], { timeoutMs: 20_000 });
      assert.equal(second.code, 2, second.stderr);
      assert.doesNotMatch(second.stdout, /Step 1: edit a\.js/);
      const stateOut = await ws.run(["state"]);
      assert.match(stateOut.stdout, /"protocolState": "EXECUTING"/);
    });
  });

  test("a reply recorded as delivered while the task never advanced: nothing will redeliver it, and the guidance says so", async () => {
    // The third outcome. The message is acked, the task still waits for that
    // very ack, the queue is empty — so `wait` can never return it. The task's
    // state alone cannot tell this from "the ack never landed"; the queue can.
    const { handler } = statefulAckWorker("ackedNoTransition");
    await withWorker(handler, async ({ ws }) => {
      const first = await ws.run(["wait", "--timeout", "5"]);
      assert.equal(first.code, 4, first.stderr);
      assert.match(first.stdout, /Step 1: edit a\.js/);
      assert.match(first.stderr, /gpt-worker queue -w .* --task t1/, "the guidance sends the agent to this task's queue as well as the state");
      assert.match(first.stderr, /lists a \[to_local\] PLAN for it/, "and says exactly which row to look for");
      assert.match(first.stderr, /nothing pending: the reply was recorded as delivered while the task never advanced/);
      assert.match(first.stderr, /discard-task -w .* --yes/);

      // What the third branch claims is what actually happens:
      const stateOut = await ws.run(["state"]);
      assert.match(stateOut.stdout, /"waitingFor": "LOCAL_PLAN_ACK"/, "still waiting for the ack");
      const queueOut = await ws.run(["queue"]);
      assert.match(queueOut.stdout, /Queue is empty/, "and the queue has nothing for `wait` to deliver");
      const second = await ws.run(["wait", "--timeout", "1"], { timeoutMs: 20_000 });
      assert.equal(second.code, 2, "wait never returns it");
      assert.doesNotMatch(second.stdout, /Step 1: edit a\.js/);
    });
  });

  test("an ack that never landed: the task still waits for it, and the next wait delivers the same reply", async () => {
    const { state, handler } = statefulAckWorker("neverApply");
    await withWorker(handler, async ({ ws }) => {
      const first = await ws.run(["wait", "--timeout", "5"]);
      assert.equal(first.code, 4, first.stderr);
      assert.match(first.stdout, /Step 1: edit a\.js/);
      assert.equal(state.applied, false);
      assert.match(first.stderr, /it did not land/);

      const stateOut = await ws.run(["state"]);
      assert.match(stateOut.stdout, /"waitingFor": "LOCAL_PLAN_ACK"/);
      const queueOut = await ws.run(["queue"]);
      assert.match(queueOut.stdout, /\[to_local\] PLAN task=t1/, "the reply is still queued — the difference from the stuck case");

      state.dropAcks = false; // the network is back
      const second = await ws.run(["wait", "--timeout", "5"]);
      assert.equal(second.code, 0, second.stderr);
      assert.match(second.stdout, /Step 1: edit a\.js/, "the unacknowledged reply is delivered again");
      assert.equal(state.applied, true);
    });
  });

  test("the reply is printed BEFORE it is acked, so an ack that cannot be confirmed never loses the body", async () => {
    // The nasty case: the ack reaches the Worker and marks the message
    // delivered, but its reply is lost and every retry fails too. Acking first
    // meant the body was gone from the queue without the agent ever seeing it.
    await withWorker(
      opsHandler({ active_task: { task: task() }, poll: { messages: [PLAN] }, ack: () => ({ destroy: true }) }),
      async ({ server, ws }) => {
        const res = await ws.run(["wait", "--timeout", "5"]);
        assert.equal(res.code, 4, res.stderr);
        // The body reached stdout even though no ack was ever confirmed.
        assert.match(res.stdout, /Step 1: edit a\.js/);
        assert.match(res.stderr, /reply above was printed, but its acknowledgement could not be confirmed/);
        assert.equal(server.calls("ack").length, 3, "an ack is idempotent, so it is retried");
        assert.match(ws.log(), /wait: printed PLAN for task t1 but could not ack m1/);
      }
    );
  });

  test("with no active task it still drains a queued final reply, and stuck acks are flagged there too", async () => {
    const done = { message_id: "m9", task_id: "t1", iteration: 2, kind: "DONE", dir: "to_local", body: "All done." };
    await withWorker(
      opsHandler({ active_task: { task: null }, poll: { messages: [done] }, ack: { ...ACK_OK, task: task({ protocolState: "DONE", waitingFor: "none" }) } }),
      async ({ ws }) => {
        const res = await ws.run(["wait"]);
        assert.equal(res.code, 0, res.stderr);
        assert.match(res.stdout, /All done\./);
      }
    );
    await withWorker(
      opsHandler({ active_task: { task: null }, poll: { messages: [PLAN] }, ack: ACK_STUCK }),
      async ({ ws }) => {
        assert.equal((await ws.run(["wait"])).code, 3);
      }
    );
  });

  test("with no active task and nothing queued it exits 1", async () => {
    await withWorker(opsHandler({ active_task: { task: null }, poll: { messages: [] } }), async ({ ws }) => {
      const res = await ws.run(["wait"]);
      assert.equal(res.code, 1);
      assert.match(res.stderr, /No active task/);
    });
  });
});

describe("wait: timing out and failing", () => {
  test("no reply before the deadline exits 2", async () => {
    await withWorker(
      // A real Worker holds a poll open; answering instantly would make the CLI
      // spin, so hold it a little here too.
      opsHandler({ active_task: { task: task() }, poll: () => ({ body: { messages: [] }, delayMs: 150 }) }),
      async ({ ws }) => {
        const res = await ws.run(["wait", "--timeout", "1"]);
        assert.equal(res.code, 2);
        assert.match(res.stdout, /No message yet/);
      }
    );
  });

  test("a structured error from poll fails fast instead of spinning until the deadline", async () => {
    // Before, an error body (no `messages`) read as "nothing yet" and the loop
    // re-polled at full speed for the whole timeout — e.g. after a token rotation.
    await withWorker(
      opsHandler({ active_task: { task: task() }, poll: () => ({ status: 404, body: { error: "HTTP_404" } }) }),
      async ({ server, ws }) => {
        const res = await ws.run(["wait", "--timeout", "30"], { timeoutMs: 10_000 });
        assert.equal(res.code, 1);
        assert.match(res.stderr, /rejected the poll: HTTP_404/);
        assert.doesNotMatch(res.stderr, /\n\s+at /, "an expected failure must not print a stack trace");
        assert.ok(server.calls("poll").length <= 2, `expected at most 2 polls, saw ${server.calls("poll").length}`);
      }
    );
  });

  test("a healthy long-poll that answers just past the deadline is exit 2, never misread as an outage", async () => {
    // The Worker holds a poll for the whole chunk and answers empty a moment
    // after the requested deadline. The client must not abort it at its own
    // finish line — that would look like an unreachable Worker (exit 4).
    await withWorker(
      opsHandler({ active_task: { task: task() }, poll: () => ({ body: { messages: [] }, delayMs: 1_100 }) }),
      async ({ ws }) => {
        const res = await ws.run(["wait", "--timeout", "1"], { timeoutMs: 20_000 });
        assert.equal(res.code, 2, res.stderr);
        assert.match(res.stdout, /No message yet/);
        assert.doesNotMatch(res.stderr, /unreachable/i);
      }
    );
  });

  test("a Worker that stays unreachable mid-wait ends with exit 4, not a stack trace", async () => {
    await withWorker(
      opsHandler({ active_task: { task: task() }, poll: () => ({ destroy: true }) }),
      async ({ ws }) => {
        const res = await ws.run(["wait", "--timeout", "1"]);
        assert.equal(res.code, 4, res.stderr);
        assert.match(res.stderr, /Worker unreachable/);
        assert.match(res.stderr, /stayed unreachable until the wait timed out/);
        assert.doesNotMatch(res.stderr, /\n\s+at /);
        assert.match(ws.log(), /wait: worker unreachable, still waiting/);
      }
    );
  });

  test("a connectivity blip mid-wait is survived: the wait keeps going and delivers the reply", async () => {
    let polls = 0;
    await withWorker(
      opsHandler({
        active_task: { task: task() },
        // The first poll fails on all three of localCall's attempts, then the
        // network "comes back".
        poll: () => (++polls <= 3 ? { destroy: true } : { body: { messages: [PLAN] } }),
        ack: ACK_OK,
      }),
      async ({ ws }) => {
        const res = await ws.run(["wait", "--timeout", "10"]);
        assert.equal(res.code, 0, res.stderr);
        assert.match(res.stdout, /Step 1: edit a\.js/);
        assert.match(res.stderr, /will keep trying until the wait times out/);
      }
    );
  });

  test("--timeout is a real deadline even when the Worker accepts a request and never answers", async () => {
    // Before, each poll attempt could run for its own timeout (chunk + 10s) and
    // be retried 3 times, so "--timeout 1" took over half a minute to fail.
    await withWorker(
      opsHandler({ active_task: { task: task() }, poll: () => ({ hang: true }) }),
      async ({ ws }) => {
        const startedAt = Date.now();
        const res = await ws.run(["wait", "--timeout", "1"], { timeoutMs: 20_000 });
        const elapsedMs = Date.now() - startedAt;

        assert.equal(res.code, 4, res.stderr);
        assert.ok(elapsedMs < 6_000, `expected to give up near the 1s deadline, took ${elapsedMs}ms`);
      }
    );
  });

  test("the deadline also bounds the initial task lookup, before the wait loop even starts", async () => {
    await withWorker(opsHandler({ active_task: () => ({ hang: true }) }), async ({ ws }) => {
      const startedAt = Date.now();
      const res = await ws.run(["wait", "--timeout", "1"], { timeoutMs: 20_000 });
      const elapsedMs = Date.now() - startedAt;

      assert.equal(res.code, 4, res.stderr);
      assert.ok(elapsedMs < 6_000, `expected to give up near the 1s deadline, took ${elapsedMs}ms`);
    });
  });

  test("a Worker that is down before the wait starts exits 4 with a plain message", async () => {
    const server = await startFakeWorker(() => ({}));
    const ws = makeWorkspace(server);
    await server.close();
    try {
      const res = await ws.run(["wait", "--timeout", "1"]);
      assert.equal(res.code, 4);
      assert.match(res.stderr, /Could not reach the Worker/);
      assert.match(res.stderr, /gpt-worker status/);
      assert.doesNotMatch(res.stderr, /\n\s+at /);
    } finally {
      ws.cleanup();
    }
  });
});

describe("discard-task", () => {
  test("exits 1 when there is no active task", async () => {
    await withWorker(opsHandler({ active_task: { task: null } }), async ({ server, ws }) => {
      const res = await ws.run(["discard-task", "--yes"]);
      assert.equal(res.code, 1);
      assert.match(res.stderr, /No active task to discard/);
      assert.equal(server.calls("discard_task").length, 0);
    });
  });

  test("without --yes it describes the task and changes nothing", async () => {
    await withWorker(opsHandler({ active_task: { task: task() } }), async ({ server, ws }) => {
      const res = await ws.run(["discard-task"]);
      assert.equal(res.code, 1);
      assert.match(res.stderr, /task id\s+: t1/);
      assert.match(res.stderr, /WAITING_PLAN/);
      assert.match(res.stderr, /goal\s+: Fix the bug/);
      assert.match(res.stderr, /discard-task -w .* --yes/);
      assert.equal(server.calls("discard_task").length, 0);
    });
  });

  test("with --yes it discards the active task", async () => {
    await withWorker(opsHandler({ active_task: { task: task() }, discard_task: { ok: true } }), async ({ server, ws }) => {
      const res = await ws.run(["discard-task", "--yes"]);
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stdout, /Task t1 discarded/);
      assert.deepEqual(server.calls("discard_task")[0].body, { op: "discard_task", task_id: "t1" });
      assert.match(ws.log(), /discard-task: t1/);
    });
  });

  test("--task only confirms the target: a different id is refused, the active id is accepted", async () => {
    await withWorker(opsHandler({ active_task: { task: task() }, discard_task: { ok: true } }), async ({ server, ws }) => {
      const wrong = await ws.run(["discard-task", "--task", "some-other-task", "--yes"]);
      assert.equal(wrong.code, 1);
      assert.match(wrong.stderr, /not the active task/);
      assert.equal(server.calls("discard_task").length, 0);

      const right = await ws.run(["discard-task", "--task", "t1", "--yes"]);
      assert.equal(right.code, 0, right.stderr);
      assert.equal(server.calls("discard_task").length, 1);
    });
  });

  test("a Worker-side error is reported and exits 1", async () => {
    await withWorker(opsHandler({ active_task: { task: task() }, discard_task: { error: "INVALID_ARGS" } }), async ({ ws }) => {
      const res = await ws.run(["discard-task", "--yes"]);
      assert.equal(res.code, 1);
      assert.match(res.stderr, /Failed to discard task: INVALID_ARGS/);
    });
  });
});

describe("report / handoff", () => {
  const executing = task({ protocolState: "EXECUTING", waitingFor: "none", iteration: 1 });

  test("reports the round when the task is EXECUTING", async () => {
    await withWorker(opsHandler({ active_task: { task: executing }, report_task: { task: executing } }), async ({ server, ws }) => {
      const res = await ws.run(["report", "--changed", "a.js", "--tests", "npm test"]);
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stdout, /Reported iteration 2\./);
      const sent = server.calls("report_task")[0].body;
      assert.equal(sent.task_id, "t1");
      assert.equal(sent.changed, "a.js");
      assert.equal(sent.tests, "npm test");
    });
  });

  test("refuses while the task awaits a local decision, pointing at continue/complete", async () => {
    const decision = task({ protocolState: "WAITING_LOCAL", waitingFor: "LOCAL_DECISION" });
    await withWorker(opsHandler({ active_task: { task: decision } }), async ({ server, ws }) => {
      const res = await ws.run(["report"]);
      assert.equal(res.code, 1);
      assert.match(res.stderr, /waiting for your decision/);
      assert.match(res.stderr, /gpt-worker continue/);
      assert.equal(server.calls("report_task").length, 0);
    });
  });

  test("refuses while a reply is still undelivered, pointing at wait", async () => {
    const pending = task({ protocolState: "WAITING_LOCAL", waitingFor: "LOCAL_PLAN_ACK" });
    await withWorker(opsHandler({ active_task: { task: pending } }), async ({ server, ws }) => {
      const res = await ws.run(["report"]);
      assert.equal(res.code, 1);
      assert.match(res.stderr, /Run 'gpt-worker wait' first/);
      assert.equal(server.calls("report_task").length, 0);
    });
  });

  test("warns but still reports when the state is not EXECUTING", async () => {
    // "Proceeding anyway" is existing behavior; the Worker is the real gate.
    await withWorker(opsHandler({ active_task: { task: task() }, report_task: { task: executing } }), async ({ server, ws }) => {
      const res = await ws.run(["report"]);
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stderr, /current state is WAITING_PLAN, not EXECUTING\. Proceeding anyway/);
      assert.equal(server.calls("report_task").length, 1);
    });
  });

  test("BODY_TOO_LARGE points at `gpt-worker limits`", async () => {
    await withWorker(opsHandler({ active_task: { task: executing }, report_task: { error: "BODY_TOO_LARGE" } }), async ({ ws }) => {
      const res = await ws.run(["report"]);
      assert.equal(res.code, 1);
      assert.match(res.stderr, /gpt-worker limits <bytes>/);
    });
  });

  test("handoff reports that there is nothing to hand off when the state moved on", async () => {
    await withWorker(
      opsHandler({ active_task: { task: executing }, report_task: { error: "INVALID_STATE", state: "WAITING_REVIEW" } }),
      async ({ ws }) => {
        const res = await ws.run(["handoff", "--reason", "rate limited"]);
        assert.equal(res.code, 1);
        assert.match(res.stderr, /Nothing to hand off: this task is WAITING_REVIEW, not EXECUTING/);
      }
    );
  });

  test("a non-string --title is rejected before any network call", async () => {
    await withWorker(opsHandler({}), async ({ server, ws }) => {
      const res = await ws.run(["report", "--title", "--force"]);
      assert.equal(res.code, 1);
      assert.match(res.stderr, /--title requires a string value/);
      assert.equal(server.requests.length, 0);
    });
  });

  test("a title the Worker rejects gets an explanatory message", async () => {
    await withWorker(opsHandler({ active_task: { task: executing }, report_task: { error: "INVALID_TITLE" } }), async ({ ws }) => {
      const res = await ws.run(["report", "--title", "ok"]);
      assert.equal(res.code, 1);
      assert.match(res.stderr, /Invalid title: must normalize to a non-empty single line/);
    });
  });

  test("a Worker that goes away mid-report says so and flags that the report may have landed", async () => {
    await withWorker(opsHandler({ active_task: { task: executing }, report_task: () => ({ status: 500 }) }), async ({ server, ws }) => {
      const res = await ws.run(["report"]);
      assert.equal(res.code, 4, res.stderr);
      assert.match(res.stderr, /may still have been applied/);
      assert.match(res.stderr, /gpt-worker state/);
      assert.equal(server.calls("report_task").length, 1, "a mutating call must not be retried");
    });
  });
});

describe("findStuckAck", () => {
  const open = (waitingFor, protocolState = "WAITING_LOCAL") => ({ taskId: "t1", protocolState, waitingFor });
  const ack = (over) => ({ ok: true, acked: true, transitioned: false, reason: "STATE_MISMATCH", task: open("LOCAL_PLAN_ACK"), ...over });

  test("flags a freshly acked message that left the task waiting for an ack", () => {
    assert.deepEqual(findStuckAck(ack({})), { reason: "STATE_MISMATCH", task: open("LOCAL_PLAN_ACK") });
  });

  test("flags an already_acked retry only while the task is still waiting for a local ack", () => {
    for (const waitingFor of ["LOCAL_PLAN_ACK", "LOCAL_DONE_ACK", "LOCAL_BLOCKED_ACK"]) {
      assert.notEqual(findStuckAck(ack({ already_acked: true, task: open(waitingFor) })), null, waitingFor);
    }
    for (const waitingFor of ["none", "USER", "LOCAL_DECISION", "GPT_REVIEW"]) {
      assert.equal(findStuckAck(ack({ already_acked: true, task: open(waitingFor, waitingFor === "none" ? "EXECUTING" : "WAITING_LOCAL") })), null, waitingFor);
    }
  });

  test("never flags a transition that applied, a terminal task, a missing task, or an older Worker", () => {
    assert.equal(findStuckAck(ack({ transitioned: true })), null);
    assert.equal(findStuckAck(ack({ transitioned: undefined })), null);
    assert.equal(findStuckAck(ack({ task: open("none", "DONE") })), null);
    assert.equal(findStuckAck(ack({ task: open("USER", "BLOCKED") })), null);
    assert.equal(findStuckAck(ack({ task: null })), null);
    assert.equal(findStuckAck({ ok: true }), null);
    assert.equal(findStuckAck({ ok: true, acked: false, reason: "NOT_FOUND", task: null }), null);
    assert.equal(findStuckAck(null), null);
  });

  test("reports UNKNOWN when the Worker gave no reason", () => {
    assert.equal(findStuckAck(ack({ reason: undefined })).reason, "UNKNOWN");
  });
});
