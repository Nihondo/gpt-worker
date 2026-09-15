import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-worker-config-test-"));
process.env.GPT_WORKER_CONFIG_DIR = configDir;
const { readWorkerConfig, updateWorkerConfigAtomic, writeWorkerConfigAtomic } = await import("../bridge/state.mjs?worker-config-test");

after(() => fs.rmSync(configDir, { recursive: true, force: true }));

test("serialized config updates preserve mappings added from stale snapshots", () => {
  const workspaceA = "a1b2c3d4e5f60708";
  const workspaceB = "b1b2c3d4e5f60708";
  writeWorkerConfigAtomic({ chatUrl: "https://chatgpt.com/g/g-p-example/project", chromeTabsByWorkspace: {} });

  // Two CLIs may both have seen this old state before either writes.
  const staleA = readWorkerConfig();
  const staleB = readWorkerConfig();
  assert.deepEqual(staleA, staleB);

  updateWorkerConfigAtomic((current) => ({
    ...current,
    chromeTabsByWorkspace: { ...current.chromeTabsByWorkspace, [workspaceA]: "101" },
  }));
  updateWorkerConfigAtomic((current) => ({
    ...current,
    chromeTabsByWorkspace: { ...current.chromeTabsByWorkspace, [workspaceB]: "202" },
  }));

  assert.deepEqual(readWorkerConfig().chromeTabsByWorkspace, { [workspaceA]: "101", [workspaceB]: "202" });
});

test("a removal based on an old snapshot retains a later workspace mapping", () => {
  const workspaceA = "a1b2c3d4e5f60708";
  const workspaceB = "b1b2c3d4e5f60708";
  writeWorkerConfigAtomic({
    chatUrl: "https://chatgpt.com/g/g-p-example/project",
    chromeTabsByWorkspace: { [workspaceA]: "101" },
  });

  const staleRemoval = readWorkerConfig();
  updateWorkerConfigAtomic((current) => ({
    ...current,
    chromeTabsByWorkspace: { ...current.chromeTabsByWorkspace, [workspaceB]: "202" },
  }));
  updateWorkerConfigAtomic((current) => {
    const tabs = { ...current.chromeTabsByWorkspace };
    delete tabs[workspaceA];
    return { ...current, chromeTabsByWorkspace: tabs };
  });

  assert.equal(staleRemoval.chromeTabsByWorkspace[workspaceA], "101");
  assert.deepEqual(readWorkerConfig().chromeTabsByWorkspace, { [workspaceB]: "202" });
});
