// Regression test for a real bug found while dogfooding multi-workspace
// support: a bare boolean flag (e.g. --cli, --force) immediately followed by
// "-w <dir>" swallowed "-w" itself as the flag's value, silently dropping
// the workspace argument (it fell back to process.cwd() instead).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  buildChatOpenUrl,
  effectiveChatUrl,
  isChatGptUrl,
  parseArgs,
  safeBrowserConfig,
  selectWaitMessages,
  withChatUrl,
  withWorkspaceChatUrl,
  withWorkspaceConversationUrl,
  withWorkspaceChromeTab,
  withoutWorkspaceChatConversation,
  withoutWorkspaceChatSettings,
  withoutWorkspaceChatUrl,
  workspaceChatUrl,
  workspaceConversationUrl,
  withoutWorkspaceChromeTab,
  workspaceChromeTabId,
  loadChatSettings,
  nudgeChatGpt,
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

  test("--title takes a string value and works alongside -w", () => {
    const args = parseArgs(["--title", "Exchange title", "-w", "/tmp/x"]);
    assert.equal(args.title, "Exchange title");
    assert.equal(args.workspace, "/tmp/x");
  });

  test("bare --title before -w sets args.title to true", () => {
    const args = parseArgs(["--title", "-w", "/tmp/x"]);
    assert.equal(args.title, true);
    assert.equal(args.workspace, "/tmp/x");
  });

  test("--title=value form parses value correctly", () => {
    const args = parseArgs(["--title=Inline Title", "-w", "/tmp/x"]);
    assert.equal(args.title, "Inline Title");
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

  test("parses options passed after complete or continue subcommands", () => {
    // main() strips the command name before calling parseArgs(rest)
    const completeArgs = parseArgs(["-w", "/tmp/x"]);
    assert.equal(completeArgs.workspace, "/tmp/x");

    const continueArgs = parseArgs(["-w", "/tmp/y"]);
    assert.equal(continueArgs.workspace, "/tmp/y");
  });
});

