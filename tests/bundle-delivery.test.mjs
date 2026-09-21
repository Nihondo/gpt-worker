// workspace_bundle delivery path (docs/plans/pending/workspace-bundle-tool.md,
// Phases 0-1): a PreScanned archive crosses the bridge's single egress point
// without a second scan, and the Worker turns it into an MCP embedded resource
// without doubling it into structuredContent. What goes *into* the archive is
// covered by tests/bundle.test.mjs; this file is about getting it out.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeLink } from "../bridge/link.mjs";
import { PreScanned } from "../bridge/sanitize.mjs";
import { BridgeDO } from "../worker/src/index.js";
import { summarizeTarget } from "../worker/src/worker-mcp-access.js";
import { makeFakeCtx, makeFakeEnv } from "./helpers/fake-do-ctx.mjs";
import { workspaceStateDir } from "../bridge/state.mjs";

const unrot13 = (s) =>
  s.replace(/[a-zA-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + (c.toLowerCase() <= "m" ? 13 : -13)));

const dirsToClean = [];
after(() => {
  for (const dir of dirsToClean) fs.rmSync(dir, { recursive: true, force: true });
});

function makeBridgeLink() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gw-bundle-test-")));
  fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.js"), "export const a = 1;\n");
  dirsToClean.push(root, workspaceStateDir(root));
  const link = new BridgeLink({
    workerUrl: "https://example.test",
    workspaceId: "0123456789abcdef",
    linkToken: "tok",
    workspaceRoot: root,
  });
  const logged = [];
  link.log = (line) => logged.push(line);
  const sent = [];
  link.ws = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) };
  return { link, sent, logged, root };
}

const call = (link, rid, method, params) => link.handleMessage(JSON.stringify({ rid, method, params }));
const ACTIVE = { __gptWorkerActiveTask: true, __gptWorkerTaskWindow: "active" };

describe("PreScanned", () => {
  const valid = { base64: "aGVsbG8=", mimeType: "application/gzip", filename: "a.tgz" };

  test("accepts a well-formed archive and is frozen", () => {
    const value = new PreScanned({ ...valid, redacted: 2, rules: ["gw-url-password"] });
    assert.equal(Object.isFrozen(value), true);
    assert.deepEqual(value.rules, ["gw-url-password"]);
  });

  test("rejects anything that is not base64, a known type, or a safe filename", () => {
    assert.throws(() => new PreScanned({ ...valid, base64: "not base64!" }), TypeError);
    assert.throws(() => new PreScanned({ ...valid, base64: "" }), TypeError);
    assert.throws(() => new PreScanned({ ...valid, mimeType: "text/html" }), TypeError);
    assert.throws(() => new PreScanned({ ...valid, filename: "../x.tgz" }), TypeError);
    assert.throws(() => new PreScanned({ ...valid, redacted: -1 }), TypeError);
  });
});

