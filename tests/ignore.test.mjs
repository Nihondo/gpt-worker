import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { IgnoreRules } from "../bridge/ignore.mjs";

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
