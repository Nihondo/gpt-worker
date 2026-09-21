// Status and logs are operator diagnostics, so test them through the real CLI
// process and HTTP transport. This makes their output contract explicit while
// keeping the fake Worker limited to the same /local surface as production.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli, startFakeWorker } from "./helpers/fake-worker.mjs";

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-daemon-config-"));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-daemon-state-"));
process.env.GPT_WORKER_CONFIG_DIR = configDir;
process.env.GPT_WORKER_STATE_ROOT = stateDir;
const { allowReadPath, denyReadPath, appendLog, writeTokensAtomic, workspaceStateDir } = await import("../bridge/state.mjs?cli-daemon-test");

const ENV = { GPT_WORKER_CONFIG_DIR: configDir, GPT_WORKER_STATE_ROOT: stateDir, GPT_WORKER_RETRY_BASE_MS: "1" };
const WORKSPACE_ID = "0123456789abcdef";

after(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function makeWorkspace(server) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gw-daemon-ws-")));
  fs.writeFileSync(path.join(configDir, "worker.json"), JSON.stringify({ workerUrl: server?.url || "http://127.0.0.1:1", adminToken: "admin" }));
  writeTokensAtomic(root, { workspaceId: WORKSPACE_ID, cliToken: "cli", linkToken: "link", workspacePath: root });
  return {
    root,
    run: (args) => runCli([...args, "-w", root], { env: ENV }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("status shows local diagnostics, task timing, read gate, and body limit", async () => {
  const now = Date.now();
  const server = await startFakeWorker((call) => {
    if (!call.path.startsWith("/local/")) return { body: {} };
    if (call.op === "status") return { body: { connected: true, pendingToGpt: 2, pendingToLocal: 1 } };
    if (call.op === "active_task") {
      return {
        body: {
          task: { taskId: "t1", iteration: 4, protocolState: "EXECUTING", waitingFor: "GPT_PLAN", taskStartedAt: now - 20_000, updatedAt: now - 1_000 },
          taskWindow: { state: "active", expiresAt: now + 60_000, idleMs: 3_600_000 },
        },
      };
    }
    if (call.op === "max_body_bytes_get") return { body: { maxBodyBytes: 16_384, floor: 1_024, ceiling: 2_097_152 } };
    return { body: {} };
  });
  const ws = makeWorkspace(server);
  try {
    const result = await ws.run(["status"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /read gate\s+: unknown \(bridge not running\)/);
    assert.match(result.stdout, /read allowed:\s+\(none\)/);
    assert.match(result.stdout, /read denied\s*:\s+\(none\)/);
    assert.ok(result.stdout.includes(`${workspaceStateDir(ws.root)}/bridge.log`));
    assert.match(result.stdout, /task\s+: t1/);
    assert.match(result.stdout, /waiting for\s+: GPT_PLAN/);
    assert.match(result.stdout, /read window\s+: active; expires/);
    assert.match(result.stdout, /body limit\s+: 16384 bytes/);
  } finally {
    await server.close();
    ws.cleanup();
  }
});

test("status shows the workspace_bundle hint when the Worker reports one, and only then", async () => {
  const now = Date.now();
  for (const withHint of [true, false]) {
    const server = await startFakeWorker((call) => {
      if (call.op === "status") return { body: { connected: true, pendingToGpt: 0, pendingToLocal: 0 } };
      if (call.op === "active_task") {
        return {
          body: {
            task: { taskId: "t1", iteration: 0, protocolState: "WAITING_PLAN", waitingFor: "GPT_PLAN", taskStartedAt: now - 20_000, updatedAt: now - 10_000 },
            taskWindow: { state: "active", expiresAt: now + 60_000, idleMs: 3_600_000 },
            bundleHint: withHint ? { code: "BUNDLE_RETURNED", at: now - 180_000, ageMs: 180_000 } : null,
          },
        };
      }
      return { body: {} };
    });
    const ws = makeWorkspace(server);
    try {
      const result = await ws.run(["status"]);
      assert.equal(result.code, 0, result.stderr);
      if (withHint) {
        assert.match(result.stdout, /hint\s+: ChatGPT was handed a workspace_bundle archive 3 min ago and has not continued/);
      } else {
        assert.doesNotMatch(result.stdout, /workspace_bundle/);
      }
    } finally {
      await server.close();
      ws.cleanup();
    }
  }
});

test("status displays allowed read files and directories", async () => {
  const server = await startFakeWorker((call) => {
    if (call.op === "status") return { body: { connected: true, pendingToGpt: 0, pendingToLocal: 0 } };
    if (call.op === "active_task") return { body: { task: null } };
    return { body: {} };
  });
  const ws = makeWorkspace(server);
  try {
    allowReadPath(ws.root, "config/test.json");
    allowReadPath(ws.root, "fixtures/");
    const result = await ws.run(["status"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /read allowed:\s+2/);
    assert.match(result.stdout, /file\s+:\s+config\/test\.json/);
    assert.match(result.stdout, /directory\s+:\s+fixtures\//);
  } finally {
    await server.close();
    ws.cleanup();
  }
});

test("status displays denied read files and directories", async () => {
  const server = await startFakeWorker((call) => {
    if (call.op === "status") return { body: { connected: true, pendingToGpt: 0, pendingToLocal: 0 } };
    if (call.op === "active_task") return { body: { task: null } };
    return { body: {} };
  });
  const ws = makeWorkspace(server);
  try {
    denyReadPath(ws.root, "config/secret.json");
    denyReadPath(ws.root, "secret-docs/");
    const result = await ws.run(["status"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /read denied\s*:\s+2/);
    assert.match(result.stdout, /file\s+:\s+config\/secret\.json/);
    assert.match(result.stdout, /directory\s+:\s+secret-docs\//);
  } finally {
    await server.close();
    ws.cleanup();
  }
});

test("status reports read denied unavailable when denylist is corrupt", async () => {
  const server = await startFakeWorker((call) => {
    if (call.op === "status") return { body: { connected: true, pendingToGpt: 0, pendingToLocal: 0 } };
    if (call.op === "active_task") return { body: { task: null } };
    return { body: {} };
  });
  const ws = makeWorkspace(server);
  try {
    const denylistPath = path.join(workspaceStateDir(ws.root), "read-denylist.json");
    fs.mkdirSync(path.dirname(denylistPath), { recursive: true });
    fs.writeFileSync(denylistPath, "{ invalid json\n");
    const result = await ws.run(["status"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /read denied\s*:\s+unavailable \(corrupt state\)/);
  } finally {
    await server.close();
    ws.cleanup();
  }
});

test("status distinguishes an unreachable Worker from no active task", async () => {
  const server = await startFakeWorker(() => ({ body: {} }));
  const ws = makeWorkspace(server);
  await server.close();
  try {
    const result = await ws.run(["status"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /worker link\s+: UNREACHABLE/);
    assert.match(result.stdout, /task\s+: \(unknown — the Worker is the only source of task state\)/);
    assert.match(result.stdout, /chat\s+: unavailable \(Worker settings could not be verified\)/);
    assert.doesNotMatch(result.stdout, /task\s+: \(none\)/);
    assert.doesNotMatch(result.stdout, /chat\s+: unbound/);
  } finally {
    ws.cleanup();
  }
});

test("logs reads local entries without Worker connectivity and --path prints both generations", async () => {
  const ws = makeWorkspace(null);
  try {
    appendLog(ws.root, "first diagnostic");
    appendLog(ws.root, "second diagnostic");
    const logs = await ws.run(["logs", "-n", "1"]);
    assert.equal(logs.code, 0, logs.stderr);
    assert.match(logs.stdout, /second diagnostic/);
    assert.doesNotMatch(logs.stdout, /first diagnostic/);

    const paths = await ws.run(["logs", "--path"]);
    assert.equal(paths.code, 0, paths.stderr);
    assert.match(paths.stdout, /bridge\.log\n/);
    assert.match(paths.stdout, /bridge\.log\.1/);
  } finally {
    ws.cleanup();
  }
});

test("logs --all reads the saved state directory after a workspace path moved", async () => {
  const ws = makeWorkspace(null);
  try {
    appendLog(ws.root, "moved workspace diagnostic");
    const tokenPath = path.join(workspaceStateDir(ws.root), "tokens.json");
    const tokens = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
    fs.writeFileSync(tokenPath, JSON.stringify({ ...tokens, workspacePath: "/no/longer/here" }));
    const logs = await ws.run(["logs", "--all"]);
    assert.equal(logs.code, 0, logs.stderr);
    assert.match(logs.stdout, /moved workspace diagnostic/);
  } finally {
    ws.cleanup();
  }
});

test("help is available without local configuration", async () => {
  const general = await runCli(["help"], { env: ENV });
  assert.equal(general.code, 0, general.stderr);
  assert.match(general.stdout, /logs/);
  const command = await runCli(["task", "--help"], { env: ENV });
  assert.equal(command.code, 0, command.stderr);
  assert.match(command.stdout, /Usage: gpt-worker task/);
});
