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
// grammar (anchored patterns, "**", etc.) is not needed and is intentionally
// not implemented, to keep this dependency-free.

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

export class IgnoreRules {
  constructor() {
    this.sensitive = SENSITIVE_PATTERNS.map(compilePattern);
    this.noise = NOISE_PATTERNS.map(compilePattern);
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
}
