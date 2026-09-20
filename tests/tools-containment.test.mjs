// Regression tests for path containment, sensitive-file denial, the
// workspace-root-inside-a-bigger-repo git scoping bug (found and fixed this
// session), and the execution_output task-scoping bug (same). Uses a real
// temporary git repo — `git` is a hard prerequisite of gpt-worker itself,
// not an extra test dependency.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { WorkspaceTools, parseGitHubRemote } from "../bridge/tools.mjs";
import { BridgeLink } from "../bridge/link.mjs";
import { allowedReadFile } from "../bridge/cli-settings.mjs";
import { workspaceStateDir, recordsDir } from "../bridge/state.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function cli(args, { cwd, stateRoot }) {
  return execFileSync(process.execPath, [path.resolve("bridge/cli.mjs"), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GPT_WORKER_STATE_ROOT: stateRoot },
  });
}

function makeParentRepoWithWorkspaceSubdir() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gw-parent-"));
  git(parent, ["init", "-q"]);
  git(parent, ["config", "user.email", "test@example.com"]);
  git(parent, ["config", "user.name", "Test"]);

  const workspace = path.join(parent, "workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "README.md"), "hello\n");
  fs.mkdirSync(path.join(workspace, ".ssh"));
  fs.writeFileSync(path.join(workspace, ".ssh", "id_rsa"), "not-a-real-key\n");

  const sibling = path.join(parent, "sibling");
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, "secret-plan.md"), "sibling content\n");

  git(parent, ["add", "-A"]);
  git(parent, ["commit", "-q", "-m", "initial"]);

  // Now dirty only the sibling directory — the workspace itself stays clean.
  fs.writeFileSync(path.join(sibling, "secret-plan.md"), "sibling content, changed\n");
  fs.writeFileSync(path.join(sibling, "untracked.txt"), "new sibling file\n");

  return { parent, workspace, sibling };
}

const dirsToClean = [];
after(() => {
  for (const dir of dirsToClean) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

function trackedParentRepo() {
  const r = makeParentRepoWithWorkspaceSubdir();
  dirsToClean.push(r.parent, workspaceStateDir(r.workspace));
  return r;
}

function ignoredWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gw-ignored-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(root, "README.md"), "visible\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\nignored-dir/\nCLAUDE.md\n");
  git(root, ["add", "README.md", ".gitignore"]);
  git(root, ["commit", "-q", "-m", "initial"]);
  fs.writeFileSync(path.join(root, "ignored.txt"), "ignored searchable value\n");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "ignored overview\n");
  fs.mkdirSync(path.join(root, "ignored-dir"));
  fs.writeFileSync(path.join(root, "ignored-dir", "hidden.js"), "const hidden = true;\n");
  dirsToClean.push(root, workspaceStateDir(root));
  return root;
}

function overviewWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gw-overview-"));
  fs.writeFileSync(path.join(root, "AGENTS.md"), "agent rules\n");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "developer notes\n");
  dirsToClean.push(root, workspaceStateDir(root));
  return root;
}

describe("WorkspaceTools: path containment", () => {
  const { workspace } = trackedParentRepo();
  const tools = new WorkspaceTools(workspace);

  test("reads a normal file inside the workspace", () => {
    const r = tools.readFile({ path: "README.md" });
    assert.equal(r.error, undefined);
    assert.match(r.text, /hello/);
  });

  test("denies a sensitive file inside the workspace", () => {
    const r = tools.readFile({ path: ".ssh/id_rsa" });
    assert.equal(r.error, "ACCESS_DENIED_SENSITIVE_FILE");
  });

  test("rejects a path-traversal read outside the workspace", () => {
    const r = tools.readFile({ path: "../sibling/secret-plan.md" });
    assert.equal(r.error, "OUT_OF_WORKSPACE");
  });

  test("rejects a path-traversal directory listing outside the workspace", () => {
    const r = tools.listDirectory({ path: "../sibling" });
    assert.equal(r.error, "OUT_OF_WORKSPACE");
  });
});

