// Pure text-transformation tests for bridge/sanitize.mjs, exercised via
// applyFindings() with synthetic findings — no real scanner needed, so
// these tests run in every environment regardless of whether
// betterleaks/gitleaks is on PATH. sanitizeText()'s end-to-end behavior
// against a real scanner (including the actual corpus measured in the plan
// doc this was implemented from) is covered separately in
// tests/scanner.test.mjs, which skips when no scanner binary is available.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applyFindings, mask, safeRuleId, redactLocalPaths } from "../bridge/sanitize.mjs";

describe("mask / safeRuleId: the one place mask tokens are formatted", () => {
  test("wraps a plain rule id", () => {
    assert.equal(mask("openai-api-key"), "[REDACTED:openai-api-key]");
  });

  test("keeps a custom gw- rule id distinguishable from a built-in one", () => {
    assert.equal(mask("gw-url-password"), "[REDACTED:gw-url-password]");
  });

  test("strips characters outside [a-z0-9.-] so a mask token's structure can't be broken", () => {
    assert.equal(safeRuleId("weird id]with[brackets"), "weirdidwithbrackets");
  });

  test("truncates an absurdly long rule id to 64 characters", () => {
    assert.equal(safeRuleId("a".repeat(200)).length, 64);
  });

  test("falls back to a generic label for an empty/garbage id", () => {
    assert.equal(safeRuleId(""), "secret");
    assert.equal(safeRuleId("]]]"), "secret");
    assert.equal(safeRuleId(null), "secret");
  });
});

describe("applyFindings: masking algorithm", () => {
  test("replaces a single-line secret and preserves line count", () => {
    const text = "before\nAPI_KEY=abcd1234\nafter";
    const r = applyFindings(text, [{ ruleId: "generic-api-key", secret: "abcd1234" }]);
    assert.equal(r.text, "before\nAPI_KEY=[REDACTED:generic-api-key]\nafter");
    assert.equal(r.redacted, 1);
    assert.deepEqual(r.rules, ["generic-api-key"]);
    assert.equal(r.text.split("\n").length, text.split("\n").length);
  });

  test("collapses a multi-line PEM block finding into a single mask line, preserving surrounding lines", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\nkqhkiG9w0BAQE\n-----END PRIVATE KEY-----";
    const text = `running tests...\n${pem}\ndone`;
    const r = applyFindings(text, [{ ruleId: "private-key", secret: pem }]);
    assert.equal(r.text, "running tests...\n[REDACTED:private-key]\ndone");
    assert.equal(r.redacted, 1);
  });

  test("replaces only the captured group text for a secretGroup-style finding, not the whole match", () => {
    const text = "postgres://admin:s3cr3tpassw0rd@db.example.com:5432/app";
    // The `secret` field for a secretGroup rule is the captured group value
    // only (measured behavior — see plan doc), not the full regex match.
    const r = applyFindings(text, [{ ruleId: "gw-url-password", secret: "s3cr3tpassw0rd" }]);
    assert.equal(r.text, "postgres://admin:[REDACTED:gw-url-password]@db.example.com:5432/app");
  });

  test("replaces every occurrence of a secret that appears more than once", () => {
    const text = "config.ts:  apiKey = SECRETVALUE\ntest.ts:    apiKey = SECRETVALUE";
    const r = applyFindings(text, [{ ruleId: "generic-api-key", secret: "SECRETVALUE" }]);
    assert.equal((r.text.match(/\[REDACTED:generic-api-key\]/g) || []).length, 2);
    assert.ok(!r.text.includes("SECRETVALUE"));
  });

  test("masks the longer finding first so a shorter finding that is its substring doesn't mangle it", () => {
    const text = "token=SECRETVALUE_WITH_SUFFIX";
    const r = applyFindings(text, [
      { ruleId: "short-rule", secret: "SECRETVALUE" },
      { ruleId: "long-rule", secret: "SECRETVALUE_WITH_SUFFIX" },
    ]);
    assert.equal(r.text, "token=[REDACTED:long-rule]");
  });

  test("aggregates redacted count and the set of distinct rule ids across multiple findings", () => {
    const text = "a=1secret\nb=2secret";
    const r = applyFindings(text, [
      { ruleId: "rule-a", secret: "1secret" },
      { ruleId: "rule-b", secret: "2secret" },
    ]);
    assert.equal(r.redacted, 2);
    assert.deepEqual(r.rules.sort(), ["rule-a", "rule-b"]);
  });

  test("does not leak the original secret's length into the mask token", () => {
    const short = applyFindings("x=AB", [{ ruleId: "r", secret: "AB" }]).text;
    const long = applyFindings("x=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", [
      { ruleId: "r", secret: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" },
    ]).text;
    assert.equal(short, "x=[REDACTED:r]");
    assert.equal(long, "x=[REDACTED:r]");
  });

  test("ignores a finding whose secret text is not actually present in the input", () => {
    const r = applyFindings("nothing here", [{ ruleId: "r", secret: "not-present" }]);
    assert.equal(r.text, "nothing here");
    assert.equal(r.redacted, 0);
  });

  test("is a no-op on an empty findings list", () => {
    const r = applyFindings("plain text", []);
    assert.equal(r.text, "plain text");
    assert.equal(r.redacted, 0);
    assert.deepEqual(r.rules, []);
  });

  test("never produces a restricted/allowed:false-style outcome — the result always has a text field", () => {
    const r = applyFindings("secret-here", [{ ruleId: "r", secret: "secret-here" }]);
    assert.ok("text" in r);
    assert.ok(!("restricted" in r));
    assert.ok(!("reason" in r));
    assert.ok(!("allowed" in r));
  });
});

