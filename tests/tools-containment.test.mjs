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
import { WorkspaceTools } from "../bridge/tools.mjs";
import { workspaceStateDir, recordsDir } from "../bridge/state.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
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
