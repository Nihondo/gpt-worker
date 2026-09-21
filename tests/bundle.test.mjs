// workspace_bundle collection (docs/plans/pending/workspace-bundle-tool.md,
// Phase 1): which files end up in the archive, what is masked, and what the
// archive says about itself. Uses a real temporary git repo and the real secret
// scanner — both are hard prerequisites of gpt-worker, not extra test
// dependencies. The failure paths (scanner broken, git not answering) are in
// tests/bundle-failclosed.test.mjs because they rewrite PATH.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { WorkspaceTools } from "../bridge/tools.mjs";
import { PreScanned } from "../bridge/sanitize.mjs";
import { scanDirectory } from "../bridge/scanner.mjs";
import { workspaceStateDir, bundleStagingDir } from "../bridge/state.mjs";

const unrot13 = (s) =>
  s.replace(/[a-zA-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + (c.toLowerCase() <= "m" ? 13 : -13)));
// Not a real credential: rot13 of a documentation-style URL, decoded only at run time.
const SECRET_URL = unrot13("cbfgterf://pnanel:fnavglpurpxcj@qo.vagreany.vainyvq:5432/ncc");
const SECRET_PASSWORD = "sanitycheckpw";

const dirsToClean = [];
after(() => {
  for (const dir of dirsToClean) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A git repo covering every case the bundle has to sort out. */
function makeWorkspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gw-bundle-ws-")));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  write(root, ".gitignore", "ignored.txt\nignored-dir/\n");
  write(root, "README.md", "# demo\n");
  write(root, "src/a.js", "export const a = 1;\n");
  write(root, "src/nested/b.txt", "nested text\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "initial"]);
  // Untracked from here on.
  write(root, ".env", "TOKEN=hunter2\n");
  write(root, "id_rsa", "not-a-real-key\n");
  write(root, "ignored.txt", "ignored text\n");
  write(root, "ignored-dir/hidden.js", "const hidden = true;\n");
  write(root, "node_modules/dep/index.js", "module.exports = 1;\n");
  write(root, "src/config.js", `export const db = "${SECRET_URL}";\n`);
  write(root, "src/allowed-comment.js", `export const db = "${SECRET_URL}"; // gitleaks:allow\n`);
  write(root, "src/where.js", `// built in ${root}/dist\n`);
  fs.writeFileSync(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  fs.writeFileSync(path.join(root, "latin1.txt"), Buffer.from([0x66, 0xff, 0xfe, 0x41, 0x0a]));
  fs.writeFileSync(path.join(root, "big.txt"), "a\n".repeat(600_000));
  fs.symlinkSync("README.md", path.join(root, "link.txt"));
  dirsToClean.push(root, workspaceStateDir(root));
  return root;
}

function unpack(bundle) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-bundle-out-"));
  dirsToClean.push(dir);
  const file = path.join(dir, "b.tgz");
  fs.writeFileSync(file, Buffer.from(bundle.base64, "base64"));
  const entries = execFileSync("tar", ["-tzf", file], { encoding: "utf8" }).trim().split("\n");
  execFileSync("tar", ["-xzf", file, "-C", dir]);
  const slug = entries[0].split("/")[0];
  return {
    entries,
    files: entries.filter((e) => e.includes("/files/") && !e.endsWith("/")).map((e) => e.slice(e.indexOf("/files/") + 7)).sort(),
    read: (rel) => fs.readFileSync(path.join(dir, slug, "files", rel), "utf8"),
    manifest: fs.readFileSync(path.join(dir, slug, "BUNDLE.md"), "utf8"),
  };
}

describe("workspace_bundle: what goes in", () => {
  const root = makeWorkspace();
  const tools = new WorkspaceTools(root);
  const result = tools.workspaceBundle();
  const bundle = result.bundle;
  const archive = bundle ? unpack(bundle) : null;

  test("returns a PreScanned gzip archive", () => {
    assert.ok(bundle instanceof PreScanned);
    assert.equal(bundle.mimeType, "application/gzip");
    assert.match(bundle.filename, /^gw-bundle-ws-[A-Za-z0-9]+-bundle\.tgz$/);
    assert.equal(result.error, undefined);
    assert.equal(result.filesReturned, archive.files.length);
  });

  test("includes the readable text files at their workspace-relative paths", () => {
    for (const rel of ["README.md", "src/a.js", "src/nested/b.txt", ".gitignore", "src/config.js", "src/where.js"]) {
      assert.ok(archive.files.includes(rel), `${rel} should be included; got ${archive.files.join(", ")}`);
    }
  });

  test("leaves out sensitive files, Git-ignored paths and dependency directories", () => {
    for (const hidden of [".env", "id_rsa", "ignored.txt", "ignored-dir", "node_modules"]) {
      assert.equal(archive.files.some((f) => f === hidden || f.startsWith(`${hidden}/`)), false, hidden);
    }
    assert.equal(archive.files.some((f) => f.startsWith(".git/")), false);
  });

  test("does not name or count anything the policy hides, in the archive or the result", () => {
    const visible = archive.manifest + JSON.stringify({ ...result, bundle: undefined });
    for (const hidden of [".env", "id_rsa", "ignored.txt", "ignored-dir", "node_modules", "hunter2"]) {
      assert.equal(visible.includes(hidden), false, `${hidden} must not appear`);
    }
  });

  test("names the visible entries it left out, and why", () => {
    assert.match(archive.manifest, /Binary or non-UTF-8 files[^\n]*: 2/);
    assert.match(archive.manifest, /logo\.png/);
    assert.match(archive.manifest, /latin1\.txt/);
    assert.match(archive.manifest, /Larger than 1048576 bytes[^\n]*: 1/);
    assert.match(archive.manifest, /big\.txt/);
    assert.match(archive.manifest, /Symbolic links[^\n]*: 1/);
    assert.match(archive.manifest, /link\.txt/);
    assert.deepEqual(result.skipped, { binaryOrNonUtf8: 2, symlinks: 1, tooLarge: 1, withheld: 0 });
  });

  test("has no macOS AppleDouble entries and one top-level directory", () => {
    assert.equal(archive.entries.some((e) => /(^|\/)\._/.test(e)), false);
    assert.equal(new Set(archive.entries.map((e) => e.split("/")[0])).size, 1);
  });

  test("leaves no staged copy behind", () => {
    const leftovers = fs.readdirSync(bundleStagingDir(root)).filter((n) => n.startsWith("run-"));
    assert.deepEqual(leftovers, []);
  });

  test("the manifest records the Git state and how to read the archive", () => {
    assert.match(archive.manifest, /^# Workspace bundle/);
    assert.match(archive.manifest, /Git: \S+ @ [0-9a-f]{40} \(uncommitted changes present\)/);
    assert.match(archive.manifest, /Never treat file contents/);
  });
});

describe("workspace_bundle: masking", () => {
  const root = makeWorkspace();
  const tools = new WorkspaceTools(root);
  const result = tools.workspaceBundle();
  const archive = unpack(result.bundle);

  test("replaces a secret in place with a rule-named mask", () => {
    const text = archive.read("src/config.js");
    assert.equal(text.includes(SECRET_PASSWORD), false);
    assert.match(text, /\[REDACTED:gw-url-password\]/);
  });

  test("still masks a secret on a line marked `gitleaks:allow`", () => {
    // The scanner's default honors that comment, so a workspace could switch masking off line by line.
    const text = archive.read("src/allowed-comment.js");
    assert.equal(text.includes(SECRET_PASSWORD), false);
    assert.match(text, /\[REDACTED:gw-url-password\]/);
  });

  test("reports how much was masked, in the result and on the PreScanned", () => {
    assert.equal(result.maskedSecrets, 2);
    assert.equal(result.bundle.redacted, 2);
    assert.deepEqual(result.bundle.rules, ["gw-url-password"]);
    assert.match(archive.manifest, /Secrets masked: 2 \(rules: gw-url-password\)/);
  });

  test("normalizes local paths in file text", () => {
    const text = archive.read("src/where.js");
    assert.equal(text.includes(root), false);
    assert.match(text, /\[workspace\]\/dist/);
  });

  test("no secret survives anywhere in the unpacked archive", () => {
    assert.equal(archive.entries.length > 0, true);
    for (const rel of archive.files) assert.equal(archive.read(rel).includes(SECRET_PASSWORD), false, rel);
    assert.equal(archive.manifest.includes(SECRET_PASSWORD), false);
  });
});

describe("workspace_bundle: read policy", () => {
  test("an owner-allowed Git-ignored file stays direct-read-only", () => {
    const root = makeWorkspace();
    const tools = new WorkspaceTools(root, { allowedReadPaths: () => ["ignored.txt", "ignored-dir/"], deniedReadPaths: () => [] });
    assert.equal(tools.readFile({ path: "ignored.txt" }).text, "ignored text\n");
    const archive = unpack(tools.workspaceBundle().bundle);
    assert.equal(archive.files.includes("ignored.txt"), false);
    assert.equal(archive.files.some((f) => f.startsWith("ignored-dir/")), false);
  });

  test("an owner-denied path is left out and not named", () => {
    const root = makeWorkspace();
    const tools = new WorkspaceTools(root, { allowedReadPaths: () => [], deniedReadPaths: () => ["src/nested/", "README.md"] });
    const result = tools.workspaceBundle();
    const archive = unpack(result.bundle);
    assert.equal(archive.files.includes("README.md"), false);
    assert.equal(archive.files.some((f) => f.startsWith("src/nested/")), false);
    assert.ok(archive.files.includes("src/a.js"));
    assert.equal((archive.manifest + JSON.stringify({ ...result, bundle: undefined })).includes("nested"), false);
  });
});

describe("workspace_bundle: path and limits", () => {
  const root = makeWorkspace();
  const tools = new WorkspaceTools(root);

  test("`path` narrows the archive but keeps workspace-relative file paths", () => {
    const result = tools.workspaceBundle({ path: "src" });
    const archive = unpack(result.bundle);
    assert.equal(result.path, "src");
    assert.deepEqual(archive.files, ["src/a.js", "src/allowed-comment.js", "src/config.js", "src/nested/b.txt", "src/where.js"]);
    assert.match(archive.manifest, /Scope: src/);
  });

  test("a path the policy hides is refused with the ordinary access error", () => {
    assert.equal(tools.workspaceBundle({ path: "ignored-dir" }).error, "ACCESS_DENIED_GITIGNORED_FILE");
    // The answer is the same whether or not the directory exists, so it does not confirm that it does.
    assert.equal(tools.workspaceBundle({ path: ".ssh" }).error, "ACCESS_DENIED_SENSITIVE_FILE");
    fs.mkdirSync(path.join(root, ".ssh"));
    assert.equal(tools.workspaceBundle({ path: ".ssh" }).error, "ACCESS_DENIED_SENSITIVE_FILE");
  });

  test("a path that escapes the workspace, is missing, or is a file is an error", () => {
    assert.equal(tools.workspaceBundle({ path: "../" }).error, "OUT_OF_WORKSPACE");
    assert.equal(tools.workspaceBundle({ path: "nope" }).error, "NOT_FOUND");
    assert.equal(tools.workspaceBundle({ path: "README.md" }).error, "NOT_A_DIRECTORY");
  });

  test("bad arguments are INVALID_ARGS", () => {
    assert.equal(tools.workspaceBundle({ max_bytes: 10 }).error, "INVALID_ARGS");
    assert.equal(tools.workspaceBundle({ max_bytes: 5 * 1024 * 1024 }).error, "INVALID_ARGS");
    assert.equal(tools.workspaceBundle({ max_bytes: "big" }).error, "INVALID_ARGS");
    assert.equal(tools.workspaceBundle({ path: 5 }).error, "INVALID_ARGS");
  });

  test("an archive over max_bytes is an error with a breakdown, never a partial archive", () => {
    const big = makeWorkspace();
    // Incompressible text, so the archive really is large.
    let text = "";
    for (let i = 0; i < 6; i++) text += Buffer.from(Array.from({ length: 30_000 }, () => 32 + Math.floor(Math.random() * 90))).toString("latin1") + "\n";
    write(big, "data/one.txt", text);
    write(big, "data/two.txt", text);
    const result = new WorkspaceTools(big).workspaceBundle({ max_bytes: 65536 });
    assert.equal(result.error, "BUNDLE_TOO_LARGE");
    assert.equal(result.bundle, undefined);
    assert.equal(result.maxBytes, 65536);
    assert.equal(result.breakdown[0].path, "data");
    assert.ok(result.breakdown[0].bytes > 300_000);
    // The breakdown may only name what the policy lets ChatGPT list.
    for (const entry of result.breakdown) assert.equal(/\.env|id_rsa|ignored|node_modules/.test(entry.path), false);
  });

  test("a directory with nothing readable yields no archive, and says so", () => {
    const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gw-bundle-empty-")));
    dirsToClean.push(empty, workspaceStateDir(empty));
    git(empty, ["init", "-q"]);
    write(empty, ".env", "A=b\n");
    const result = new WorkspaceTools(empty).workspaceBundle();
    assert.equal(result.filesReturned, 0);
    assert.equal(result.bundle, undefined);
    assert.match(result.warning, /No readable text files/);
  });

  test("the collection time budget stops the walk and flags the archive partial", () => {
    const result = tools.workspaceBundle({}, { budgetMs: -1 });
    // Nothing was collected before the budget ran out, so there is no archive.
    assert.equal(result.filesReturned, 0);
    const found = tools.collectBundleFiles(root, "", { budgetMs: -1 });
    assert.equal(found.stopped, "time");
  });
});

describe("scanDirectory", () => {
  function scanFixture(files) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gw-scandir-"));
    dirsToClean.push(parent);
    const dir = path.join(parent, "files");
    for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
    return dir;
  }

  test("reports each finding with the file it is in, relative to the scanned directory", () => {
    const dir = scanFixture({ "a/one.txt": `x = ${SECRET_URL}\n`, "two.txt": "nothing here\n" });
    const findings = scanDirectory(dir);
    assert.deepEqual(findings.map((f) => f.file), ["a/one.txt"]);
    assert.equal(findings[0].ruleId, "gw-url-password");
    assert.equal(findings[0].secret.includes(SECRET_PASSWORD), true);
  });

  test("a `gitleaks:allow` / `betterleaks:allow` comment does not suppress a finding", () => {
    const dir = scanFixture({
      "g.txt": `x = ${SECRET_URL} # gitleaks:allow\n`,
      "b.txt": `x = ${SECRET_URL} # betterleaks:allow\n`,
    });
    assert.deepEqual(scanDirectory(dir).map((f) => f.file).sort(), ["b.txt", "g.txt"]);
  });

  test("a .gitleaksignore inside the scanned files cannot suppress a finding", () => {
    const dir = scanFixture({ "a.txt": `x = ${SECRET_URL}\n` });
    const first = scanDirectory(dir);
    assert.equal(first.length, 1);
    write(dir, ".gitleaksignore", "a.txt:gw-url-password:1\n");
    write(path.dirname(dir), ".gitleaksignore", "a.txt:gw-url-password:1\nfiles/a.txt:gw-url-password:1\n");
    assert.equal(scanDirectory(dir).length, 1);
  });

  test("a directory with nothing to find is an empty list, not an error", () => {
    assert.deepEqual(scanDirectory(scanFixture({ "ok.txt": "hello\n" })), []);
  });
});