describe("allowedReadFile: CLI allow-read containment", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gw-allowed-read-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gw-allowed-read-outside-"));
  dirsToClean.push(root, outside);
  fs.writeFileSync(path.join(root, "ignored.txt"), "ignored\n");
  fs.mkdirSync(path.join(root, "directory"));
  fs.writeFileSync(path.join(root, ".env"), "secret\n");
  fs.writeFileSync(path.join(root, "id_rsa"), "private key\n");
  fs.mkdirSync(path.join(root, ".ssh"));
  fs.writeFileSync(path.join(root, ".ssh", "config"), "Host example\n");
  fs.writeFileSync(path.join(outside, "outside.txt"), "outside\n");
  fs.symlinkSync(path.join(outside, "outside.txt"), path.join(root, "outside-link"));

  test("returns only a canonical workspace-relative regular file", () => {
    assert.equal(allowedReadFile(root, "ignored.txt"), "ignored.txt");
  });

  test("rejects traversal, absolute paths, and symlinks that escape the workspace", () => {
    assert.throws(() => allowedReadFile(root, "../outside.txt"), /OUT_OF_WORKSPACE/);
    assert.throws(() => allowedReadFile(root, path.join(outside, "outside.txt")), /OUT_OF_WORKSPACE/);
    assert.throws(() => allowedReadFile(root, "outside-link"), /OUT_OF_WORKSPACE/);
  });

  test("rejects sensitive paths even when they exist", () => {
    for (const relPath of [".env", "id_rsa", ".ssh/config"]) {
      assert.throws(() => allowedReadFile(root, relPath), /ACCESS_DENIED_SENSITIVE_FILE/);
    }
  });

  test("rejects empty paths, workspace root, and directories", () => {
    assert.throws(() => allowedReadFile(root, ""), /Usage:/);
    assert.throws(() => allowedReadFile(root, "."), /workspace-relative file path/);
    assert.throws(() => allowedReadFile(root, "directory"), /Only an exact file path/);
  });

  test("allows a missing relative path only while revoking an exception", () => {
    assert.throws(() => allowedReadFile(root, "missing.txt"), /NOT_FOUND/);
    assert.equal(allowedReadFile(root, "missing.txt", { mustExist: false }), "missing.txt");
    assert.throws(() => allowedReadFile(root, "directory", { mustExist: false }), /Only an exact file path/);
    assert.throws(() => allowedReadFile(root, ".env", { mustExist: false }), /ACCESS_DENIED_SENSITIVE_FILE/);
  });
});

describe("git_status / git_diff: scoped to workspace root, not the enclosing repo", () => {
  const { workspace, sibling } = trackedParentRepo();
  const tools = new WorkspaceTools(workspace);

  test("git_status sees no changes (only the sibling directory is dirty)", () => {
    const r = tools.gitStatus();
    assert.equal(r.isRepo, true);
    assert.equal(r.unstaged.length, 0);
    assert.equal(r.untracked.length, 0);
  });

  test("git_diff() with no path shows nothing from the sibling directory", () => {
    const r = tools.gitDiff({});
    assert.equal(r.diff, "");
  });

  test("git_diff({path: '../sibling/...'}) is rejected as out of workspace, not silently scoped there", () => {
    const r = tools.gitDiff({ path: "../sibling/secret-plan.md" });
    assert.equal(r.error, "OUT_OF_WORKSPACE");
    void sibling; // present for readability of the scenario being tested
  });

  test("workspace_info's git identity reports clean, not dirty from the sibling", () => {
    const info = tools.workspaceInfo();
    assert.equal(info.git.isRepo, true);
    assert.equal(info.git.dirty, false);
  });

  test("git_log() returns the initial commit with the expected fields", () => {
    const r = tools.gitLog({});
    assert.equal(r.commits.length >= 1, true);
    const first = r.commits[0];
    assert.equal(typeof first.hash, "string");
    assert.equal(typeof first.shortHash, "string");
    assert.equal(typeof first.date, "string");
    assert.equal(first.subject, "initial");
  });

  test("git_log({path: '../sibling/...'}) is rejected as out of workspace", () => {
    const r = tools.gitLog({ path: "../sibling/secret-plan.md" });
    assert.equal(r.error, "OUT_OF_WORKSPACE");
  });

  test("git_log respects limit", () => {
    const r = tools.gitLog({ limit: 1 });
    assert.equal(r.commits.length, 1);
  });
});

