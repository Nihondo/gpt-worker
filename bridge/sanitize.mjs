// Egress content sanitization: masks secrets bridge/scanner.mjs finds, and
// normalizes local filesystem paths, in text about to cross the WS link to
// ChatGPT. This module holds no secret-detection patterns of its own — see
// bridge/scanner.mjs for why detection is delegated entirely to an external
// scanner. Everything here is pure text transformation.
//
// Masking never removes text wholesale: every finding becomes
// `[REDACTED:<RuleID>]` in place, so a round always carries a full-length,
// line-structured body. There is deliberately no "restricted"/all-or-nothing
// outcome — see the plan doc this was implemented from for why an
// all-or-nothing gate (as the upstream project this was evaluated against
// uses) was rejected.

import os from "node:os";
import { scanText } from "./scanner.mjs";

/** Keeps a mask token from ever containing characters that could make it
 *  look like something other than a single opaque token — RuleID values are
 *  controlled by this repo's own config plus the scanner's built-in rules
 *  (measured: all match [a-z0-9.-]), but this is cheap insurance against a
 *  future rule id or a corrupted report field, not a defense against
 *  workspace content (RuleID never originates from scanned text). */
export function safeRuleId(id) {
  const cleaned = String(id || "").replace(/[^a-z0-9.-]/gi, "");
  return (cleaned || "secret").slice(0, 64);
}

/** The one place that formats a mask token. Length is deliberately not
 *  preserved (see plan doc: length leaks information about the secret and
 *  wastes ChatGPT's context on long tokens for no benefit to a reader who
 *  is not a human eyeballing column alignment). */
export function mask(ruleId) {
  return `[REDACTED:${safeRuleId(ruleId)}]`;
}

/** Replaces every occurrence of every finding's literal secret text with its
 *  mask token. Deliberately string-replacement, not offset-based: measured
 *  behavior of both engines shows StartColumn/EndColumn are not usable in
 *  general — a multi-line private-key finding's columns point only at its
 *  first line, and a secretGroup-scoped finding's columns span the whole
 *  match rather than just the captured group. The `Secret` field is correct
 *  in both cases and needs no offset arithmetic.
 *
 *  Exported (separately from sanitizeText()) so the masking algorithm can be
 *  unit-tested against synthetic findings without a real scanner on PATH —
 *  see tests/sanitize.test.mjs. `findings` is `[{ ruleId, secret }]`, the
 *  same shape bridge/scanner.mjs's scanText() returns. */
export function applyFindings(text, findings) {
  if (findings.length === 0) return { text, redacted: 0, rules: [] };
  // Longest-first: if one finding's secret is a substring of another's
  // (e.g. a captured password inside a longer matched URL), masking the
  // longer one first prevents the shorter pass from mangling what the
  // longer mask already produced.
  const sorted = [...findings].sort((a, b) => b.secret.length - a.secret.length);
  let out = text;
  let redacted = 0;
  const rules = new Set();
  for (const { ruleId, secret } of sorted) {
    if (!secret || !out.includes(secret)) continue;
    const token = mask(ruleId);
    const before = out;
    out = out.split(secret).join(token);
    if (out !== before) {
      redacted++;
      rules.add(safeRuleId(ruleId));
    }
  }
  return { text: out, redacted, rules: [...rules] };
}

const HEAVY_REDACTION_RATIO = 0.5; // share of output characters that are mask tokens

/** Runs the scanner over `text` and returns it with every finding masked.
 *  Always returns `text` — there is no "restricted"/allowed:false outcome by
 *  design (see module header). Throws if the scanner itself fails (missing
 *  binary, timeout, bad report) rather than returning unscanned text; the
 *  caller (link.mjs's reply()) must treat that as an error response, never
 *  send the original text. */
