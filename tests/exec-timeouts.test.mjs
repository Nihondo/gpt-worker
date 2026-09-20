// What happens when git / rg stop answering. Every child process the bridge
// runs is synchronous, so a hung one used to freeze the whole daemon; each now
// has a time budget. These tests make that budget matter by putting a fake
// `git` and `rg` first on PATH and pointing GPT_WORKER_EXEC_TIMEOUT_MS at a few
// hundred milliseconds instead of the real 5-15 seconds.
//
// The behavior that matters most is on the *access-control* path: the
// gitignore check must fail CLOSED. `git check-ignore` exiting 1 means "not
// ignored"; a check that never finished means "unknown", and unknown must not
// be allowed to read as "not ignored" — that would expose a gitignored file
// exactly when git is slow.
//
// Kept in its own file because it rewrites PATH for the whole process and
// bridge/tools.mjs caches whether rg exists.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.GPT_WORKER_EXEC_TIMEOUT_MS = "250";
const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-shim-"));
const originalPath = process.env.PATH;
process.env.PATH = `${shimDir}${path.delimiter}${originalPath}`;

const spawnLog = path.join(shimDir, "spawns.log");
process.env.GW_SPAWN_LOG = spawnLog;
const { hasGitAncestor } = await import("./helpers/git-ancestor.mjs");
// Tests that treat a temp dir as a plain directory need nothing above it to be a checkout.
const TMP_IN_GIT = hasGitAncestor(os.tmpdir()) ? "TMPDIR is inside a git checkout, so a temp dir is not a plain directory" : false;
const { IgnoreRules } = await import("../bridge/ignore.mjs?exec-timeouts");
const { WorkspaceTools } = await import("../bridge/tools.mjs?exec-timeouts");

after(() => {
  delete process.env.GW_SPAWN_LOG;
  process.env.PATH = originalPath;
  delete process.env.GPT_WORKER_EXEC_TIMEOUT_MS;
  fs.rmSync(shimDir, { recursive: true, force: true });
});