describe("WorkspaceTools: Git-ignored paths", () => {
  const workspace = ignoredWorkspace();

  test("denies direct reads unless the exact canonical path is explicitly allowed", () => {
    const denied = new WorkspaceTools(workspace).readFile({ path: "ignored.txt" });
    assert.equal(denied.error, "ACCESS_DENIED_GITIGNORED_FILE");

    const allowed = new WorkspaceTools(workspace, { allowedReadPaths: () => ["ignored.txt"] }).readFile({ path: "ignored.txt" });
    assert.equal(allowed.error, undefined);
    assert.match(allowed.text, /ignored searchable value/);
  });

  test("does not let an allowlist override sensitive-file protection", () => {
    fs.writeFileSync(path.join(workspace, ".env"), "not-a-secret\n");
    const result = new WorkspaceTools(workspace, { allowedReadPaths: () => [".env"] }).readFile({ path: ".env" });
    assert.equal(result.error, "ACCESS_DENIED_SENSITIVE_FILE");
  });

  test("keeps ignored paths out of browsing, search, language detection and scoped Git tools", () => {
    const tools = new WorkspaceTools(workspace, { allowedReadPaths: () => ["ignored.txt"] });
    const listing = tools.listDirectory({ path: "" });
    assert.equal(listing.entries.some((entry) => entry.path === "ignored.txt" || entry.path === "ignored-dir"), false);
    assert.equal(tools.searchWorkspace({ query: "ignored searchable value" }).hits.length, 0);
    assert.equal(tools.workspaceInfo().languages.includes("JavaScript"), false);
    assert.equal(tools.gitDiff({ path: "ignored.txt" }).error, "ACCESS_DENIED_GITIGNORED_FILE");
    assert.equal(tools.gitLog({ path: "ignored.txt" }).error, "ACCESS_DENIED_GITIGNORED_FILE");
  });

  test("CLI stores and removes exact-file exceptions in private local state", () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gw-allow-state-"));
    dirsToClean.push(stateRoot);
    assert.match(cli(["allow-read", "ignored.txt", "-w", workspace], { cwd: workspace, stateRoot }), /Allowed direct MCP reads/);
    assert.equal(cli(["allow-list", "-w", workspace], { cwd: workspace, stateRoot }).trim(), "ignored.txt");
    assert.match(cli(["deny-read", "ignored.txt", "-w", workspace], { cwd: workspace, stateRoot }), /Removed direct-read permission/);
    assert.equal(cli(["allow-list", "-w", workspace], { cwd: workspace, stateRoot }).trim(), "(no explicitly allowed files)");
  });

  test("keeps Git-ignored overview files unavailable unless explicitly allowed", () => {
    const denied = new WorkspaceTools(workspace).workspaceOverview();
    const deniedClaude = denied.files.find((file) => file.path === "CLAUDE.md");
    assert.deepEqual(deniedClaude, { path: "CLAUDE.md", status: "unavailable", reason: "ACCESS_DENIED_GITIGNORED_FILE" });

    const allowed = new WorkspaceTools(workspace, { allowedReadPaths: () => ["CLAUDE.md"] }).workspaceOverview();
    const allowedClaude = allowed.files.find((file) => file.path === "CLAUDE.md");
    assert.equal(allowedClaude.status, "read");
    assert.match(allowedClaude.text, /ignored overview/);
  });
});

describe("WorkspaceTools: project overview", () => {
  const workspace = overviewWorkspace();

  test("reads only the two fixed root-level overview files as untrusted data", () => {
    const overview = new WorkspaceTools(workspace).workspaceOverview();
    assert.equal(overview.note.includes("untrusted project data"), true);
    assert.deepEqual(overview.files.map((file) => file.path), ["AGENTS.md", "CLAUDE.md"]);
    assert.equal(overview.files.every((file) => file.status === "read"), true);
    assert.match(overview.files[0].text, /agent rules/);
    assert.match(overview.files[1].text, /developer notes/);
  });

  test("reports a missing file without suppressing the other overview file", () => {
    fs.unlinkSync(path.join(workspace, "AGENTS.md"));
    const overview = new WorkspaceTools(workspace).workspaceOverview();
    assert.deepEqual(overview.files[0], { path: "AGENTS.md", status: "unavailable", reason: "NOT_FOUND" });
    assert.equal(overview.files[1].status, "read");
  });
});

describe("GitHub repository identity", () => {
  test("normalizes only safe github.com remote forms", () => {
    assert.deepEqual(parseGitHubRemote("https://github.com/acme/widget.git"), {
      provider: "github", owner: "acme", name: "widget", host: "github.com", url: "https://github.com/acme/widget",
    });
    assert.deepEqual(parseGitHubRemote("git@github.com:acme/widget.git"), {
      provider: "github", owner: "acme", name: "widget", host: "github.com", url: "https://github.com/acme/widget",
    });
    for (const remote of [
      "https://token@github.com/acme/widget.git",
      "https://github.example.com/acme/widget.git",
      "https://github.com/acme/widget.git?token=no",
      "not a remote",
    ]) {
      assert.equal(parseGitHubRemote(remote), null, remote);
    }
  });

  test("workspace_info exposes a sanitized GitHub identity and local HEAD", () => {
    const { workspace } = trackedParentRepo();
    git(workspace, ["remote", "add", "origin", "git@github.com:acme/widget.git"]);
    const info = new WorkspaceTools(workspace).workspaceInfo();
    assert.deepEqual(info.repository, {
      provider: "github",
      owner: "acme",
      name: "widget",
      host: "github.com",
      url: "https://github.com/acme/widget",
      remote: "origin",
      headCommit: info.git.commit,
      branch: info.git.branch,
    });
  });
});

