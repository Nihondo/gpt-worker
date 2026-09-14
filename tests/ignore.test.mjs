import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { IgnoreRules } from "../bridge/ignore.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

describe("IgnoreRules: sensitive files are always denied", () => {
  const rules = new IgnoreRules();
  for (const p of [
    ".env",
    ".env.local",
    "id_rsa",
    "id_ed25519.pub",
    ".ssh/config",
    ".ssh/authorized_keys",
    ".aws/credentials",
    ".npmrc",
    ".netrc",
    ".git-credentials",
    "server.pem",
    "service-account-1234.json",
    "secrets.json",
    "cookies.sqlite",
    ".gpt-worker/config.json",
    "nested/deep/.env",
    "nested/deep/.ssh/id_rsa",
  ]) {
    test(`denies ${p}`, () => {
      assert.equal(rules.isSensitive(p), true);
    });
  }

  test("does not deny the documented example exception", () => {
    assert.equal(rules.isSensitive(".env.example"), false);
  });

  test("does not deny ordinary source files", () => {
    for (const p of ["src/index.js", "README.md", "package.json", "a/b/c.ts"]) {
      assert.equal(rules.isSensitive(p), false);
    }
  });
});

describe("IgnoreRules: noise is hidden from listing but distinct from sensitive", () => {
  const rules = new IgnoreRules();
  test("node_modules/.git are noise, not sensitive", () => {
    assert.equal(rules.isNoise("node_modules/react/index.js"), true);
    assert.equal(rules.isSensitive("node_modules/react/index.js"), false);
    assert.equal(rules.isNoise(".git/HEAD"), true);
  });
  test("isHidden is the union of both", () => {
    assert.equal(rules.isHidden(".env"), true);
    assert.equal(rules.isHidden("node_modules/x"), true);
    assert.equal(rules.isHidden("src/index.js"), false);
  });
});

describe("IgnoreRules: Git determines ignored paths", () => {
  test("uses nested rules, negation and configured excludes without a partial parser", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gw-ignore-"));
    try {
      git(root, ["init", "-q"]);
      fs.mkdirSync(path.join(root, "nested"), { recursive: true });
      fs.mkdirSync(path.join(root, "deep", "cache"), { recursive: true });
      fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n/root-only\n**/cache/\n!keep.txt\n");
      fs.writeFileSync(path.join(root, "nested", ".gitignore"), "*.tmp\n");
      fs.writeFileSync(path.join(root, "ignored.txt"), "ignored\n");
      fs.writeFileSync(path.join(root, "root-only"), "ignored\n");
      fs.writeFileSync(path.join(root, "nested", "note.tmp"), "ignored\n");
      fs.writeFileSync(path.join(root, "deep", "cache", "entry.js"), "ignored\n");
      fs.writeFileSync(path.join(root, "keep.txt"), "kept\n");
      const excludes = path.join(root, "user-excludes");
      fs.writeFileSync(excludes, "from-user-excludes\n");
      fs.writeFileSync(path.join(root, "from-user-excludes"), "ignored\n");
      git(root, ["config", "core.excludesFile", excludes]);

      const rules = new IgnoreRules({ root });
      for (const relPath of ["ignored.txt", "root-only", "nested/note.tmp", "deep/cache/entry.js", "from-user-excludes"]) {
        assert.equal(rules.isGitIgnored(relPath), true, relPath);
      }
      assert.equal(rules.isGitIgnored("keep.txt"), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not enforce .gitignore outside a Git workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gw-non-git-ignore-"));
    try {
      fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n");
      fs.writeFileSync(path.join(root, "ignored.txt"), "still readable\n");
      assert.equal(new IgnoreRules({ root }).isGitIgnored("ignored.txt"), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
