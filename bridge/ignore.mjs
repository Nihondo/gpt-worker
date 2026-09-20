// Sensitive/noise path filtering for workspace reads.
//
// SENSITIVE_PATTERNS and NOISE_PATTERNS below are copied verbatim from
// https://github.com/XiaoDuoYa/codex-with-chatgpt (MIT), src/workspace/ignore.ts,
// with one addition (.gpt-worker/, this tool's own state directory).
// Files matching SENSITIVE are always denied, regardless of .gitignore.
// Files matching NOISE are hidden from listing/search but not an error to read directly.
//
// Implementation note: none of the patterns below contain an internal slash
// (only an optional trailing slash marking "directory anywhere in the path"),
// so a small basename/dirname matcher is sufficient here — the full gitignore
// grammar (anchored patterns, "**", etc.) is not needed for these static
// patterns. Git ignore rules are evaluated separately by Git itself below.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gitCheckTimeoutMs, isExecTimeout } from "./exec-limits.mjs";

export const SENSITIVE_PATTERNS = [
  ".env",
  ".env.*",
  "!.env.example",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "id_rsa",
  "id_rsa.*",
  "id_ed25519",
  "id_ed25519.*",
  "id_ecdsa",
  "id_ecdsa.*",
  "id_dsa",
  "id_dsa.*",
  ".ssh/",
  ".aws/",
  ".gnupg/",
  ".npmrc",
  ".netrc",
  "_netrc",
  ".git-credentials",
  "*.keychain",
  "*.keychain-db",
  ".cloudflared/",
  "credentials.json",
  "service-account*.json",
  "secrets.json",
  "cookies.sqlite",
  "Cookies",
  ".gpt-worker/",
];

export const NOISE_PATTERNS = [
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  "coverage/",
  ".cache/",
  ".turbo/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".pytest_cache/",
  ".mypy_cache/",
  "target/",
  ".gradle/",
  ".idea/",
  ".tooling/",
  ".pnpm-store/",
  ".DS_Store",
  "*.lock",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
];

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/;

function globToRegExp(glob) {
  let out = "";
  for (const ch of glob) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else if (REGEX_SPECIAL.test(ch)) out += "\\" + ch;
    else out += ch;
  }
  return new RegExp(`^${out}$`);
}

function compilePattern(raw) {
  let p = raw;
  let negate = false;
  if (p.startsWith("!")) {
    negate = true;
    p = p.slice(1);
  }
  let dirOnly = false;
  if (p.endsWith("/")) {
    dirOnly = true;
    p = p.slice(0, -1);
  }
  return { re: globToRegExp(p), negate, dirOnly };
}

function testPath(compiled, relPath, isDir) {
  const segments = relPath.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  let result = false;
  for (const c of compiled) {
    if (c.dirOnly) {
      // Directory-only pattern: match against any *directory* segment — every
      // segment except the last, plus the last one too when it is itself a dir.
      const dirSegCount = isDir ? segments.length : segments.length - 1;
      for (let i = 0; i < dirSegCount; i++) {
        if (c.re.test(segments[i])) {
          result = !c.negate;
          break;
        }
      }
    } else {
      for (const seg of segments) {
        if (c.re.test(seg)) {
          result = !c.negate;
          break;
        }
      }
    }
  }
  return result;
}

/** True only when `git rev-parse` ran and reported that the directory is not
 *  inside a repository (exit 128 with git's "not a git repository" message, run
 *  with LC_ALL=C so the wording is stable). Every other failure of that probe is
 *  deliberately NOT this — see isGitIgnored(). */
function isNotAGitRepository(err) {
  return !!err && err.status === 128 && /not a git repository/i.test(String(err.stderr || ""));
}

/** True when `dir` or any ancestor has a `.git` entry (directory, or the file a
 *  worktree/submodule uses). Used only to catch a repository that is present but
 *  damaged: for one, git says "not a git repository" exactly as it does for a
 *  plain directory (verified with a real git and a missing .git/HEAD), so the
 *  message alone cannot tell the two apart. */