function installShim(name, script) {
  const file = path.join(shimDir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

/** Fake git behaviors, by scenario. `sleep` outlasts the 250ms budget. */
const GIT = {
  hangEverything: `exec sleep 5`,
  hangOnlyCheckIgnore: `case "$1" in rev-parse) exit 0;; check-ignore) exec sleep 5;; *) exit 0;; esac`,
  notIgnored: `case "$1" in check-ignore) exit 1;; *) exit 0;; esac`,
  fatal: `case "$1" in rev-parse) exit 0;; check-ignore) exit 128;; *) exit 0;; esac`,
  notARepository: `case "$1" in rev-parse) echo "fatal: not a git repository (or any of the parent directories): .git" >&2; exit 128;; *) exit 0;; esac`,
  dubiousOwnership: `case "$1" in rev-parse) echo "fatal: detected dubious ownership in repository at '/x'" >&2; exit 128;; *) exit 0;; esac`,
  failsQuickly: `echo "fatal: not a git repository" >&2; exit 128`,
};
const RG = {
  hang: `[ "$1" = "--version" ] && exit 0; exec sleep 5`,
  noMatches: `[ "$1" = "--version" ] && exit 0; exit 1`,
  // rg prints what it found and exits 2 when it could not read some paths.
  partial: `[ "$1" = "--version" ] && exit 0; echo "notes.txt:1:plain notes"; echo "rg: ./locked: Permission denied (os error 13)" >&2; exit 2`,
  badRegex: `[ "$1" = "--version" ] && exit 0; echo "rg: regex parse error: unclosed group" >&2; exit 2`,
};
// bridge/tools.mjs caches whether rg exists on first use, so a working (fake)
// rg has to be in place before the first WorkspaceTools call.
installShim("rg", RG.hang);

function makeWorkspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gw-exec-ws-")));
  fs.writeFileSync(path.join(root, "notes.txt"), "plain notes\n");
  return root;
}

describe("gitignore check fails closed unless git gave a definite answer", () => {
  test("a probe that never finishes denies the path and does not conclude 'not a repository'", () => {
    installShim("git", GIT.hangEverything);
    const rules = new IgnoreRules({ root: makeWorkspace() });

    assert.equal(rules.isGitIgnored("notes.txt"), true);
    // Unset, not false: false would switch the whole gitignore check off for
    // every later call, on the strength of a probe that said nothing.
    assert.equal(rules.isGitRepository, null);
  });

  test("a check-ignore that never finishes denies the path", () => {
    installShim("git", GIT.hangOnlyCheckIgnore);
    const rules = new IgnoreRules({ root: makeWorkspace() });

    assert.equal(rules.isGitIgnored("notes.txt"), true);
    assert.equal(rules.isGitRepository, true);
  });

  test("a check that completes keeps its normal meaning: exit 1 is 'not ignored'", () => {
    installShim("git", GIT.notIgnored);
    const rules = new IgnoreRules({ root: makeWorkspace() });

    assert.equal(rules.isGitIgnored("notes.txt"), false);
  });

  test("a check that fails outright (exit 128) denies: only exit 1 means 'not ignored'", () => {
    // Exit 128 is git saying it could not decide (a broken .git, dubious
    // ownership, a path beyond a symlink). This used to read as "not ignored",
    // which exposed gitignored files exactly when git was misbehaving.
    installShim("git", GIT.fatal);
    const rules = new IgnoreRules({ root: makeWorkspace() });

    assert.equal(rules.isGitIgnored("notes.txt"), true);
  });

  test("a missing git denies instead of reading as 'not ignored'", () => {
    // PATH with no git anywhere: the probe cannot even start. (A shim that
    // merely fails to execute would not reproduce this — PATH lookup skips it
    // and finds the real git further along.)
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-nogit-"));
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = emptyDir;
      const rules = new IgnoreRules({ root: makeWorkspace() });

      assert.equal(rules.isGitIgnored("notes.txt"), true);
      assert.equal(rules.isGitRepository, null);
    } finally {
      process.env.PATH = savedPath;
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test("a directory git reports is 'not a git repository' is a plain workspace: nothing is git-ignored", { skip: TMP_IN_GIT }, () => {
    // The one probe failure that is a real answer: static filters are then the
    // whole access story, exactly as for any non-Git workspace.
    installShim("git", GIT.notARepository);
    const rules = new IgnoreRules({ root: makeWorkspace() });

    assert.equal(rules.isGitIgnored("notes.txt"), false);
    assert.equal(rules.isGitRepository, false);
  });

  test("a repository git refuses to open (dubious ownership) is NOT taken for a plain directory", () => {
    // Also exit 128, but not "not a git repository". Treating it as one would
    // switch the gitignore check off for a real repository.
    installShim("git", GIT.dubiousOwnership);
    const rules = new IgnoreRules({ root: makeWorkspace() });

    assert.equal(rules.isGitIgnored("notes.txt"), true);
    assert.equal(rules.isGitRepository, null, "left unset so the next call probes again");
  });

  test("a .git entry that git nevertheless calls 'not a repository' is a damaged repo: denied, not a plain directory", () => {
    // git reports a damaged repository with the same words as a plain
    // directory, so the message alone cannot tell them apart; a .git entry that
    // contradicts it can.
    installShim("git", GIT.notARepository);
    const root = makeWorkspace();
    fs.mkdirSync(path.join(root, ".git"));
    const rules = new IgnoreRules({ root });

    assert.equal(rules.isGitIgnored("notes.txt"), true);
    assert.equal(rules.isGitRepository, null, "left unset so the next call probes again");
    assert.match(rules.unknownReason, /a \.git entry exists but git says this is not a repository/);
  });

  test("the .git marker is looked for in ancestors too, and as a file (worktree/submodule)", () => {
    installShim("git", GIT.notARepository);
    const outer = makeWorkspace();
    fs.writeFileSync(path.join(outer, ".git"), "gitdir: /somewhere/else\n"); // a worktree-style pointer file
    const inner = path.join(outer, "packages", "app");
    fs.mkdirSync(inner, { recursive: true });

    assert.equal(new IgnoreRules({ root: inner }).isGitIgnored("notes.txt"), true);
  });

  test("with no .git anywhere above, 'not a repository' still means a plain directory", { skip: TMP_IN_GIT }, () => {
    // The counterpart: the marker check must not turn every plain directory
    // into an unreadable one.
    installShim("git", GIT.notARepository);
    const rules = new IgnoreRules({ root: makeWorkspace() });

    assert.equal(rules.isGitIgnored("notes.txt"), false);
    assert.equal(rules.unknownReason, null);
  });

  test("a denial caused by git being unable to answer says so, instead of looking like a .gitignore rule", () => {
    installShim("git", GIT.dubiousOwnership);
    const tools = new WorkspaceTools(makeWorkspace());
    const denied = tools.readFile({ path: "notes.txt" });

    assert.equal(denied.error, "ACCESS_DENIED_GITIGNORED_FILE");
    assert.match(denied.message, /Git could not confirm this path is not ignored/);
    assert.match(denied.message, /dubious ownership/);
  });

  test("a definite answer from git carries no 'could not confirm' reason", () => {
    installShim("git", GIT.notIgnored);
    const rules = new IgnoreRules({ root: makeWorkspace() });

    assert.equal(rules.isGitIgnored("notes.txt"), false);
    assert.equal(rules.unknownReason, null);
  });

  test("the not-a-repository check does not depend on git's locale", { skip: TMP_IN_GIT }, () => {
    // The probe is run with LC_ALL=C; a shim that answers in another language
    // only when LC_ALL is *not* C proves the variable is actually passed.
    installShim(
      "git",
      `case "$1" in rev-parse) if [ "$LC_ALL" = "C" ]; then echo "fatal: not a git repository" >&2; else echo "fatal: kein Git-Repository" >&2; fi; exit 128;; *) exit 0;; esac`
    );
    const rules = new IgnoreRules({ root: makeWorkspace() });

    assert.equal(rules.isGitIgnored("notes.txt"), false);
    assert.equal(rules.isGitRepository, false);
  });

  test("end to end: while git hangs, read_file is refused and list_directory hides the file", () => {
    installShim("git", GIT.hangOnlyCheckIgnore);
    const tools = new WorkspaceTools(makeWorkspace());

    assert.equal(tools.readFile({ path: "notes.txt" }).error, "ACCESS_DENIED_GITIGNORED_FILE");
    assert.deepEqual(
      tools.listDirectory({ path: "." }).entries.map((entry) => entry.path),
      []
    );
  });

  test("end to end: when git fails outright, read_file is refused rather than served", () => {
    installShim("git", GIT.fatal);
    const tools = new WorkspaceTools(makeWorkspace());

    assert.equal(tools.readFile({ path: "notes.txt" }).error, "ACCESS_DENIED_GITIGNORED_FILE");
  });

  test("end to end: once git answers 'not ignored', the same file is served again", () => {
    installShim("git", GIT.notIgnored);
    const tools = new WorkspaceTools(makeWorkspace());

    assert.equal(tools.readFile({ path: "notes.txt" }).text, "plain notes\n");
    assert.deepEqual(
      tools.listDirectory({ path: "." }).entries.map((entry) => entry.path),
      ["notes.txt"]
    );
  });
});

/** Installs a fake git that records every invocation (its first argument) in the
 *  spawn log, then behaves as `script`. */
function installCountedGit(script) {
  installShim("git", `echo "$1" >> "$GW_SPAWN_LOG"\n${script}`);
}
function resetSpawnLog() {
  fs.rmSync(spawnLog, { force: true });
}
function spawnCount() {
  try {
    return fs.readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

// Each ask of a hung git costs a whole timeout, and a directory listing asks once
// per entry. Remembering that git is hung, briefly, is what keeps N entries from
// blocking the daemon's single thread for N x timeout.
describe("a hung git is asked once, not once per path", () => {
  test("listing 20 entries against a hung git spawns git once and returns promptly", () => {
    resetSpawnLog();
    installCountedGit(`exec sleep 5`);
    const root = makeWorkspace();
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(root, `file-${i}.txt`), "x\n");
    const tools = new WorkspaceTools(root);

    const startedAt = Date.now();
    const listing = tools.listDirectory({ path: "." });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(spawnCount(), 1, "one probe timed out; the other 20 entries were denied without asking git");
    assert.deepEqual(listing.entries, [], "nothing is shown while git cannot vouch for it");
    // 21 entries x a 250ms timeout would be over 5s.
    assert.ok(elapsedMs < 2_000, `expected about one timeout, took ${elapsedMs}ms`);
  });

  test("a check-ignore that hangs is remembered too, across different paths", () => {
    resetSpawnLog();
    installCountedGit(`case "$1" in rev-parse) exit 0;; check-ignore) exec sleep 5;; *) exit 0;; esac`);
    const rules = new IgnoreRules({ root: makeWorkspace() });

    assert.equal(rules.isGitIgnored("a.txt"), true);
    assert.equal(rules.isGitIgnored("b.txt"), true);
    assert.equal(rules.isGitIgnored("c.txt"), true);
    // rev-parse once, check-ignore once (which timed out); b and c never asked.
    assert.equal(spawnCount(), 2);
    assert.match(rules.unknownReason, /did not answer in time/);
  });

  test("the memory is short: after the window git is asked again, and a recovered git works", async () => {
    resetSpawnLog();
    installCountedGit(`exec sleep 5`);
    const rules = new IgnoreRules({ root: makeWorkspace(), hungTtlMs: 100 });

    assert.equal(rules.isGitIgnored("notes.txt"), true);
    assert.equal(rules.isGitIgnored("notes.txt"), true);
    assert.equal(spawnCount(), 1, "the second call inside the window did not spawn");

    installCountedGit(`case "$1" in check-ignore) exit 1;; *) exit 0;; esac`); // git has recovered
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(rules.isGitIgnored("notes.txt"), false, "after the window, git is asked again and answers");
    assert.ok(spawnCount() > 1);
  });

  test("only a timeout is remembered: a fast failure is asked again every time", () => {
    // A quick failure costs nothing to repeat, and repeating it is what lets a
    // repaired repository work again immediately.
    resetSpawnLog();
    installCountedGit(`case "$1" in rev-parse) echo "fatal: detected dubious ownership in repository at '/x'" >&2; exit 128;; *) exit 0;; esac`);
    const rules = new IgnoreRules({ root: makeWorkspace() });

    assert.equal(rules.isGitIgnored("notes.txt"), true);
    assert.equal(rules.isGitIgnored("notes.txt"), true);
    assert.equal(spawnCount(), 2, "each call probed git again");
  });
});

describe("tool calls report a timeout instead of hanging or lying", () => {
  test("git_status / git_diff / git_log answer GIT_TIMEOUT", () => {
    installShim("git", GIT.hangEverything);
    const tools = new WorkspaceTools(makeWorkspace());

    for (const [name, result] of [
      ["git_status", tools.gitStatus()],
      ["git_diff", tools.gitDiff({})],
      ["git_log", tools.gitLog({})],
    ]) {
      assert.equal(result.error, "GIT_TIMEOUT", name);
      assert.match(result.message, /did not finish within 0\.25s/, name);
    }
  });

  test("git_status does not mistake a timeout for 'this is not a repository'", () => {
    installShim("git", GIT.hangEverything);
    const status = new WorkspaceTools(makeWorkspace()).gitStatus();

    assert.equal(status.isRepo, undefined);
    assert.equal(status.error, "GIT_TIMEOUT");
  });

  test("an ordinary git failure is unchanged: GIT_ERROR for diff/log, isRepo:false for status", () => {
    installShim("git", GIT.failsQuickly);
    const tools = new WorkspaceTools(makeWorkspace());

    assert.equal(tools.gitDiff({}).error, "GIT_ERROR");
    assert.equal(tools.gitLog({}).error, "GIT_ERROR");
    assert.deepEqual(tools.gitStatus(), { isRepo: false });
  });

  test("workspace_info reports an unknown repository state on a timeout, not 'not a repository'", () => {
    installShim("git", GIT.hangEverything);
    const info = new WorkspaceTools(makeWorkspace()).workspaceInfo();

    assert.equal(info.git.isRepo, null);
    assert.equal(info.git.error, "GIT_TIMEOUT");
    assert.equal(info.git.branch, null);
    assert.equal(info.repository, null);
  });

  test("workspace_info is unchanged for a git that simply fails: isRepo false", () => {
    installShim("git", GIT.failsQuickly);
    const info = new WorkspaceTools(makeWorkspace()).workspaceInfo();

    assert.deepEqual(info.git, { isRepo: false, branch: null, commit: null, dirty: false });
  });

  test("an rg whose --version probe hangs is treated as unavailable, and search falls back to git grep", async () => {
    // rgAvailable() caches its answer per module instance, so this uses a fresh
    // instance of tools.mjs whose first probe is the hanging one.
    installShim("rg", `exec sleep 5`);
    installShim("git", `case "$1" in check-ignore) exit 1;; grep) echo "notes.txt:1:plain notes"; exit 0;; *) exit 0;; esac`);
    const { WorkspaceTools: FreshTools } = await import("../bridge/tools.mjs?exec-timeouts-rg-probe");

    const startedAt = Date.now();
    const result = new FreshTools(makeWorkspace()).searchWorkspace({ query: "plain" });

    // Had the probe not timed out, rg (which hangs) would have been chosen and
    // this would be SEARCH_TIMEOUT instead of a served result.
    assert.equal(result.error, undefined);
    assert.deepEqual(result.hits.map((hit) => hit.path), ["notes.txt"]);
    assert.ok(Date.now() - startedAt < 4_000, "the hung probe is bounded by the time budget, not by sleep 5");
  });

  test("search_workspace answers SEARCH_TIMEOUT rather than returning partial output as complete", () => {
    installShim("git", GIT.notIgnored);
    installShim("rg", RG.hang);
    const result = new WorkspaceTools(makeWorkspace()).searchWorkspace({ query: "plain" });

    assert.equal(result.error, "SEARCH_TIMEOUT");
    assert.equal(result.hits, undefined, "no hits are reported for a search that did not finish");
  });

  test("hits printed before an abnormal exit are kept, but flagged as possibly incomplete", () => {
    // rg exits 2 when it found matches but could not read some paths. Dropping
    // those matches would be a regression; presenting them as the whole answer
    // would be a lie. So they are returned with an explicit marker.
    installShim("git", GIT.notIgnored);
    installShim("rg", RG.partial);
    const result = new WorkspaceTools(makeWorkspace()).searchWorkspace({ query: "plain" });

    assert.deepEqual(result.hits.map((hit) => hit.path), ["notes.txt"]);
    assert.equal(result.partial, true);
    assert.match(result.warning, /ended abnormally \(exit status 2\)/);
    assert.equal(result.error, undefined);
  });

  test("a search that fails outright (a malformed regex) is an error, not 'no matches'", () => {
    installShim("git", GIT.notIgnored);
    installShim("rg", RG.badRegex);
    const result = new WorkspaceTools(makeWorkspace()).searchWorkspace({ query: "(" });

    assert.equal(result.error, "SEARCH_FAILED");
    assert.match(result.message, /exit status 2/);
    assert.match(result.message, /regex parse error/);
    assert.equal(result.hits, undefined);
  });

  test("a fatal git grep (exit 128, no output) is SEARCH_FAILED rather than an empty result", async () => {
    installShim("rg", `exit 1`); // the --version probe fails: rg is unavailable, so git grep is used
    installShim("git", `case "$1" in check-ignore) exit 1;; grep) echo "fatal: not a git repository" >&2; exit 128;; *) exit 0;; esac`);
    const { WorkspaceTools: FreshTools } = await import("../bridge/tools.mjs?exec-timeouts-search-failed");
    const result = new FreshTools(makeWorkspace()).searchWorkspace({ query: "plain" });

    assert.equal(result.error, "SEARCH_FAILED");
    assert.match(result.message, /exit status 128/);
    assert.match(result.message, /not a git repository/);
  });

  test("a search with simply no matches is unchanged: an empty, complete result", () => {
    installShim("git", GIT.notIgnored);
    installShim("rg", RG.noMatches);
    const result = new WorkspaceTools(makeWorkspace()).searchWorkspace({ query: "absent" });

    assert.deepEqual(result.hits, []);
    assert.equal(result.error, undefined);
    assert.equal(result.partial, undefined);
    assert.equal(result.warning, undefined);
  });
});