describe("BridgeLink: workspace_bundle", () => {
  test("is gated like every other broad read", async () => {
    const { link, sent } = makeBridgeLink();
    await call(link, "a", "workspace_bundle", { __gptWorkerActiveTask: false, __gptWorkerTaskWindow: "none" });
    await call(link, "b", "workspace_bundle", { __gptWorkerActiveTask: false, __gptWorkerTaskWindow: "expired" });
    assert.equal(sent[0].result.status, "no_active_task");
    assert.equal(sent[1].result.status, "task_window_expired");
  });

  test("an active window returns the archive in wire form, with no bundle object left behind", async () => {
    const { link, sent } = makeBridgeLink();
    await call(link, "c", "workspace_bundle", ACTIVE);

    assert.equal(sent[0].ok, true);
    const { bundle, filesReturned, archiveBytes } = sent[0].result;
    assert.equal(filesReturned, 2);
    assert.deepEqual(Object.keys(bundle).sort(), ["base64", "filename", "mimeType"]);
    assert.equal(bundle.mimeType, "application/gzip");
    // gzip magic number: the archive really is the bytes that were packed.
    const bytes = Buffer.from(bundle.base64, "base64");
    assert.equal(bytes.subarray(0, 2).toString("hex"), "1f8b");
    assert.equal(bytes.length, archiveBytes);
    assert.equal("sanitize" in sent[0].result, false);
  });

  test("a bad max_bytes is an argument error, not a crash", async () => {
    const { link, sent } = makeBridgeLink();
    await call(link, "e", "workspace_bundle", { max_bytes: 10, ...ACTIVE });
    await call(link, "f", "workspace_bundle", { max_bytes: 999_999_999, ...ACTIVE });
    assert.equal(sent[0].result.error, "INVALID_ARGS");
    assert.equal(sent[1].result.error, "INVALID_ARGS");
  });

  test("bridge.log records the outcome and never the archive", async () => {
    const { link, sent, logged } = makeBridgeLink();
    await call(link, "g", "workspace_bundle", ACTIVE);
    const base64 = sent[0].result.bundle.base64;
    assert.ok(logged.some((line) => /^rpc workspace_bundle ok/.test(line)));
    for (const line of logged) assert.equal(line.includes(base64.slice(0, 64)), false);
  });

  test("is not available inside workspace_batch (a bulk tool must not nest)", async () => {
    const { link, sent } = makeBridgeLink();
    await call(link, "h", "workspace_batch", { calls: [{ id: "1", name: "workspace_bundle", arguments: {} }], ...ACTIVE });
    // The whole batch is refused up front, so nothing runs and no archive is built.
    assert.equal(sent[0].result.code, "INVALID_ARGS");
    assert.match(sent[0].result.message, /workspace_bundle/);
    assert.equal("results" in sent[0].result, false);
  });
});

