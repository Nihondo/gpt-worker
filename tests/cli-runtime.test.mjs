// The CLI's transport to the Worker (localCall / adminCall) and the legacy-state
// migration every task command runs first. The Worker is a real HTTP server on
// an ephemeral port (tests/helpers/fake-worker.mjs), so these exercise the real
// fetch, timeout and retry behavior rather than a stub of it.
//
// What matters here is *which* failures get retried. A call that provably never
// reached the server can be repeated freely; a mutating call whose reply merely
// went missing cannot, because it may already have taken effect.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeWorker } from "./helpers/fake-worker.mjs";

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-runtime-config-"));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-runtime-state-"));
process.env.GPT_WORKER_CONFIG_DIR = configDir;
process.env.GPT_WORKER_STATE_ROOT = stateDir;
const { WorkerCallError, WorkerUnreachableError, adminCall, localCall, migrateLegacyStateIfNeeded, parseRetryAfterMs, remoteActiveTask } =
  await import("../bridge/cli-runtime.mjs?cli-runtime-test");
const { workspaceStateDir, readState } = await import("../bridge/state.mjs?cli-runtime-test");

after(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
});

// Retries are real, so keep them fast: 1ms base delay instead of 300ms.
const FAST = { retry: { attempts: 3, baseMs: 1 } };

function cfgFor(server) {
  return { workerUrl: server.url, workspaceId: "0123456789abcdef", cliToken: "cli-token" };
}

/** A URL whose port has just been released, so connecting to it is refused. */
async function closedPortUrl() {
  const server = await startFakeWorker(() => ({}));
  const { url } = server;
  await server.close();
  return url;
}

