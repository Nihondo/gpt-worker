// Secret detection via an external scanner binary (betterleaks, or gitleaks
// as a compatible fallback — see bridge/leaks.toml). This is the only
// secret-detection logic gpt-worker has: no regex-based detection is
// maintained in this codebase (see bridge/sanitize.mjs, which only replaces
// and normalizes text this module has already found).
//
// This is a required dependency, not an optional one: every function here
// fails closed. detectScanner() returning null, scanText() throwing, or
// verifyScanner() throwing must never cause a caller to fall back to
// returning unscanned text — bridge/link.mjs's reply() relies on that.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bundleScanTimeoutMs } from "./exec-limits.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = path.join(HERE, "leaks.toml");

const SCAN_TIMEOUT_MS = 2000;

// betterleaks is checked first: it is the actively maintained successor and
// scored equal-or-better in every measured dimension during evaluation
// (recall, false positives, latency). gitleaks is kept as a compatible
// fallback — both accept the same --config file and JSON report shape.
const CANDIDATES = ["betterleaks", "gitleaks"];

let cached; // undefined = not probed yet, null = probed and unavailable

function binVersion(bin) {
  try {
    return execFileSync(bin, ["version"], { encoding: "utf8", timeout: SCAN_TIMEOUT_MS }).trim();
  } catch {
    return null;
  }
}

/** Finds the first available scanner binary on PATH. Cached for the process
 *  lifetime — like tools.mjs's rgAvailable(), a bridge daemon doesn't expect
 *  PATH to change while it runs. Call resetScannerCache() in tests. */
export function detectScanner() {
  if (cached !== undefined) return cached;
  for (const bin of CANDIDATES) {
    const version = binVersion(bin);
    if (version !== null) {
      cached = { bin, kind: bin, version };
      return cached;
    }
  }
  cached = null;
  return cached;
}

export function resetScannerCache() {
  cached = undefined;
}

/** Runs the scanner over `text` via its `stdin` subcommand and returns raw
 *  findings as [{ ruleId, secret }]. Throws on any failure — missing binary,
 *  non-zero exit despite --exit-code 0, a malformed report, or a timeout —
 *  so a caller can never mistake a failed scan for "nothing found". */
export function scanText(text) {
  const scanner = detectScanner();
  if (!scanner) {
    throw new Error("No secret scanner available (install betterleaks or gitleaks).");
  }
  const reportPath = path.join(os.tmpdir(), `gpt-worker-scan-${process.pid}-${crypto.randomBytes(8).toString("hex")}.json`);
  try {
    fs.writeFileSync(reportPath, "", { mode: 0o600 });
    try {
      // --exit-code 0 is required: both engines exit non-zero by default when
      // findings are present, which execFileSync would otherwise throw on.
      execFileSync(
        scanner.bin,
        ["stdin", "--config", CONFIG_PATH, "--report-format", "json", "--report-path", reportPath, "--no-banner", "--exit-code", "0"],
        { input: text, timeout: SCAN_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "ignore", "ignore"] }
      );
    } catch (err) {
      throw new Error(`Secret scan failed (${scanner.bin}): ${err.message || err}`);
    }
    let raw;
    try {
      raw = fs.readFileSync(reportPath, "utf8");
    } catch (err) {
      throw new Error(`Secret scan report missing (${scanner.bin}): ${err.message || err}`);
    }
    if (!raw.trim()) return [];
    let findings;
    try {
      findings = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Secret scan report unparsable (${scanner.bin}): ${err.message || err}`);
    }
    if (!Array.isArray(findings)) {
      throw new Error(`Secret scan report was not a list (${scanner.bin}).`);
    }
    return findings
      .map((f) => ({ ruleId: String(f.RuleID || ""), secret: String(f.Secret || "") }))
      .filter((f) => f.ruleId && f.secret);
  } finally {
    try {
      fs.unlinkSync(reportPath);
    } catch {
      /* best-effort cleanup */
    }
  }
}

/** Scans a directory of files (one scanner run for all of them) and returns
 *  raw findings as [{ file, ruleId, secret }], `file` being relative to `dir`
 *  with forward slashes. Throws on any failure, exactly like scanText(): a
 *  caller must never mistake a failed scan for "nothing found".
 *
 *  Two flags matter because the scanned files are untrusted workspace content:
 *  `--ignore-gitleaks-allow` stops a `gitleaks:allow` / `betterleaks:allow`
 *  comment on a line from suppressing the finding on it (measured: with the
 *  default, such a line is reported as clean), and the ignore-file lookup is
 *  pointed at an empty directory so no `.gitleaksignore` from the workspace
 *  can suppress findings by fingerprint. */
export function scanDirectory(dir) {
  const scanner = detectScanner();
  if (!scanner) {
    throw new Error("No secret scanner available (install betterleaks or gitleaks).");
  }
  const target = path.resolve(dir);
  const cwd = path.dirname(target);
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-worker-scan-ignore-"));
  const reportPath = path.join(os.tmpdir(), `gpt-worker-scan-${process.pid}-${crypto.randomBytes(8).toString("hex")}.json`);
  try {
    fs.writeFileSync(reportPath, "", { mode: 0o600 });
    try {
      execFileSync(
        scanner.bin,
        [
          "dir", "--config", CONFIG_PATH, "--ignore-gitleaks-allow", "--gitleaks-ignore-path", emptyDir,
          "--report-format", "json", "--report-path", reportPath, "--no-banner", "--exit-code", "0",
          path.basename(target),
        ],
        { cwd, timeout: bundleScanTimeoutMs(), killSignal: "SIGKILL", stdio: ["ignore", "ignore", "ignore"] }
      );
    } catch (err) {
      throw new Error(`Secret scan failed (${scanner.bin}): ${err.message || err}`);
    }
    let raw;
    try {
      raw = fs.readFileSync(reportPath, "utf8");
    } catch (err) {
      throw new Error(`Secret scan report missing (${scanner.bin}): ${err.message || err}`);
    }
    if (!raw.trim()) return [];
    let findings;
    try {
      findings = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Secret scan report unparsable (${scanner.bin}): ${err.message || err}`);
    }
    // A directory scan with nothing to report writes a literal `null` (a nil
    // list), not `[]` — measured. Anything else that is not a list is a broken report.
    if (findings === null) return [];
    if (!Array.isArray(findings)) {
      throw new Error(`Secret scan report was not a list (${scanner.bin}).`);
    }
    return findings
      .map((f) => {
        const reported = String(f.File || (f.Attributes && f.Attributes.path) || "");
        const file = path.relative(target, path.resolve(cwd, reported)).split(path.sep).join("/");
        return { file, ruleId: String(f.RuleID || ""), secret: String(f.Secret || "") };
      })
      .filter((f) => f.ruleId && f.secret)
      .map((f) => {
        // A finding whose file cannot be placed inside the scanned directory
        // means the report cannot be trusted to say where the secret is.
        if (!f.file || f.file === ".." || f.file.startsWith("../") || path.isAbsolute(f.file)) {
          throw new Error(`Secret scan reported a path outside the scanned directory (${scanner.bin}).`);
        }
        return f;
      });
  } finally {
    fs.rmSync(reportPath, { force: true });
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
}

