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
 *  misses paths under less common home locations (this repo itself lives
 *  under `~/Library/CloudStorage/Dropbox/...`) and can't distinguish the
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