describe("localCall", () => {
  test("returns the parsed body of a successful call", async () => {
    const server = await startFakeWorker(() => ({ body: { task: { taskId: "t1" } } }));
    try {
      assert.deepEqual(await localCall(cfgFor(server), "active_task", {}, FAST), { task: { taskId: "t1" } });
      assert.equal(server.requests[0].path, "/local/0123456789abcdef/cli-token");
      assert.deepEqual(server.requests[0].body, { op: "active_task" });
    } finally {
      await server.close();
    }
  });

  test("a read op is retried through 5xx responses until one succeeds", async () => {
    let n = 0;
    const server = await startFakeWorker(() => (++n < 3 ? { status: 500 } : { body: { messages: [] } }));
    const lines = [];
    try {
      const result = await localCall(cfgFor(server), "poll", { timeout_ms: 0 }, { ...FAST, log: (line) => lines.push(line) });
      assert.deepEqual(result, { messages: [] });
      assert.equal(server.requests.length, 3);
      assert.match(lines[0], /^poll attempt 1\/3 failed: HTTP 500$/);
      assert.match(lines[1], /^poll attempt 2\/3 failed: HTTP 500$/);
    } finally {
      await server.close();
    }
  });

  test("a read op that keeps failing gives up after the last attempt", async () => {
    const server = await startFakeWorker(() => ({ status: 503 }));
    try {
      await assert.rejects(
        () => localCall(cfgFor(server), "active_task", {}, FAST),
        (err) => {
          assert.ok(err instanceof WorkerUnreachableError);
          assert.equal(err.op, "active_task");
          assert.equal(err.attempts, 3);
          assert.equal(err.status, 503);
          // A read has nothing to have applied.
          assert.equal(err.maybeApplied, false);
          return true;
        }
      );
      assert.equal(server.requests.length, 3);
    } finally {
      await server.close();
    }
  });

  test("a mutating op is NOT retried on a 5xx, and is reported as possibly applied", async () => {
    // report_task may have run before the 500: repeating it would fail with
    // INVALID_STATE at best and double-apply at worst.
    const server = await startFakeWorker(() => ({ status: 500 }));
    try {
      await assert.rejects(
        () => localCall(cfgFor(server), "report_task", { task_id: "t1" }, FAST),
        (err) => {
          assert.ok(err instanceof WorkerUnreachableError);
          assert.equal(err.attempts, 1);
          assert.equal(err.maybeApplied, true);
          assert.match(err.message, /may still have been applied/);
          assert.match(err.message, /gpt-worker state/);
          return true;
        }
      );
      assert.equal(server.requests.length, 1);
    } finally {
      await server.close();
    }
  });

  test("a 429 is retried even for a mutating op, honoring retry-after", async () => {
    // The Worker rate-limits before it parses or dispatches, so a 429 proves the
    // op did not run.
    let n = 0;
    const server = await startFakeWorker(() => (++n === 1 ? { status: 429, headers: { "retry-after": "0" } } : { body: { ok: true } }));
    try {
      assert.deepEqual(await localCall(cfgFor(server), "report_task", { task_id: "t1" }, FAST), { ok: true });
      assert.equal(server.requests.length, 2);
    } finally {
      await server.close();
    }
  });

  test("a long retry wait is announced to the user; a short one is not", async () => {
    // A 429 asks for a pause of up to 30s. Silence for that long looks like a
    // hang, so the user is told what is happening — but ordinary sub-second
    // retries stay quiet.
    const notes = [];
    let n = 0;
    const throttled = await startFakeWorker(() => (++n === 1 ? { status: 429, headers: { "retry-after": "2" } } : { body: { ok: true } }));
    try {
      await localCall(cfgFor(throttled), "active_task", {}, { ...FAST, notify: (line) => notes.push(line) });
      assert.equal(notes.length, 1);
      assert.match(notes[0], /^Worker is busy \(HTTP 429\); retrying in 2s \(attempt 2\/3\)\.\.\.$/);
    } finally {
      await throttled.close();
    }

    const quiet = [];
    let m = 0;
    const brief = await startFakeWorker(() => (++m === 1 ? { status: 500 } : { body: { ok: true } }));
    try {
      await localCall(cfgFor(brief), "active_task", {}, { ...FAST, notify: (line) => quiet.push(line) });
      assert.deepEqual(quiet, []);
    } finally {
      await brief.close();
    }
  });

  test("a refused connection is retried for any op, since nothing can have been sent", async () => {
    const url = await closedPortUrl();
    for (const op of ["active_task", "report_task"]) {
      await assert.rejects(
        () => localCall({ workerUrl: url, workspaceId: "0123456789abcdef", cliToken: "t" }, op, {}, FAST),
        (err) => {
          assert.ok(err instanceof WorkerUnreachableError, op);
          assert.equal(err.attempts, 3, `${op} should use every attempt`);
          // Connection refused means the request never left, so even a mutating
          // op is known not to have been applied.
          assert.equal(err.maybeApplied, false, op);
          assert.doesNotMatch(err.message, /may still have been applied/);
          return true;
        }
      );
    }
  });

  test("a hung server times out; a read op retries but a mutating op does not", async () => {
    const server = await startFakeWorker(() => ({ hang: true }));
    try {
      await assert.rejects(
        () => localCall(cfgFor(server), "report_task", {}, { ...FAST, timeoutMs: 60 }),
        (err) => {
          assert.equal(err.attempts, 1);
          assert.equal(err.maybeApplied, true);
          assert.match(err.message, /timed out/);
          return true;
        }
      );
      const before = server.requests.length;
      assert.equal(before, 1);

      await assert.rejects(
        () => localCall(cfgFor(server), "active_task", {}, { retry: { attempts: 2, baseMs: 1 }, timeoutMs: 60 }),
        (err) => err.attempts === 2 && err.maybeApplied === false
      );
      assert.equal(server.requests.length - before, 2);
    } finally {
      await server.close();
    }
  });

  test("a deadline clamps each attempt and stops further retries, instead of stacking timeouts", async () => {
    const server = await startFakeWorker(() => ({ hang: true }));
    try {
      const startedAt = Date.now();
      await assert.rejects(
        // Without the deadline: 3 attempts x 30s each. With it: one attempt cut
        // at deadline + grace, and no retry begins after the deadline.
        () => localCall(cfgFor(server), "active_task", {}, { ...FAST, timeoutMs: 30_000, deadlineMs: Date.now() + 100 }),
        (err) => err instanceof WorkerUnreachableError && err.attempts === 1
      );
      const elapsedMs = Date.now() - startedAt;
      assert.ok(elapsedMs < 5_000, `expected ~2.1s (deadline + 2s grace), took ${elapsedMs}ms`);
      assert.equal(server.requests.length, 1);
    } finally {
      await server.close();
    }
  });

  test("a retry pause that ends at the deadline does not start another attempt", async () => {
    // A quick failure just before the deadline: the backoff is clamped to the
    // time left, sleeps until the deadline, and — the bug — then began attempt 2
    // after the deadline. The base delay is huge so the clamp is what decides.
    const server = await startFakeWorker(() => ({ status: 500 }));
    try {
      const startedAt = Date.now();
      await assert.rejects(
        // The deadline is far enough away (600ms) that the first, instant failure
        // happens well before it even on a loaded machine. Were it tight enough for
        // that failure to overshoot, the *pre*-sleep check would end the call and
        // this test could not tell whether the *post*-sleep check still works.
        () => localCall(cfgFor(server), "active_task", {}, { retry: { attempts: 3, baseMs: 10_000 }, deadlineMs: Date.now() + 600 }),
        (err) => err instanceof WorkerUnreachableError && err.attempts === 1 && err.status === 500
      );
      assert.equal(server.requests.length, 1, "no second request may begin once the deadline has passed");
      assert.ok(Date.now() - startedAt < 3_000, "the pause was clamped to the deadline, not the 10s backoff");
    } finally {
      await server.close();
    }
  });

  test("a structured error in a normal response is returned, never retried", async () => {
    const server = await startFakeWorker(() => ({ body: { error: "INVALID_STATE", state: "WAITING_REVIEW" } }));
    try {
      assert.deepEqual(await localCall(cfgFor(server), "report_task", {}, FAST), { error: "INVALID_STATE", state: "WAITING_REVIEW" });
      assert.equal(server.requests.length, 1);
    } finally {
      await server.close();
    }
  });

  test("a 4xx is returned as an error body, not retried", async () => {
    const server = await startFakeWorker(() => ({ status: 404, body: {} }));
    try {
      assert.deepEqual(await localCall(cfgFor(server), "active_task", {}, FAST), { error: "HTTP_404" });
      assert.equal(server.requests.length, 1);
    } finally {
      await server.close();
    }
  });

  test("a failure is logged against the workspace when the config carries its root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gw-runtime-ws-"));
    try {
      const url = await closedPortUrl();
      await assert.rejects(() =>
        localCall({ workerUrl: url, workspaceId: "0123456789abcdef", cliToken: "t", workspaceRoot: root }, "status", {}, FAST)
      );
      const log = fs.readFileSync(path.join(workspaceStateDir(root), "bridge.log"), "utf8");
      assert.match(log, /cli: status attempt 1\/3 failed: ECONNREFUSED/);
      assert.match(log, /cli: status attempt 3\/3 failed: ECONNREFUSED \(giving up\)/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("adminCall", () => {
  test("retries a *_get read but not a mutating admin op", async () => {
    let n = 0;
    const reads = await startFakeWorker(() => (++n < 2 ? { status: 500 } : { body: { token: "x" } }));
    try {
      const worker = { workerUrl: reads.url, adminToken: "admin-token" };
      assert.deepEqual(await adminCall(worker, "hub_owner_token_get", {}, FAST), { token: "x" });
      assert.equal(reads.requests.length, 2);
      assert.equal(reads.requests[0].path, "/admin/admin-token");
    } finally {
      await reads.close();
    }

    const writes = await startFakeWorker(() => ({ status: 500 }));
    try {
      await assert.rejects(
        () => adminCall({ workerUrl: writes.url, adminToken: "a" }, "provision", { workspace_id: "w" }, FAST),
        (err) => err instanceof WorkerUnreachableError && err.attempts === 1 && err.maybeApplied === true
      );
      assert.equal(writes.requests.length, 1);
    } finally {
      await writes.close();
    }
  });
});

describe("adminCall: a 429 is not proof that nothing ran", () => {
  // /local rate-limits before it dispatches, so a 429 there is safe to retry.
  // /admin forwards to a Durable Object with no such gate: a rotate that ran and
  // then returned 429 must not be sent a second time.
  test("a mutating admin op is not retried on a 429, and is reported as possibly applied", async () => {
    const server = await startFakeWorker(() => ({ status: 429, headers: { "retry-after": "0" } }));
    try {
      await assert.rejects(
        () => adminCall({ workerUrl: server.url, adminToken: "a" }, "rotate", { workspace_id: "w", kind: "cli" }, FAST),
        (err) => {
          assert.ok(err instanceof WorkerUnreachableError);
          assert.equal(err.attempts, 1);
          assert.equal(err.status, 429);
          assert.equal(err.maybeApplied, true);
          assert.match(err.message, /may still have been applied/);
          return true;
        }
      );
      assert.equal(server.requests.length, 1);
    } finally {
      await server.close();
    }
  });

  test("a read-only admin op is still retried on a 429", async () => {
    let n = 0;
    const server = await startFakeWorker(() => (++n === 1 ? { status: 429, headers: { "retry-after": "0" } } : { body: { token: "x" } }));
    try {
      assert.deepEqual(await adminCall({ workerUrl: server.url, adminToken: "a" }, "owner_token_get", {}, FAST), { token: "x" });
      assert.equal(server.requests.length, 2);
    } finally {
      await server.close();
    }
  });

  test("the /local behavior is unchanged: a 429 is retried even for a mutating op", async () => {
    let n = 0;
    const server = await startFakeWorker(() => (++n === 1 ? { status: 429, headers: { "retry-after": "0" } } : { body: { ok: true } }));
    try {
      assert.deepEqual(await localCall(cfgFor(server), "discard_task", { task_id: "t" }, FAST), { ok: true });
      assert.equal(server.requests.length, 2);
    } finally {
      await server.close();
    }
  });
});

describe("remoteActiveTask", () => {
  test("returns the task, or null when there is none", async () => {
    let reply = { task: { taskId: "t1" } };
    const server = await startFakeWorker(() => ({ body: reply }));
    try {
      assert.deepEqual(await remoteActiveTask(cfgFor(server)), { taskId: "t1" });
      reply = { task: null };
      assert.equal(await remoteActiveTask(cfgFor(server)), null);
    } finally {
      await server.close();
    }
  });

  test("a structured error becomes a WorkerCallError carrying its code", async () => {
    const server = await startFakeWorker(() => ({ body: { error: "UNAUTHORIZED" } }));
    try {
      await assert.rejects(
        () => remoteActiveTask(cfgFor(server)),
        (err) => err instanceof WorkerCallError && err.code === "UNAUTHORIZED" && err.message === "UNAUTHORIZED"
      );
    } finally {
      await server.close();
    }
  });
});

describe("parseRetryAfterMs", () => {
  test("converts seconds, clamps large values, and rejects junk", () => {
    assert.equal(parseRetryAfterMs("0"), 0);
    assert.equal(parseRetryAfterMs("2"), 2000);
    assert.equal(parseRetryAfterMs("999999"), 30_000);
    for (const bad of [undefined, null, "", "soon", "-1", "Wed, 21 Oct 2026 07:28:00 GMT"]) {
      assert.equal(parseRetryAfterMs(bad), null, String(bad));
    }
  });
});

describe("migrateLegacyStateIfNeeded", () => {
  function makeWorkspace() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gw-runtime-migrate-")));
    const dir = workspaceStateDir(root);
    fs.mkdirSync(dir, { recursive: true });
    return {
      root,
      writeLegacy: (state) => fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state)),
      writeGuidance: (text) => fs.writeFileSync(path.join(dir, "guidance.md"), text),
      hasFile: (name) => fs.existsSync(path.join(dir, name)),
    };
  }

  test("with no legacy files it makes no call at all", async () => {
    const ws = makeWorkspace();
    const server = await startFakeWorker(() => ({}));
    try {
      await migrateLegacyStateIfNeeded(ws.root, cfgFor(server));
      assert.equal(server.requests.length, 0);
    } finally {
      await server.close();
      fs.rmSync(ws.root, { recursive: true, force: true });
    }
  });

  test("moves legacy chat settings to the Worker and removes state.json", async () => {
    const ws = makeWorkspace();
    ws.writeLegacy({ chatUrl: "https://chatgpt.com/g/g-p-x/project", enterDelayMs: 900 });
    const server = await startFakeWorker(() => ({ body: { ok: true } }));
    try {
      await migrateLegacyStateIfNeeded(ws.root, cfgFor(server));
      assert.deepEqual(server.calls("settings_set")[0].body, {
        op: "settings_set",
        chatUrl: "https://chatgpt.com/g/g-p-x/project",
        enterDelayMs: 900,
      });
      assert.equal(server.calls("migrate_legacy_state").length, 0);
      assert.equal(ws.hasFile("state.json"), false);
    } finally {
      await server.close();
      fs.rmSync(ws.root, { recursive: true, force: true });
    }
  });

  test("imports a legacy task only while it is in a live protocol state", async () => {
    for (const [protocolState, expected] of [["EXECUTING", 1], ["WAITING_PLAN", 1], ["WAITING_REVIEW", 1], ["WAITING_LOCAL", 0], ["DONE", 0]]) {
      const ws = makeWorkspace();
      ws.writeLegacy({ taskId: "legacy-1", goal: "g", iteration: 1, protocolState });
      const server = await startFakeWorker(() => ({ body: { migrated: true } }));
      try {
        await migrateLegacyStateIfNeeded(ws.root, cfgFor(server));
        assert.equal(server.calls("migrate_legacy_state").length, expected, protocolState);
        assert.equal(ws.hasFile("state.json"), false, `${protocolState}: state.json is consumed either way`);
      } finally {
        await server.close();
        fs.rmSync(ws.root, { recursive: true, force: true });
      }
    }
  });

  test("moves legacy guidance to the Worker, then deletes the local copy", async () => {
    const ws = makeWorkspace();
    ws.writeGuidance("Prefer small diffs.");
    const server = await startFakeWorker(() => ({ body: { ok: true } }));
    try {
      await migrateLegacyStateIfNeeded(ws.root, cfgFor(server));
      assert.deepEqual(server.calls("guidance_set")[0].body, { op: "guidance_set", text: "Prefer small diffs." });
      assert.equal(ws.hasFile("guidance.md"), false);
    } finally {
      await server.close();
      fs.rmSync(ws.root, { recursive: true, force: true });
    }
  });

  test("a failed settings_set throws and keeps state.json, so nothing is lost by a partial migration", async () => {
    const ws = makeWorkspace();
    ws.writeLegacy({ chatUrl: "https://chatgpt.com/g/g-p-x/project" });
    const server = await startFakeWorker(() => ({ body: { error: "BAD_SETTINGS" } }));
    try {
      await assert.rejects(() => migrateLegacyStateIfNeeded(ws.root, cfgFor(server)), /BAD_SETTINGS/);
      assert.equal(ws.hasFile("state.json"), true);
      assert.equal(readState(ws.root).chatUrl, "https://chatgpt.com/g/g-p-x/project");
    } finally {
      await server.close();
      fs.rmSync(ws.root, { recursive: true, force: true });
    }
  });
});
