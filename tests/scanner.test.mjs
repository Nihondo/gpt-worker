// Tests against the real scanner binary (betterleaks, or gitleaks as a
// compatible fallback). Skips entirely when neither is on PATH, since CI or
// a contributor's machine may not have one installed — betterleaks/gitleaks
// is a required *runtime* dependency for gpt-worker itself (see
// bridge/cli.mjs's cmdStart, which refuses to start without it), but is not
// declared a required *dev/test* dependency here.
//
// The fail-closed behavior when no scanner is available (the case this
// skip condition itself represents) is exercised below by forcing PATH to
// exclude both binaries, independent of whether the outer environment has
// one installed.
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as scanner from "../bridge/scanner.mjs";

function hasBinary(bin) {
  try {
    execFileSync(bin, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const available = hasBinary("betterleaks") || hasBinary("gitleaks");

describe("scanner.mjs: detectScanner / scanText (requires betterleaks or gitleaks on PATH)", { skip: !available && "no secret scanner on PATH" }, () => {
  beforeEach(() => scanner.resetScannerCache());

  test("detectScanner finds a binary and caches the result", () => {
    const first = scanner.detectScanner();
    assert.ok(first);
    assert.ok(["betterleaks", "gitleaks"].includes(first.kind));
    const second = scanner.detectScanner();
    assert.equal(second, first, "cached result should be the same object");
  });

  test("verifyScanner passes its own canary (built-in rule + both custom gw- rules fire)", () => {
    const result = scanner.verifyScanner();
    assert.ok(["betterleaks", "gitleaks"].includes(result.kind));
  });

  // Realistic-shaped synthetic secrets. Two things matter for a value here
  // to actually be recognized (both discovered the hard way while writing
  // this corpus, not just documented from a spec):
  //  1. Exact length/charset per rule — e.g. Anthropic keys must be exactly
  //     "sk-ant-api03-" + 93 chars + "AA", and AWS access key ids are base32
  //     ([A-Z2-7]) not general alphanumeric. A same-length-but-wrong-charset
  //     value silently fails to match.
  //  2. Real entropy — betterleaks' BPE-based detection (see its README)
  //     filters out low-entropy noise like a single character repeated 36
  //     times even when it satisfies a rule's regex, so every value below
  //     uses a varied, pseudo-random-looking character sequence rather than
  //     a repeated filler character.
  const corpus = [
    { line: 'curl -H "x-api: sk-proj-C3J27XDCG2LmlZGEONYlT3BlbkFJepfJBd0Kh8oOOL8dKLLa" https://api.openai.com', expectSecret: true },
    { line: "error: invalid key sk-ant-api03-odJFCrnl2edlBDdz1C5Jau2RJtBRnlWmTSHf6pWkLUyifDLkDmWJ6UuVTAIjvFu7WICPhDeOZIiBOB-Y6sHrFH2ZUCr-lAA", expectSecret: true },
    { line: "Using token ghp_SQedUStPKR0CsTy4Qwb8DwkNhFdnXsiVpzz6", expectSecret: true },
    { line: "gho_3FfkCzJr4i0B3JrTAwR4y9ojfljoQoaF1Llq", expectSecret: true },
    // The built-in "aws-access-token" rule is a *composite* rule (its own
    // config: `components = [{ id = 'aws-secret-access-key', within = '5L' }]`)
    // that only fires when a well-formed access-key-id AND a nearby (within
    // 5 lines) secret-shaped value are both present — confirmed by testing
    // the access-key-id line alone (does not fire) vs. paired with the next
    // line as below (fires reliably). The secret-key half is what gpt-worker
    // actually had to add coverage for (the built-in "aws-secret-access-key"
    // rule has `skipReport = true` and never reports standalone — the exact
    // gap measured in the plan doc this was implemented from), via its own
    // gw-aws-secret-access-key rule below.
    { line: "aws_access_key_id = AKIAZYMLOPIFQYF7M2NX", expectSecret: true },
    { line: "aws_secret_access_key = 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", expectSecret: true },
    {
      line: "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      expectSecret: true,
    },
    { line: "postgres://admin:s3cr3tpassw0rd@db.example.com:5432/app", expectSecret: true },
    { line: "glpat-Hbn88HxjSI6bWHtP3fS2", expectSecret: true },
    { line: "export STRIPE=sk_live_qHx6kwXoIIXGvOoNZYW2mZp0", expectSecret: true },
    { line: "AIzaSyZDz_TddJ8HyS5SUkCnD8zRA9a9SkpXz9w", expectSecret: true },
    { line: "xoxb-123456789012-1234567890123-BYOvfZ8UzDzV8fUkkibjL5DZ", expectSecret: true },
    { line: 'db_password = "hunter2"', expectSecret: "betterleaks-only" }, // no gitleaks generic-password rule
    // False-positive bait: none of these should ever be masked.
    { line: "const apiKey = process.env.OPENAI_API_KEY;", expectSecret: false },
    { line: "password: ${DB_PASSWORD}", expectSecret: false },
    { line: 'const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";', expectSecret: false },
    { line: '"integrity": "sha512-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh==",', expectSecret: false },
    { line: 'const id = "550e8400-e29b-41d4-a716-446655440000";', expectSecret: false },
    { line: 'DEBUG=true npm test -- --grep "auth"', expectSecret: false },
  ];

  test("corpus: every real secret shape is detected, no false positive fires", () => {
    const engine = scanner.detectScanner().kind;
    const text = corpus.map((c) => c.line).join("\n");
    const findings = scanner.scanText(text);
    const hitLines = new Set();
    for (const f of findings) {
      const idx = corpus.findIndex((c) => f.secret && c.line.includes(f.secret));
      if (idx >= 0) hitLines.add(idx);
    }
    corpus.forEach((c, i) => {
      if (c.expectSecret === false) {
        assert.ok(!hitLines.has(i), `false positive on: ${c.line}`);
      } else if (c.expectSecret === true || (c.expectSecret === "betterleaks-only" && engine === "betterleaks")) {
        assert.ok(hitLines.has(i), `missed: ${c.line}`);
      }
    });
  });

  test("scanText returns [] for text with no secrets", () => {
    assert.deepEqual(scanner.scanText("nothing to see here\njust ordinary code\n"), []);
  });
});

describe("scanner.mjs: fails closed when no scanner is on PATH", () => {
  let originalPath;
  before(() => {
    originalPath = process.env.PATH;
  });

  test("detectScanner returns null and scanText/verifyScanner throw, with PATH forced empty of both binaries", () => {
    scanner.resetScannerCache();
    // A minimal PATH containing only the directories needed to resolve
    // "node" itself (for anything the test harness might still shell out
    // to), deliberately excluding wherever betterleaks/gitleaks live.
    process.env.PATH = "/usr/bin:/bin";
    try {
      assert.equal(scanner.detectScanner(), null);
      assert.throws(() => scanner.scanText("hello"), /no secret scanner/i);
      assert.throws(() => scanner.verifyScanner(), /no secret scanner/i);
    } finally {
      process.env.PATH = originalPath;
      scanner.resetScannerCache();
    }
  });
});
