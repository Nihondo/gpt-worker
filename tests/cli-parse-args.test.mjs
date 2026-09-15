// Regression test for a real bug found while dogfooding multi-workspace
// support: a bare boolean flag (e.g. --cli, --force) immediately followed by
// "-w <dir>" swallowed "-w" itself as the flag's value, silently dropping
// the workspace argument (it fell back to process.cwd() instead).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildChatOpenUrl,
  parseArgs,
  selectWaitMessages,
  withChatUrl,
  withWorkspaceChromeTab,
  withoutWorkspaceChromeTab,
  workspaceChromeTabId,
} from "../bridge/cli.mjs";

describe("parseArgs", () => {
  test("-w after a bare boolean flag is not swallowed as that flag's value", () => {
    const args = parseArgs(["--cli", "-w", "/tmp/gw-test-proj-b"]);
    assert.equal(args.cli, true);
    assert.equal(args.workspace, "/tmp/gw-test-proj-b");
  });

  test("same, with --force", () => {
    const args = parseArgs(["--force", "-w", "/tmp/x"]);
    assert.equal(args.force, true);
    assert.equal(args.workspace, "/tmp/x");
  });

  test("-w before a bare flag still works (the previously-tested order)", () => {
    const args = parseArgs(["-w", "/tmp/x", "--force"]);
    assert.equal(args.workspace, "/tmp/x");
    assert.equal(args.force, true);
  });

  test("a flag that legitimately takes a value still gets it", () => {
    const args = parseArgs(["--timeout", "60", "-w", "/tmp/x"]);
    assert.equal(args.timeout, "60");
    assert.equal(args.workspace, "/tmp/x");
  });

  test("--flag=value form is unaffected", () => {
    const args = parseArgs(["--changed=3", "-w", "/tmp/x"]);
    assert.equal(args.changed, "3");
    assert.equal(args.workspace, "/tmp/x");
  });

  test("positional args land in _", () => {
    const args = parseArgs(["some goal", "--force"]);
    assert.deepEqual(args._, ["some goal"]);
    assert.equal(args.force, true);
  });
});

describe("buildChatOpenUrl", () => {
  test("adds the default connector mention to a plain Project URL", () => {
    const url = buildChatOpenUrl("https://chatgpt.com/g/g-p-example/project", "task-123");
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("prompt"), "@gpt-worker continue task task-123");
  });

  test("preserves an explicitly configured connector mention", () => {
    const url = buildChatOpenUrl("https://chatgpt.com/g/g-p-example/project?prompt=@custom-worker", "task-123");
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("prompt"), "@custom-worker continue task task-123");
  });
});

describe("workspace Chrome tab mapping", () => {
  const workspaceA = "a1b2c3d4e5f60708";
  const workspaceB = "b1b2c3d4e5f60708";

  test("keeps a dedicated tab ID per workspace without changing shared settings", () => {
    const base = { workerUrl: "https://example.test", chatUrl: "https://chatgpt.com/g/g-p-example/project" };
    const withA = withWorkspaceChromeTab(base, workspaceA, "101");
    const withBoth = withWorkspaceChromeTab(withA, workspaceB, 202);

    assert.equal(workspaceChromeTabId(withBoth, workspaceA), "101");
    assert.equal(workspaceChromeTabId(withBoth, workspaceB), "202");
    assert.equal(withBoth.chatUrl, base.chatUrl);
    assert.deepEqual(base, { workerUrl: "https://example.test", chatUrl: "https://chatgpt.com/g/g-p-example/project" });
  });

  test("does not persist malformed IDs or rewrite an unchanged mapping", () => {
    const base = { chromeTabsByWorkspace: { [workspaceA]: "101" } };
    assert.equal(withWorkspaceChromeTab(base, workspaceA, "101"), base);
    assert.equal(withWorkspaceChromeTab(base, workspaceB, "not-a-tab"), base);
    assert.equal(workspaceChromeTabId({ chromeTabsByWorkspace: { [workspaceA]: "0" } }, workspaceA), null);
  });

  test("removes only the deregistered workspace's tab association", () => {
    const base = { chromeTabsByWorkspace: { [workspaceA]: "101", [workspaceB]: "202" } };
    const result = withoutWorkspaceChromeTab(base, workspaceA);
    assert.equal(workspaceChromeTabId(result, workspaceA), null);
    assert.equal(workspaceChromeTabId(result, workspaceB), "202");
    assert.deepEqual(base.chromeTabsByWorkspace, { [workspaceA]: "101", [workspaceB]: "202" });
  });

  test("drops the map entirely after its last workspace is removed", () => {
    const result = withoutWorkspaceChromeTab({ chromeTabsByWorkspace: { [workspaceA]: "101" } }, workspaceA);
    assert.equal(Object.hasOwn(result, "chromeTabsByWorkspace"), false);
  });

  test("clears all tab IDs when the shared Project URL changes", () => {
    const settings = {
      chatUrl: "https://chatgpt.com/g/g-p-old/project",
      chromeTabsByWorkspace: { [workspaceA]: "101", [workspaceB]: "202" },
    };
    const changed = withChatUrl(settings, "https://chatgpt.com/g/g-p-new/project");
    const unchanged = withChatUrl(settings, settings.chatUrl);

    assert.equal(Object.hasOwn(changed, "chromeTabsByWorkspace"), false);
    assert.deepEqual(unchanged.chromeTabsByWorkspace, settings.chromeTabsByWorkspace);
  });
});

describe("selectWaitMessages", () => {
  const done = { task_id: "done-task", kind: "DONE" };
  const plan = { task_id: "active-task", kind: "PLAN" };

  test("filters replies to the active task", () => {
    assert.deepEqual(selectWaitMessages([done, plan], "active-task"), [plan]);
  });

  test("drains final replies when terminal state has already cleared the active task", () => {
    assert.deepEqual(selectWaitMessages([done, plan]), [done, plan]);
  });
});