describe("complete and continue command dispatch", () => {
  test("main() dispatches complete and continue and lists them in Usage", async () => {
    const fs = await import("node:fs");
    const cliSource = fs.readFileSync(new URL("../bridge/cli.mjs", import.meta.url), "utf8");
    assert.match(cliSource, /case "complete":\s*\n\s*return cmdComplete\(args\);/);
    assert.match(cliSource, /case "continue":\s*\n\s*return cmdContinue\(args\);/);
    assert.match(cliSource, /Usage: gpt-worker.*\|complete\|continue>/);
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

  test("stores a same-Project conversation separately and clears only its workspace tab", () => {
    const project = "https://chatgpt.com/g/g-p-example/project";
    const base = {
      chatUrl: project,
      chromeTabsByWorkspace: { [workspaceA]: "101", [workspaceB]: "202" },
      conversationUrlsByWorkspace: { [workspaceB]: "https://chatgpt.com/g/g-p-example/c/other" },
    };
    const attached = withWorkspaceConversationUrl(base, workspaceA, "https://chatgpt.com/g/g-p-example/c/current?query=ignored");
    assert.equal(workspaceConversationUrl(attached, workspaceA), "https://chatgpt.com/g/g-p-example/c/current");
    assert.equal(workspaceChromeTabId(attached, workspaceA), null);
    assert.equal(workspaceConversationUrl(attached, workspaceB), "https://chatgpt.com/g/g-p-example/c/other");
    assert.equal(workspaceChromeTabId(attached, workspaceB), "202");
    assert.equal(
      withWorkspaceConversationUrl(base, workspaceA, "https://chatgpt.com/g/g-p-other/c/wrong"),
      base,
      "a conversation from another Project must not be attachable"
    );
  });

  test("starting a new chat clears only the workspace conversation and tab", () => {
    const base = {
      chatUrl: "https://chatgpt.com/g/g-p-example/project",
      chromeTabsByWorkspace: { [workspaceA]: "101", [workspaceB]: "202" },
      conversationUrlsByWorkspace: {
        [workspaceA]: "https://chatgpt.com/g/g-p-example/c/current",
        [workspaceB]: "https://chatgpt.com/g/g-p-example/c/other",
      },
    };
    const fresh = withoutWorkspaceChatConversation(base, workspaceA);
    assert.equal(workspaceChromeTabId(fresh, workspaceA), null);
    assert.equal(workspaceConversationUrl(fresh, workspaceA), null);
    assert.equal(workspaceChromeTabId(fresh, workspaceB), "202");
    assert.equal(workspaceConversationUrl(fresh, workspaceB), "https://chatgpt.com/g/g-p-example/c/other");
  });

  test("clears all tab IDs when the shared Project URL changes", () => {
    const settings = {
      chatUrl: "https://chatgpt.com/g/g-p-old/project",
      chromeTabsByWorkspace: { [workspaceA]: "101", [workspaceB]: "202" },
      conversationUrlsByWorkspace: {
        [workspaceA]: "https://chatgpt.com/g/g-p-old/c/a",
        [workspaceB]: "https://chatgpt.com/g/g-p-old/c/b",
      },
    };
    const changed = withChatUrl(settings, "https://chatgpt.com/g/g-p-new/project");
    const unchanged = withChatUrl(settings, settings.chatUrl);

    assert.equal(Object.hasOwn(changed, "chromeTabsByWorkspace"), false);
    assert.equal(Object.hasOwn(changed, "conversationUrlsByWorkspace"), false);
    assert.deepEqual(unchanged.chromeTabsByWorkspace, settings.chromeTabsByWorkspace);
  });

  test("resolves a workspace override, or falls back to the shared default", () => {
    const settings = {
      chatUrl: "https://chatgpt.com/g/g-p-default/project",
      chatUrlsByWorkspace: { [workspaceB]: "https://chatgpt.com/g/g-p-b/project" },
    };
    assert.equal(workspaceChatUrl(settings, workspaceA), null);
    assert.equal(workspaceChatUrl(settings, workspaceB), "https://chatgpt.com/g/g-p-b/project");
    assert.equal(effectiveChatUrl(settings, workspaceA), settings.chatUrl);
    assert.equal(effectiveChatUrl(settings, workspaceB), "https://chatgpt.com/g/g-p-b/project");
    assert.equal(workspaceChatUrl({ chatUrlsByWorkspace: [] }, workspaceA), null);
    assert.equal(workspaceChatUrl({ chatUrlsByWorkspace: { [workspaceA]: 42 } }, workspaceA), null);
    assert.equal(workspaceChatUrl({ chatUrlsByWorkspace: { [workspaceA]: "not a URL" } }, workspaceA), null);
    assert.equal(isChatGptUrl("https://chatgpt.com/g/g-p-example/project"), true);
    assert.equal(isChatGptUrl("https://example.com/g/g-p-example/project"), false);
  });

  test("changing or clearing an override invalidates only that workspace's tab", () => {
    const base = {
      chatUrl: "https://chatgpt.com/g/g-p-default/project",
      chromeTabsByWorkspace: { [workspaceA]: "101", [workspaceB]: "202" },
      chatUrlsByWorkspace: { [workspaceA]: "https://chatgpt.com/g/g-p-a-old/project" },
    };
    const changed = withWorkspaceChatUrl(base, workspaceA, "https://chatgpt.com/g/g-p-a-new/project");
    assert.equal(workspaceChromeTabId(changed, workspaceA), null);
    assert.equal(workspaceChromeTabId(changed, workspaceB), "202");
    assert.equal(workspaceChatUrl(changed, workspaceA), "https://chatgpt.com/g/g-p-a-new/project");

    const cleared = withoutWorkspaceChatUrl(changed, workspaceA);
    assert.equal(workspaceChatUrl(cleared, workspaceA), null);
    assert.equal(effectiveChatUrl(cleared, workspaceA), base.chatUrl);
    assert.equal(workspaceChromeTabId(cleared, workspaceB), "202");
  });

  test("changing the default preserves tabs for explicit overrides only", () => {
    const base = {
      chatUrl: "https://chatgpt.com/g/g-p-old-default/project",
      chromeTabsByWorkspace: { [workspaceA]: "101", [workspaceB]: "202" },
      conversationUrlsByWorkspace: {
        [workspaceA]: "https://chatgpt.com/g/g-p-old-default/c/a",
        [workspaceB]: "https://chatgpt.com/g/g-p-b/c/b",
      },
      chatUrlsByWorkspace: { [workspaceB]: "https://chatgpt.com/g/g-p-b/project" },
    };
    const changed = withChatUrl(base, "https://chatgpt.com/g/g-p-new-default/project");
    assert.equal(workspaceChromeTabId(changed, workspaceA), null);
    assert.equal(workspaceChromeTabId(changed, workspaceB), "202");
    assert.equal(workspaceConversationUrl(changed, workspaceA), null);
    assert.equal(workspaceConversationUrl(changed, workspaceB), "https://chatgpt.com/g/g-p-b/c/b");
    assert.equal(effectiveChatUrl(changed, workspaceA), "https://chatgpt.com/g/g-p-new-default/project");
    assert.equal(effectiveChatUrl(changed, workspaceB), base.chatUrlsByWorkspace[workspaceB]);
  });

  test("workspace removal cleans both its override and tab metadata only", () => {
    const base = {
      chatUrl: "https://chatgpt.com/g/g-p-default/project",
      chromeTabsByWorkspace: { [workspaceA]: "101", [workspaceB]: "202" },
      chatUrlsByWorkspace: {
        [workspaceA]: "https://chatgpt.com/g/g-p-a/project",
        [workspaceB]: "https://chatgpt.com/g/g-p-b/project",
      },
    };
    const result = withoutWorkspaceChatSettings(base, workspaceA);
    assert.equal(workspaceChromeTabId(result, workspaceA), null);
    assert.equal(workspaceChatUrl(result, workspaceA), null);
    assert.equal(workspaceChromeTabId(result, workspaceB), "202");
    assert.equal(workspaceChatUrl(result, workspaceB), base.chatUrlsByWorkspace[workspaceB]);
  });

  test("creates an allowlisted config view without credentials or tab IDs", () => {
    const settings = {
      workerUrl: "https://worker.example",
      adminToken: "admin-secret",
      hubGptToken: "hub-secret",
      chatUrl: "https://chatgpt.com/g/g-p-default/project",
      enterDelayMs: 1500,
      chatUrlsByWorkspace: { [workspaceB]: "https://chatgpt.com/g/g-p-b/project" },
      conversationUrlsByWorkspace: { [workspaceA]: "https://chatgpt.com/g/g-p-default/c/conversation-a" },
      chromeTabsByWorkspace: { [workspaceA]: "101", [workspaceB]: "202" },
    };
    const workspaces = [
      { workspaceId: workspaceA, workspacePath: "/tmp/a", gptToken: "gpt-secret" },
      { workspaceId: workspaceB, workspacePath: "/tmp/b", cliToken: "cli-secret" },
    ];
    const view = safeBrowserConfig(settings, workspaces);
    const text = JSON.stringify(view);

    assert.equal(view.sharedChatUrl, settings.chatUrl);
    assert.equal(view.autoEnter, undefined);
    assert.equal(view.workspaces[0].chatUrlOverride, null);
    assert.equal(view.workspaces[0].effectiveChatUrl, settings.chatUrl);
    assert.equal(view.workspaces[0].conversationUrl, settings.conversationUrlsByWorkspace[workspaceA]);
    assert.equal(view.workspaces[1].chatUrlOverride, settings.chatUrlsByWorkspace[workspaceB]);
    assert.equal(view.workspaces[1].effectiveChatUrl, settings.chatUrlsByWorkspace[workspaceB]);
    for (const secret of ["worker.example", "admin-secret", "hub-secret", "gpt-secret", "cli-secret", "101", "202"]) {
      assert.equal(text.includes(secret), false, secret);
    }
  });

  test("ignores legacy autoEnter: false in persisted settings", () => {
    const settings = {
      chatUrl: "https://chatgpt.com/g/g-p-default/project",
      autoEnter: false,
    };
    const view = safeBrowserConfig(settings, []);
    assert.equal(view.autoEnter, undefined);
    assert.equal(view.sharedChatUrl, settings.chatUrl);
  });

  test("filters the config view to the requested workspace", () => {
    const workspaces = [{ workspaceId: workspaceA }, { workspaceId: workspaceB }];
    const view = safeBrowserConfig({ chatUrl: "https://chatgpt.com/g/g-p-default/project" }, workspaces, workspaceB);
    assert.deepEqual(view.workspaces.map((workspace) => workspace.workspaceId), [workspaceB]);
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

describe("nudgeChatGpt conversation callback and tab separation", () => {
  test("nudgeChatGpt is an async function that can be awaited without opening real Chrome tabs", async () => {
    assert.equal(typeof nudgeChatGpt, "function");
    let openCalled = false;
    const p = nudgeChatGpt(
      { chatUrl: "https://chatgpt.com/g/g-p-test/project" },
      "task-1",
      "ws-1",
      {
        log: () => {},
        _openInChrome: () => {
          openCalled = true;
          return { submitted: true, reused: false, tabId: "123" };
        },
      }
    );
    assert.ok(p instanceof Promise);
    await p;
    assert.equal(openCalled, true);
  });
});

describe("cmdUrl WebUI output", () => {
  test("gpt-worker url outputs WebUI URL for hub and workspace", () => {
    const cliPath = path.resolve("bridge/cli.mjs");
    const hubOut = execFileSync(process.execPath, [cliPath, "url"], { encoding: "utf8" });
    assert.match(hubOut, /^WebUI URL:\s+https?:\/\/[^\/]+\/dashboard\/hub/m);
    assert.match(hubOut, /^OAuth Server URL:\s+https?:\/\/[^\/]+\/mcp/m);

    const wsOut = execFileSync(process.execPath, [cliPath, "url", "-w", "."], { encoding: "utf8" });
    assert.match(wsOut, /^WebUI URL:\s+https?:\/\/[^\/]+\/dashboard\/[a-f0-9]{16}/m);
    assert.match(wsOut, /^OAuth Server URL:\s+https?:\/\/[^\/]+\/mcp\/[a-f0-9]{16}/m);
  });
});

describe("CLI title option validation", () => {
  const cliPath = path.resolve("bridge/cli.mjs");

  test("gpt-worker task rejects bare --title before -w", () => {
    assert.throws(
      () => execFileSync(process.execPath, [cliPath, "task", "some goal", "--title", "-w", "."], { encoding: "utf8", stdio: "pipe" }),
      (err) => {
        assert.equal(err.status, 1);
        assert.match(err.stderr, /Invalid title: --title requires a string value/);
        return true;
      }
    );
  });

  test("gpt-worker report rejects bare --title before -w", () => {
    // Uses an isolated, unprovisioned temp workspace rather than "-w .": the
    // check must reject the malformed flag before any workspace/config/remote
    // task-state inspection, so it must pass regardless of whether this
    // repository's own gpt-worker workspace currently has an active task.
    const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "gw-title-test-"));
    try {
      assert.throws(
        () => execFileSync(process.execPath, [cliPath, "report", "--title", "-w", tmpWorkspace], { encoding: "utf8", stdio: "pipe" }),
        (err) => {
          assert.equal(err.status, 1);
          assert.match(err.stderr, /Invalid title: --title requires a string value/);
          return true;
        }
      );
    } finally {
      fs.rmSync(tmpWorkspace, { recursive: true, force: true });
    }
  });

  test("gpt-worker handoff rejects bare --title before -w", () => {
    // handoff shares reportRound() with report, so this exercises the same
    // ordering guarantee via the other caller.
    const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "gw-title-test-"));
    try {
      assert.throws(
        () => execFileSync(process.execPath, [cliPath, "handoff", "--title", "-w", tmpWorkspace], { encoding: "utf8", stdio: "pipe" }),
        (err) => {
          assert.equal(err.status, 1);
          assert.match(err.stderr, /Invalid title: --title requires a string value/);
          return true;
        }
      );
    } finally {
      fs.rmSync(tmpWorkspace, { recursive: true, force: true });
    }
  });
});
