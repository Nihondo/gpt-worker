// Tests against the real scanner binary (betterleaks, or gitleaks as a
// compatible fallback). Skips entirely when neither is on PATH, since CI or
// a contributor's machine may not have one installed — betterleaks/gitleaks
// is a required *runtime* dependency for gpt-worker itself (see
// bridge/cli-daemon.mjs's cmdStart, which refuses to start without it), but is not
// declared a required *dev/test* dependency here.
//
// The fail-closed behavior when no scanner is available (the case this
// skip condition itself represents) is exercised below by forcing PATH to
// exclude both binaries, independent of whether the outer environment has
// one installed.
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  // Synthetic secrets are ROT13-encoded to prevent static tooling (e.g.
  // gitleaks, GitHub Push Protection) from flagging test fixtures.
  const unrot13 = (s) =>
    s.replace(/[a-zA-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + (c.toLowerCase() <= "m" ? 13 : -13)));
  const corpus = [
    { line: unrot13("phey -U \"k-ncv: fx-cebw-P3W27KQPT2YzyMTRBALyG3OyoxSWrcsWOq0Xu8bBBY8qXYYn\" uggcf://ncv.bcranv.pbz"), expectSecret: true },
    { line: unrot13("reebe: vainyvq xrl fx-nag-ncv03-bqWSPeay2rqyOQqm1P5Wnh2EWgOEayJzGFUs6cJxYHlvsQYxQzJW6HhIGNVwiSh7JVPCuQrBMVvOBO-L6fUeSU2MHPe-yNN"), expectSecret: true },
    { line: unrot13("Hfvat gbxra tuc_FDrqHFgCXE0PfGl4Djo8QjxAuSqaKfvIcmm6"), expectSecret: true },
    { line: unrot13("tub_3SsxPmWe4v0O3WeGNjE4l9bwsywbDbnS1Yyd"), expectSecret: true },
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
    { line: unrot13("njf_npprff_xrl_vq = NXVNMLZYBCVSDLS7Z2AK"), expectSecret: true },
    { line: unrot13("njf_frperg_npprff_xrl = 5Derp8GArpw9vABeww5IsdEGx8w1q+oJJowxybT1"), expectSecret: true },
    {
      line: unrot13("Nhgubevmngvba: Ornere rlWuoTpvBvWVHmV1AvVfVaE5pPV6VxcKIPW9.rlWmqJVvBvVkZwZ0AGL3BQxjVvjvozSgMFV6VxcinT4tET9yVa0.FsyXkjEWFZrXXS2DG4sjcZrWs36CBx6lWI_nqDffj5p"),
      expectSecret: true,
    },
    { line: unrot13("cbfgterf://nqzva:f3pe3gcnffj0eq@qo.rknzcyr.pbz:5432/ncc"), expectSecret: true },
    { line: unrot13("tycng-Uoa88UkwFV6oJUgC3sF2"), expectSecret: true },
    { line: unrot13("rkcbeg FGEVCR=fx_yvir_dUk6xjKbVVKTiBbAMLJ2zMc0"), expectSecret: true },
    { line: unrot13("NVmnFlMQm_GqqW8UlF5FHxPaQ8mEN9n9FxcKm9j"), expectSecret: true },
    { line: unrot13("kbko-123456789012-1234567890123-OLBisM8HmQmI8sHxxvowY5QM"), expectSecret: true },
    { line: unrot13("qo_cnffjbeq = \"uhagre2\""), expectSecret: "betterleaks-only" }, // no gitleaks generic-password rule
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

  // The scanned text is untrusted workspace content, so nothing in it (or next
  // to it) may switch detection off. Both holes below were measured against the
  // real scanner before the fix: the finding simply did not come back.
  describe("text from the workspace cannot suppress a finding", () => {
    const unrot13 = (t) =>
      t.replace(/[a-zA-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + (c.toLowerCase() <= "m" ? 13 : -13)));
    // Not a real credential: rot13 of a documentation-style URL.
    const secretUrl = unrot13("cbfgterf://pnanel:fnavglpurpxcj@qo.vagreany.vainyvq:5432/ncc");

    test("a `gitleaks:allow` / `betterleaks:allow` comment on the line", () => {
      for (const marker of ["gitleaks:allow", "betterleaks:allow"]) {
        const findings = scanner.scanText(`db = ${secretUrl} # ${marker}\n`);
        assert.deepEqual(findings.map((f) => f.ruleId), ["gw-url-password"], marker);
      }
    });

    test("a .gitleaksignore in the directory the process was started from", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-ignorefile-"));
      const previous = process.cwd();
      try {
        // A stdin finding's fingerprint is `:<rule>:<line>`, so this is easy to write.
        fs.writeFileSync(path.join(dir, ".gitleaksignore"), ":gw-url-password:1\n");
        process.chdir(dir);
        assert.deepEqual(scanner.scanText(`db = ${secretUrl}\n`).map((f) => f.ruleId), ["gw-url-password"]);
      } finally {
        process.chdir(previous);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
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