describe("BridgeLink.reply: PreScanned skips the scan, plain look-alikes do not", () => {
  test("a PreScanned archive passes through untouched and its masking is reported", () => {
    const { link, sent } = makeBridgeLink();
    const base64 = Buffer.alloc(300_000, 7).toString("base64");
    link.reply("r1", true, {
      filesReturned: 1,
      bundle: new PreScanned({ base64, mimeType: "application/gzip", filename: "x.tgz", redacted: 3, rules: ["gw-url-password"] }),
    });

    assert.equal(sent[0].result.bundle.base64, base64);
    assert.deepEqual(sent[0].result.sanitize.rules, ["gw-url-password"]);
    assert.equal(sent[0].result.sanitize.redacted, 3);
  });

  test("a plain object shaped like the wire form is scanned like any other text", () => {
    const { link, sent } = makeBridgeLink();
    const secret = unrot13("njf_frperg_npprff_xrl = PNANEL01234567PNANEL01234567PNANEL012345");
    link.reply("r2", true, { bundle: { base64: "aGVsbG8=", mimeType: "application/gzip", filename: "x.tgz", leak: secret } });

    assert.equal(sent[0].result.bundle.leak.includes("PNANEL"), false);
    assert.equal(sent[0].result.bundle.leak.includes("CANARY"), false);
    assert.match(sent[0].result.bundle.leak, /\[REDACTED:/);
    assert.ok(sent[0].result.sanitize.redacted > 0);
  });

  test("text next to an archive is still scanned", () => {
    const { link, sent } = makeBridgeLink();
    const secret = unrot13("cbfgterf://pnanel:fnavglpurpxcj@qo.vagreany.vainyvq:5432/ncc");
    link.reply("r3", true, {
      warning: `connect with ${secret}`,
      bundle: new PreScanned({ base64: "aGVsbG8=", mimeType: "application/gzip", filename: "x.tgz" }),
    });

    assert.equal(sent[0].result.warning.includes("fnavglpurpxcj"), false);
    assert.equal(sent[0].result.warning.includes("sanitycheckpw"), false);
    assert.match(sent[0].result.warning, /\[REDACTED:/);
    assert.equal(sent[0].result.bundle.base64, "aGVsbG8=");
  });
});

describe("Worker: workspace_bundle result", () => {
  const makeDO = () => new BridgeDO(makeFakeCtx(), makeFakeEnv());
  const relayReturns = (doo, result) => {
    doo.callLocal = async () => ({ ok: true, result });
  };
  const rows = (doo) => doo.sql.exec(`SELECT * FROM mcp_access_events ORDER BY event_id`).toArray();
  const wire = { base64: Buffer.from("archive bytes").toString("base64"), mimeType: "application/gzip", filename: "b.tgz" };

  test("becomes an embedded resource, and the archive is not duplicated into structuredContent", async () => {
    const doo = makeDO();
    relayReturns(doo, { filesReturned: 4, bundle: wire });
    const result = await doo.invokeTool("workspace_bundle", {});

    assert.equal(result.isError, undefined);
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, "text");
    assert.deepEqual(result.content[1], {
      type: "resource",
      resource: { uri: "gpt-worker://bundle/b.tgz", mimeType: "application/gzip", blob: wire.base64 },
    });
    assert.deepEqual(result.structuredContent, { filesReturned: 4 });
    assert.equal(result.content[0].text.includes(wire.base64), false);
    assert.equal(JSON.stringify(result.structuredContent).includes(wire.base64), false);
  });

  test("a gate refusal or argument error stays an ordinary tool result", async () => {
    const doo = makeDO();
    relayReturns(doo, { status: "no_active_task" });
    assert.deepEqual((await doo.invokeTool("workspace_bundle", {})).structuredContent, { status: "no_active_task" });
    relayReturns(doo, { error: "INVALID_ARGS", message: "nope" });
    assert.equal((await doo.invokeTool("workspace_bundle", {})).structuredContent.error, "INVALID_ARGS");
  });

  test("a malformed bundle is an error and is never forwarded", async () => {
    const doo = makeDO();
    for (const bundle of [
      { ...wire, base64: "not base64!" },
      { ...wire, mimeType: "text/html" },
      { ...wire, filename: "../evil.tgz" },
      { ...wire, base64: "" },
      "just a string",
      null,
    ]) {
      relayReturns(doo, { bundle });
      const result = await doo.invokeTool("workspace_bundle", {});
      assert.equal(result.isError, true, JSON.stringify(bundle).slice(0, 60));
      assert.equal(result.content.length, 1);
    }
  });

  test("the audit row holds metadata only: no archive, no file names", async () => {
    const doo = makeDO();
    relayReturns(doo, { filesReturned: 4, bundle: wire });
    await doo.invokeTool("workspace_bundle", { max_bytes: 4096 });

    const [row] = rows(doo);
    assert.equal(row.tool_name, "workspace_bundle");
    assert.equal(row.outcome, "success");
    assert.equal(row.target, "workspace archive");
    for (const value of Object.values(row)) assert.equal(String(value).includes(wire.base64), false);
  });

  test("other tools are unaffected: a `bundle` field in another tool's result is plain data", async () => {
    const doo = makeDO();
    relayReturns(doo, { bundle: wire });
    const result = await doo.invokeTool("read_file", { path: "a.js" });
    assert.equal(result.content.length, 1);
    assert.deepEqual(result.structuredContent, { bundle: wire });
  });

  test("the audit target is a sanitized path or a fixed label, never the raw argument", () => {
    assert.equal(summarizeTarget("workspace_bundle", {}), "workspace archive");
    assert.equal(summarizeTarget("workspace_bundle", { path: "src/lib" }), "workspace archive · src/lib");
    assert.equal(summarizeTarget("workspace_bundle", { path: "/etc/passwd" }), "workspace archive · invalid/outside workspace path");
    assert.equal(summarizeTarget("workspace_bundle", { path: "../x" }), "workspace archive · invalid/outside workspace path");
    assert.equal(summarizeTarget("workspace_bundle", { max_bytes: 4096 }), "workspace archive");
  });
});