function hasGitMarker(dir) {
  // git does not walk up into a GIT_CEILING_DIRECTORIES entry, so a `.git` at or
  // above one is invisible to it. Matching that keeps a legitimately plain
  // directory below a ceiling from being taken for a damaged repository. (Git's
  // other boundary — a change of filesystem — is not reproduced: there the
  // error is on the deny side, which costs availability, not safety.)
  const ceilings = new Set(
    String(process.env.GIT_CEILING_DIRECTORIES || "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((entry) => path.resolve(entry))
  );
  let current = path.resolve(dir);
  for (;;) {
    try {
      fs.lstatSync(path.join(current, ".git"));
      return true;
    } catch {
      /* no marker here */
    }
    const parent = path.dirname(current);
    if (parent === current || ceilings.has(parent)) return false;
    current = parent;
  }
}

// How long a workspace once seen as plain is trusted to still be plain. A
// long-lived daemon outlives `git init`, so "plain" cannot be cached forever.
const PLAIN_RECHECK_MS = 1_000;
// How long, after git failed to answer in time, further paths are denied without
// asking git again. Each ask costs a full timeout, and a directory listing asks
// once per entry: without this, N entries against a hung git block the daemon
// for N x timeout.
const HUNG_GIT_TTL_MS = 10_000;

/** One line saying why git could not give an answer, for the denial message. */
function describeGitFailure(err) {
  if (isExecTimeout(err)) return "git did not answer in time";
  if (err && typeof err.status === "number") {
    const firstLine = String(err.stderr || "").split("\n")[0].trim();
    return `git exited with status ${err.status}${firstLine ? `: ${firstLine}` : ""}`;
  }
  return "git could not be run";
}

export class IgnoreRules {
  /** `plainRecheckMs` and `hungTtlMs` exist so tests can exercise the two time
   *  windows in milliseconds; production uses the defaults. */
  constructor({ root = null, plainRecheckMs = PLAIN_RECHECK_MS, hungTtlMs = HUNG_GIT_TTL_MS } = {}) {
    this.sensitive = SENSITIVE_PATTERNS.map(compilePattern);
    this.noise = NOISE_PATTERNS.map(compilePattern);
    this.root = root;
    this.isGitRepository = null;
    this.plainRecheckMs = plainRecheckMs;
    this.plainCheckedAt = 0;
    this.hungTtlMs = hungTtlMs;
    this.hungUntil = 0;
    this.hungReason = null;
    // Why the last isGitIgnored() call denied *without* a definite answer from
    // git (null when it got one). Lets a denial say "git could not confirm"
    // instead of looking like the file is simply gitignored.
    this.unknownReason = null;
  }

  /** True when the path must be denied with ACCESS_DENIED_SENSITIVE_FILE. */
  isSensitive(relPath, isDir = false) {
    if (!relPath || relPath === ".") return false;
    return testPath(this.sensitive, relPath, isDir);
  }

  /** True when the path should be hidden from listing/search (not an error). */
  isNoise(relPath, isDir = false) {
    if (!relPath || relPath === ".") return false;
    return testPath(this.noise, relPath, isDir);
  }

  isHidden(relPath, isDir = false) {
    return this.isSensitive(relPath, isDir) || this.isNoise(relPath, isDir);
  }

  /** True when Git itself classifies this workspace-relative path as ignored.
   *  Delegating to `git check-ignore` preserves Git's complete syntax
   *  (including nested files, negation and user excludes) without adding a
   *  partial parser or a runtime dependency. Non-Git workspaces retain the
   *  previous static-filter behavior. */
  isGitIgnored(relPath) {
    this.unknownReason = null;
    if (!this.root || !relPath || relPath === ".") return false;
    const now = Date.now();
    // Git recently failed to answer in time: deny without asking again (see
    // HUNG_GIT_TTL_MS). Only a *timeout* is remembered this way — a fast failure
    // (dubious ownership, a damaged repo) costs nothing to re-ask, and re-asking
    // is what lets a repaired repository work again immediately.
    if (now < this.hungUntil) {
      this.unknownReason = this.hungReason;
      return true;
    }
    // "Plain directory" is a verdict about a moment, not forever: the daemon
    // outlives `git init`, after which .gitignore must start to apply. A `.git`
    // appearing is enough to make us ask git again (a cheap lstat walk, done at
    // most once per interval).
    if (this.isGitRepository === false && now - this.plainCheckedAt >= this.plainRecheckMs) {
      this.plainCheckedAt = now;
      if (hasGitMarker(this.root)) this.isGitRepository = null;
    }
    if (this.isGitRepository === null) {
      try {
        execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
          cwd: this.root,
          // stderr is captured because it is what tells "this is not a
          // repository" apart from every other way this probe can fail.
          stdio: ["ignore", "ignore", "pipe"],
          // Git localizes its messages; the check below matches English text.
          env: { ...process.env, LC_ALL: "C" },
          timeout: gitCheckTimeoutMs(),
        });
        this.isGitRepository = true;
      } catch (err) {
        // Only a probe that ran and said "not a git repository" — and where no
        // `.git` entry exists to contradict it — means this is a plain
        // directory, where the static filters are the whole story. Anything
        // else is "unknown": a timeout, a missing or unrunnable git, a
        // repository git refuses to open (dubious ownership), or a `.git` that
        // is present but damaged, which git reports with the very same words as
        // a plain directory. Concluding "not a repository" from any of those
        // would switch the whole gitignore check off for every path, so deny
        // this one and leave the flag unset: the next call probes again.
        if (isExecTimeout(err)) return this.markGitHung(err);
        if (!isNotAGitRepository(err)) {
          this.unknownReason = describeGitFailure(err);
          return true;
        }
        if (hasGitMarker(this.root)) {
          this.unknownReason = "a .git entry exists but git says this is not a repository (damaged repository?)";
          return true;
        }
        this.isGitRepository = false;
        this.plainCheckedAt = now;
      }
    }
    if (!this.isGitRepository) return false;
    try {
      execFileSync("git", ["check-ignore", "-q", "--", relPath], {
        cwd: this.root,
        stdio: ["ignore", "ignore", "ignore"],
        timeout: gitCheckTimeoutMs(),
      });
      return true; // exit 0: ignored
    } catch (err) {
      // Exit 1 is the *only* answer that means "not ignored". This is an access
      // control, so every other outcome — a timeout, exit 128 (git could not
      // decide: a broken .git, dubious ownership, a path beyond a symlink), a
      // git that cannot be run at all — fails CLOSED: the path stays hidden
      // until a check completes. Reading "git did not answer" as "not ignored"
      // would expose a gitignored file exactly when git is misbehaving.
      if (err && err.status === 1) return false;
      if (isExecTimeout(err)) return this.markGitHung(err);
      this.unknownReason = describeGitFailure(err);
      return true;
    }
  }

  /** Records that git did not answer in time and denies. See HUNG_GIT_TTL_MS. */
  markGitHung(err) {
    this.hungReason = describeGitFailure(err);
    this.hungUntil = Date.now() + this.hungTtlMs;
    this.unknownReason = this.hungReason;
    return true;
  }
}