export function sanitizeText(text) {
  if (typeof text !== "string" || text.length === 0) {
    return { text: text ?? "", redacted: 0, rules: [], heavilyRedacted: false };
  }
  const findings = scanText(text); // throws on scanner failure — never caught here
  const { text: masked, redacted, rules } = applyFindings(text, findings);
  const maskedChars = rules.length ? countMaskedChars(masked) : 0;
  const heavilyRedacted = redacted > 0 && text.length > 0 && maskedChars / masked.length > HEAVY_REDACTION_RATIO;
  return { text: masked, redacted, rules, heavilyRedacted };
}

function countMaskedChars(text) {
  const matches = text.match(/\[REDACTED:[a-z0-9.-]{1,64}\]/g);
  if (!matches) return 0;
  return matches.reduce((sum, m) => sum + m.length, 0);
}

/** Replaces this machine's real local paths with stable placeholders.
 *  Deliberately uses known real values (this.root, os.homedir(), etc.)
 *  rather than guessing a pattern like `/Users/[^/]+` — that guess both
 *  misses paths under less common home locations (e.g. cloud-synced folders
 *  or custom mounts) and can't distinguish the
 *  workspace root from the wider home directory. Longest-value-first so a
 *  root nested under home is replaced with `[workspace]` before the
 *  enclosing `[home]` swallows it. */
export function redactLocalPaths(text, { root, home, username, tmpdir } = {}) {
  if (typeof text !== "string" || text.length === 0) return text;
  const replacements = [
    [root, "[workspace]"],
    [home ?? os.homedir(), "[home]"],
    [tmpdir ?? os.tmpdir(), "[tmp]"],
  ].filter(([value]) => typeof value === "string" && value.length > 0);
  replacements.sort((a, b) => b[0].length - a[0].length);

  let out = text;
  for (const [value, placeholder] of replacements) {
    if (out.includes(value)) out = out.split(value).join(placeholder);
  }

  const user = username ?? safeUsername();
  if (user && user.length >= 2) {
    // Username alone (not just inside a path) is a narrower, riskier
    // replacement than the path swaps above — only applied as a whole path
    // segment so it doesn't clobber an unrelated word that happens to match.
    out = out.replace(new RegExp(`(^|[\\\\/])${escapeRegExp(user)}(?=[\\\\/]|$)`, "g"), (m0, sep) => `${sep}[user]`);
  }
  return out;
}

function safeUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- PreScanned: a payload whose content was already scanned and masked ----
//
// link.mjs's reply() runs every string leaf of a result through the secret
// scanner. That is the right thing for text, and useless for a base64 archive:
// the scanner cannot see inside compressed bytes, so scanning the blob would
// cost a scan (against a 2s budget) and report nothing. An archive is instead
// scanned *before* it is packed (files staged, scanned as a directory, masked
// per file), and then handed to reply() wrapped in this class.
//
// The wrapper is what makes skipping the second scan safe rather than a hole:
// reply() skips only an actual PreScanned instance. Everything ChatGPT can
// supply reaches this process as plain parsed JSON, which can never be one, and
// a plain object shaped like the wire form below is scanned like any other text.

export const PRE_SCANNED_MIME_TYPES = ["application/gzip", "application/x-gzip", "application/octet-stream"];
const FILENAME_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export class PreScanned {
  /** `redacted`/`rules` describe what masking the pre-scan applied, so reply()
   *  can still tell the operator that something was redacted. */
  constructor({ base64, mimeType, filename, redacted = 0, rules = [] }) {
    if (typeof base64 !== "string" || base64.length === 0 || !BASE64_PATTERN.test(base64)) {
      throw new TypeError("PreScanned: base64 must be a non-empty base64 string");
    }
    if (!PRE_SCANNED_MIME_TYPES.includes(mimeType)) throw new TypeError("PreScanned: unsupported mimeType");
    if (typeof filename !== "string" || !FILENAME_PATTERN.test(filename)) throw new TypeError("PreScanned: unsafe filename");
    if (!Number.isInteger(redacted) || redacted < 0) throw new TypeError("PreScanned: redacted must be a non-negative integer");
    this.base64 = base64;
    this.mimeType = mimeType;
    this.filename = filename;
    this.redacted = redacted;
    this.rules = rules.map(safeRuleId);
    Object.freeze(this);
  }
}
