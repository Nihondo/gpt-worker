import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { IgnoreRules } from "../bridge/ignore.mjs";
import { hasGitAncestor } from "./helpers/git-ancestor.mjs";

// A temp dir is only a *plain* directory if nothing above it is a git checkout.
const TMP_IN_GIT = hasGitAncestor(os.tmpdir()) ? "TMPDIR is inside a git checkout, so a temp dir is not a plain directory" : false;

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

// Real git, no shims. A repository whose .git is damaged is the case a fake git
// cannot prove: git answers "not a git repository" for it, word for word as it
// does for a plain directory, so treating that message as "plain directory" made
// every gitignored file readable.
describe("IgnoreRules: real git, damaged and plain directories", () => {
  function makeRepo() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gw-real-git-")));
    git(root, ["init", "-q"]);
    fs.writeFileSync(path.join(root, ".gitignore"), "secret.txt\n");
    fs.writeFileSync(path.join(root, "secret.txt"), "hidden\n");
    return root;
  }

  test("a healthy repository ignores what .gitignore says", () => {
    const root = makeRepo();
    try {
      const rules = new IgnoreRules({ root });
      assert.equal(rules.isGitIgnored("secret.txt"), true);
      assert.equal(rules.isGitIgnored(".gitignore"), false);
      assert.equal(rules.unknownReason, null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a repository with a missing .git/HEAD is denied, not read as a plain directory", () => {
    const root = makeRepo();
    try {
      fs.renameSync(path.join(root, ".git", "HEAD"), path.join(root, ".git", "HEAD.bak"));
      // Precondition: real git really does call this "not a git repository".
      assert.throws(
        () => execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, stdio: "pipe", env: { ...process.env, LC_ALL: "C" } }),
        (err) => err.status === 128 && /not a git repository/.test(String(err.stderr))
      );

      const rules = new IgnoreRules({ root });
      assert.equal(rules.isGitIgnored("secret.txt"), true, "the gitignored file stays denied");
      assert.equal(rules.isGitIgnored(".gitignore"), true, "and so does everything else: git cannot vouch for any path");
      assert.equal(rules.isGitRepository, null);
      assert.match(rules.unknownReason, /damaged repository/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("repairing the repository restores normal behavior without restarting anything", () => {
    const root = makeRepo();
    try {
      const head = path.join(root, ".git", "HEAD");
      fs.renameSync(head, `${head}.bak`);
      const rules = new IgnoreRules({ root });
      assert.equal(rules.isGitIgnored(".gitignore"), true);

      fs.renameSync(`${head}.bak`, head);
      // isGitRepository was left unset, so the next call probes again.
      assert.equal(rules.isGitIgnored(".gitignore"), false);
      assert.equal(rules.isGitRepository, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a plain directory with no .git anywhere above it is still just a plain directory", { skip: TMP_IN_GIT }, () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gw-real-plain-")));
    try {
      fs.writeFileSync(path.join(root, "notes.txt"), "x\n");
      const rules = new IgnoreRules({ root });
      assert.equal(rules.isGitIgnored("notes.txt"), false);
      assert.equal(rules.isGitRepository, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// A daemon outlives `git init`. "Plain directory" used to be cached forever, so a
// workspace that became a repository after the daemon started kept exposing
// everything its .gitignore was written to hide, until the daemon was restarted.
describe("IgnoreRules: a plain workspace that later becomes a repository", { skip: TMP_IN_GIT }, () => {
  function makePlain() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gw-plain-to-git-")));
    fs.writeFileSync(path.join(root, "secret.txt"), "hidden\n");
    return root;
  }
  function initRepoIgnoringSecret(root) {
    git(root, ["init", "-q"]);
    fs.writeFileSync(path.join(root, ".gitignore"), "secret.txt\n");
  }

  test("the same instance starts honoring .gitignore once a .git appears", () => {
    const root = makePlain();
    try {
      const rules = new IgnoreRules({ root, plainRecheckMs: 0 });
      assert.equal(rules.isGitIgnored("secret.txt"), false, "plain: nothing is git-ignored yet");
      assert.equal(rules.isGitRepository, false);

      initRepoIgnoringSecret(root);

      assert.equal(rules.isGitIgnored("secret.txt"), true, "the long-lived instance notices the new repository");
      assert.equal(rules.isGitRepository, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("the re-check is bounded by an interval, not run on every path", () => {
    // Documents the trade-off: within the interval a fresh `git init` is not yet
    // seen. The interval is what keeps the lstat walk off the per-path hot path.
    const root = makePlain();
    try {
      const rules = new IgnoreRules({ root, plainRecheckMs: 60_000 });
      assert.equal(rules.isGitIgnored("secret.txt"), false);
      initRepoIgnoringSecret(root);
      assert.equal(rules.isGitIgnored("secret.txt"), false, "still inside the re-check interval");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// git does not walk up into a GIT_CEILING_DIRECTORIES entry. A `.git` above one
// is invisible to git, so it must be invisible to the damaged-repository check
// too, or a legitimately plain directory below a ceiling is denied.
describe("IgnoreRules: GIT_CEILING_DIRECTORIES", { skip: TMP_IN_GIT }, () => {
  test("an ancestor .git above a ceiling does not make a plain directory look damaged", () => {
    const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gw-ceiling-")));
    const saved = process.env.GIT_CEILING_DIRECTORIES;
    try {
      fs.mkdirSync(path.join(top, ".git")); // an (empty, hence invalid) .git above the workspace
      const work = path.join(top, "a", "b");
      fs.mkdirSync(work, { recursive: true });

      // No ceiling: git reaches the invalid .git and says "not a git repository",
      // and the marker contradicts it -> denied as a damaged repository.
      delete process.env.GIT_CEILING_DIRECTORIES;
      const noCeiling = new IgnoreRules({ root: work });
      assert.equal(noCeiling.isGitIgnored("f.txt"), true);
      assert.match(noCeiling.unknownReason, /damaged repository/);

      // Ceiling at `top`: git never looks at top/.git, so neither do we.
      process.env.GIT_CEILING_DIRECTORIES = top;
      const withCeiling = new IgnoreRules({ root: work });
      assert.equal(withCeiling.isGitIgnored("f.txt"), false);
      assert.equal(withCeiling.isGitRepository, false);
    } finally {
      if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = saved;
      fs.rmSync(top, { recursive: true, force: true });
    }
  });
});