describe("redactLocalPaths: known real values, not a guessed pattern", () => {
  const ctx = { root: "/Users/alice/Projects/gpt-worker", home: "/Users/alice", tmpdir: "/private/tmp", username: "alice" };

  test("replaces the workspace root before the enclosing home directory swallows it", () => {
    const out = redactLocalPaths("Error at /Users/alice/Projects/gpt-worker/secret.txt", ctx);
    assert.equal(out, "Error at [workspace]/secret.txt");
    assert.ok(!out.includes("alice"));
  });

  test("replaces the home directory when the path is outside the workspace", () => {
    const out = redactLocalPaths("Home: /Users/alice/.ssh/config", ctx);
    assert.equal(out, "Home: [home]/.ssh/config");
  });

  test("replaces the tmp directory", () => {
    const out = redactLocalPaths("Wrote /private/tmp/gpt-worker-scan-123.json", ctx);
    assert.equal(out, "Wrote [tmp]/gpt-worker-scan-123.json");
  });

  test("replaces a bare username only as a whole path segment", () => {
    const out = redactLocalPaths("owner: /Users/alice, unrelated: alice-utils", ctx);
    // The path form is already caught by the home-dir replacement above; the
    // point of this test is that "alice-utils" (not a path segment) is
    // left untouched by the narrower username-segment rule.
    assert.ok(out.includes("alice-utils"));
  });

  test("does not touch text containing none of the configured real values", () => {
    const out = redactLocalPaths("nothing sensitive here", ctx);
    assert.equal(out, "nothing sensitive here");
  });

  test("returns an empty string unchanged", () => {
    assert.equal(redactLocalPaths("", ctx), "");
  });

  test("with an explicit empty context, applies no substitution beyond the environment's own real home/tmp fallback", () => {
    // root/username are not defaulted (no safe global fallback exists for
    // them), so a path containing only a distinctive root-like value is
    // left untouched when no root is given.
    const out = redactLocalPaths("path: /some/other/workspace/file.txt", {});
    assert.equal(out, "path: /some/other/workspace/file.txt");
  });
});
