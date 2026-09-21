// workspace_bundle when something it depends on misbehaves. The rule under
// test: it never hands out an archive it could not vouch for. A scanner that
// fails, or whose report cannot be trusted, produces no archive; a secret that
// cannot be masked in place keeps its file out; git not answering is reported
// as an incomplete result rather than as an empty workspace.
//
// Kept in its own file because it puts fake `betterleaks` / `git` first on PATH
// for the whole process, and bridge/scanner.mjs caches which scanner it found.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-bundle-shim-"));
const originalPath = process.env.PATH;
process.env.PATH = `${shimDir}${path.delimiter}${originalPath}`;

// The fake scanner answers `version` (so it is detected), then behaves as
// SHIM_SCANNER says: fail, or write SHIM_REPORT to the requested report path.
fs.writeFileSync(
  path.join(shimDir, "betterleaks"),
  `#!/bin/sh
if [ "$1" = version ]; then echo 9.9.9; exit 0; fi
[ "$SHIM_SCANNER" = fail ] && exit 2
while [ $# -gt 0 ]; do
  if [ "$1" = "--report-path" ]; then rp="$2"; break; fi
  shift
done
printf '%s' "$SHIM_REPORT" > "$rp"
`,
  { mode: 0o755 }
);
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
fs.writeFileSync(
  path.join(shimDir, "git"),
  `#!/bin/sh
case "$SHIM_GIT" in
  fatal) case "$1" in rev-parse) exit 0;; check-ignore) exit 128;; *) exit 0;; esac;;
  *) exec ${realGit} "$@";;
esac
`,
  { mode: 0o755 }
);

const { WorkspaceTools } = await import("../bridge/tools.mjs?bundle-failclosed");
const { workspaceStateDir, bundleStagingDir } = await import("../bridge/state.mjs");

const dirsToClean = [shimDir];
after(() => {
  process.env.PATH = originalPath;
  delete process.env.SHIM_SCANNER;
  delete process.env.SHIM_REPORT;
  delete process.env.SHIM_GIT;
  for (const dir of dirsToClean) fs.rmSync(dir, { recursive: true, force: true });
});

function makeWorkspace(files = { "README.md": "# demo\n", "src/a.txt": "hello\n" }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gw-bundle-fc-")));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  dirsToClean.push(root, workspaceStateDir(root));
  return root;
}

const stagedRuns = (root) => fs.readdirSync(bundleStagingDir(root)).filter((n) => n.startsWith("run-"));

function withEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    process.env[key] = env[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

describe("workspace_bundle: a scanner that cannot be trusted produces no archive", () => {
  test("a scanner that fails", () => {
    const root = makeWorkspace();
    const result = withEnv({ SHIM_SCANNER: "fail" }, () => new WorkspaceTools(root).workspaceBundle());
    assert.equal(result.error, "BUNDLE_SCAN_FAILED");
    assert.equal(result.bundle, undefined);
    assert.deepEqual(stagedRuns(root), []);
  });

  test("a report that is not JSON", () => {
    const root = makeWorkspace();
    const result = withEnv({ SHIM_REPORT: "this is not json" }, () => new WorkspaceTools(root).workspaceBundle());
    assert.equal(result.error, "BUNDLE_SCAN_FAILED");
    assert.equal(result.bundle, undefined);
    assert.deepEqual(stagedRuns(root), []);
  });

  test("a report that is JSON but not a list", () => {
    const root = makeWorkspace();
    const result = withEnv({ SHIM_REPORT: '{"findings":[]}' }, () => new WorkspaceTools(root).workspaceBundle());
    assert.equal(result.error, "BUNDLE_SCAN_FAILED");
    assert.equal(result.bundle, undefined);
  });

  test("a report that names a file outside the scanned directory", () => {
    const root = makeWorkspace();
    const report = JSON.stringify([{ RuleID: "gw-test", Secret: "x-secret", File: "../../etc/passwd" }]);
    const result = withEnv({ SHIM_REPORT: report }, () => new WorkspaceTools(root).workspaceBundle());
    assert.equal(result.error, "BUNDLE_SCAN_FAILED");
    assert.equal(result.bundle, undefined);
  });

  test("a report that names a file that was never staged", () => {
    const root = makeWorkspace();
    const report = JSON.stringify([{ RuleID: "gw-test", Secret: "x-secret", File: "files/ghost.txt" }]);
    const result = withEnv({ SHIM_REPORT: report }, () => new WorkspaceTools(root).workspaceBundle());
    assert.equal(result.error, "BUNDLE_SCAN_FAILED");
    assert.equal(result.bundle, undefined);
    assert.deepEqual(stagedRuns(root), []);
  });

  test("an empty report is an ordinary clean scan", () => {
    const root = makeWorkspace();
    const result = withEnv({ SHIM_REPORT: "" }, () => new WorkspaceTools(root).workspaceBundle());
    assert.equal(result.error, undefined);
    assert.equal(result.filesReturned, 2);
    assert.equal(result.maskedSecrets, 0);
  });
});

describe("workspace_bundle: a finding that cannot be masked keeps its file out", () => {
  test("a secret not present verbatim in the file (found by decoding) withholds that file only", () => {
    const root = makeWorkspace();
    const report = JSON.stringify([{ RuleID: "gw-test", Secret: "decoded-value-not-in-text", File: "files/src/a.txt" }]);
    const result = withEnv({ SHIM_REPORT: report }, () => new WorkspaceTools(root).workspaceBundle());

    assert.equal(result.error, undefined);
    assert.equal(result.filesReturned, 1);
    assert.equal(result.skipped.withheld, 1);
    assert.equal(result.maskedSecrets, 0);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-bundle-fc-out-"));
    dirsToClean.push(dir);
    fs.writeFileSync(path.join(dir, "b.tgz"), Buffer.from(result.bundle.base64, "base64"));
    const entries = execFileSync("tar", ["-tzf", path.join(dir, "b.tgz")], { encoding: "utf8" });
    assert.equal(entries.includes("files/README.md"), true);
    assert.equal(entries.includes("files/src/a.txt"), false);
    execFileSync("tar", ["-xzf", path.join(dir, "b.tgz"), "-C", dir]);
    const slug = fs.readdirSync(dir).find((n) => n !== "b.tgz");
    assert.match(fs.readFileSync(path.join(dir, slug, "BUNDLE.md"), "utf8"), /Withheld[^\n]*: 1\n\s+- src\/a\.txt/);
  });

  test("when every file is withheld there is no archive", () => {
    const root = makeWorkspace({ "only.txt": "hello\n" });
    const report = JSON.stringify([{ RuleID: "gw-test", Secret: "not-in-text", File: "files/only.txt" }]);
    const result = withEnv({ SHIM_REPORT: report }, () => new WorkspaceTools(root).workspaceBundle());
    assert.equal(result.filesReturned, 0);
    assert.equal(result.bundle, undefined);
    assert.match(result.warning, /withheld/);
  });
});

describe("workspace_bundle: git not answering is an incomplete result, not an empty workspace", () => {
  test("every path is denied, and the result says why", () => {
    const root = makeWorkspace();
    fs.mkdirSync(path.join(root, ".git")); // a marker, so the directory cannot be assumed plain
    const result = withEnv({ SHIM_GIT: "fatal" }, () => new WorkspaceTools(root).workspaceBundle());
    assert.equal(result.bundle, undefined);
    assert.equal(result.filesReturned, 0);
    assert.equal(result.partial, true);
    assert.ok(result.hiddenByGitCheck > 0);
    assert.match(result.warning, /Git could not confirm/);
  });
});