describe("execution_output: scoped to one task_id, never merged across tasks", () => {
  const { workspace } = trackedParentRepo();
  const tools = new WorkspaceTools(workspace);
  const dir = recordsDir(workspace);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "task-A.jsonl"),
    JSON.stringify({ task_id: "task-A", iteration: 1, changed_files: 1, tests: "A passed" }) + "\n"
  );
  fs.writeFileSync(
    path.join(dir, "task-B.jsonl"),
    JSON.stringify({ task_id: "task-B", iteration: 1, changed_files: 99, tests: "B passed" }) + "\n"
  );

  test("explicit task_id returns only that task's record, even with a colliding iteration number", () => {
    const a = tools.executionOutput({ task_id: "task-A", iteration: 1 });
    assert.equal(a.found, true);
    assert.equal(a.record.tests, "A passed");

    const b = tools.executionOutput({ task_id: "task-B", iteration: 1 });
    assert.equal(b.found, true);
    assert.equal(b.record.tests, "B passed");
  });

  test("omitting task_id does not infer a task from local state", () => {
    const r = tools.executionOutput({ iteration: 1 });
    assert.equal(r.found, false);
  });

  test("an unknown task_id is simply not found", () => {
    assert.equal(tools.executionOutput({ task_id: "no-such-task" }).found, false);
  });
});

describe("BridgeLink: workspace_batch containment", () => {
  function fakeSocket() {
    const sent = [];
    return {
      readyState: 1,
      send: (data) => sent.push(JSON.parse(data)),
      sent,
    };
  }

  test("applies path traversal, sensitive file, and gitignored file containment in batch calls", async () => {
    const { workspace } = trackedParentRepo();
    const link = new BridgeLink({
      workerUrl: "https://example.test",
      workspaceId: "0123456789abcdef",
      linkToken: "tok",
      workspaceRoot: workspace,
    });
    const ws = fakeSocket();
    link.ws = ws;

    await link.handleMessage(
      JSON.stringify({
        rid: "b-containment",
        method: "workspace_batch",
        params: {
          __gptWorkerActiveTask: true,
          calls: [
            { id: "c-normal", name: "read_file", arguments: { path: "README.md" } },
            { id: "c-traversal", name: "read_file", arguments: { path: "../sibling/secret-plan.md" } },
            { id: "c-sensitive", name: "read_file", arguments: { path: ".ssh/id_rsa" } },
          ],
        },
      })
    );

    assert.equal(ws.sent.length, 1);
    const results = ws.sent[0].result.results;
    assert.equal(results.length, 3);

    // Normal file succeeds
    assert.equal(results[0].id, "c-normal");
    assert.equal(results[0].ok, true);
    assert.equal(results[0].result.text, "hello\n");

    // Traversal is denied
    assert.equal(results[1].id, "c-traversal");
    assert.equal(results[1].ok, false);
    assert.equal(results[1].error.error, "OUT_OF_WORKSPACE");

    // Sensitive file is denied
    assert.equal(results[2].id, "c-sensitive");
    assert.equal(results[2].ok, false);
    assert.equal(results[2].error.error, "ACCESS_DENIED_SENSITIVE_FILE");
  });

  test("denies gitignored file in batch calls unless allowed", async () => {
    const root = ignoredWorkspace();
    const link = new BridgeLink({
      workerUrl: "https://example.test",
      workspaceId: "0123456789abcdef",
      linkToken: "tok",
      workspaceRoot: root,
    });
    const ws = fakeSocket();
    link.ws = ws;

    await link.handleMessage(
      JSON.stringify({
        rid: "b-ignored",
        method: "workspace_batch",
        params: {
          __gptWorkerActiveTask: true,
          calls: [
            { id: "c-normal", name: "read_file", arguments: { path: "README.md" } },
            { id: "c-ignored", name: "read_file", arguments: { path: "ignored.txt" } },
          ],
        },
      })
    );

    assert.equal(ws.sent.length, 1);
    const results = ws.sent[0].result.results;
    assert.equal(results.length, 2);

    assert.equal(results[0].id, "c-normal");
    assert.equal(results[0].ok, true);
    assert.equal(results[0].result.text, "visible\n");

    assert.equal(results[1].id, "c-ignored");
    assert.equal(results[1].ok, false);
    assert.equal(results[1].error.error, "ACCESS_DENIED_GITIGNORED_FILE");
  });
});