// Deliberately distinct from every real secret shape so it can never
// collide with something a workspace actually contains, while still hitting
// a genuine built-in rule (JWT) and both custom gw- rules.
// Obfuscated via ROT13 so static analysis (e.g. gitleaks, GitHub Secret
// Scanning / Push Protection) does not fire false alarms on source files.
const unrot13 = (s) =>
  s.replace(/[a-zA-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + (c.toLowerCase() <= "m" ? 13 : -13)));
const CANARY_TEXT = [
  unrot13("Nhgubevmngvba: Ornere rlWuoTpvBvWVHmV1AvVfVaE5pPV6VxcKIPW9.rlWmqJVvBvWwLJ5upaxvsD.p2ShqTy0rF1wnTIwnj"),
  unrot13("njf_frperg_npprff_xrl = PNANEL01234567PNANEL01234567PNANEL012345"),
  unrot13("cbfgterf://pnanel:fnavglpurpxcj@qo.vagreany.vainyvq:5432/ncc"),
].join("\n");
const CANARY_EXPECT = { builtin: "jwt", custom: ["gw-aws-secret-access-key", "gw-url-password"] };

/** Verifies the scanner is not just present but actually working against
 *  this config: catches a wrong binary of the same name on PATH, a config
 *  that failed to load its useDefault rules, or a rule-id rename upstream.
 *  Checked once at `gpt-worker start`, not on every scan (see plan doc). */
export function verifyScanner() {
  const scanner = detectScanner();
  if (!scanner) {
    throw new Error(
      "No secret scanner found on PATH. gpt-worker requires betterleaks (recommended) or gitleaks " +
        "to sanitize content before it reaches ChatGPT. Install one, e.g.:\n" +
        "  brew install betterleaks\n" +
        "  brew install gitleaks"
    );
  }

  // `config check` is betterleaks-only (gitleaks 8.30.1 has no such
  // subcommand) — best-effort only. The canary scan below is what actually
  // gates both engines: it independently proves useDefault loaded (the
  // built-in "jwt" rule must fire) and that both custom gw- rules loaded,
  // which is a stronger signal than a bare rule count anyway.
  let ruleCount = null;
  if (scanner.kind === "betterleaks") {
    let checkOut;
    try {
      checkOut = execFileSync(scanner.bin, ["config", "check", "--config", CONFIG_PATH], {
        encoding: "utf8",
        timeout: SCAN_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      throw new Error(`${scanner.bin} rejected bridge/leaks.toml: ${(err.stdout || "") + (err.stderr || err.message || err)}`);
    }
    const ruleCountMatch = checkOut.match(/OK:\s*(\d+)\s*rules/i);
    ruleCount = ruleCountMatch ? Number(ruleCountMatch[1]) : 0;
    // 417 built-in rules were measured against betterleaks 1.8.1; comfortably
    // below that (but still requiring useDefault to have loaded something
    // substantial) catches "useDefault silently loaded nothing" without being
    // so tight that a future engine version with slightly fewer rules trips it.
    const MIN_EXPECTED_RULES = 300;
    if (ruleCount < MIN_EXPECTED_RULES) {
      throw new Error(
        `${scanner.bin} resolved only ${ruleCount} rules from bridge/leaks.toml (expected ${MIN_EXPECTED_RULES}+). ` +
          "[extend] useDefault may have failed to load the built-in rule set."
      );
    }
  }

  let findings;
  try {
    findings = scanText(CANARY_TEXT);
  } catch (err) {
    throw new Error(`Secret scanner canary check failed to run: ${err.message || err}`);
  }
  const ruleIds = new Set(findings.map((f) => f.ruleId));
  if (!ruleIds.has(CANARY_EXPECT.builtin)) {
    throw new Error(`Secret scanner canary check failed: built-in rule "${CANARY_EXPECT.builtin}" did not fire.`);
  }
  for (const id of CANARY_EXPECT.custom) {
    if (!ruleIds.has(id)) {
      throw new Error(`Secret scanner canary check failed: custom rule "${id}" did not fire.`);
    }
  }

  return { ...scanner, ruleCount };
}
