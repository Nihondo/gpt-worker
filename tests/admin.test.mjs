// Per-workspace provisioning and token storage (V2 multi-tenant design).
// Uses the same fake-do-ctx harness as queue.test.mjs — these methods only
// touch this.sql, so the real BridgeDO class is testable without Miniflare.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BridgeDO } from "../worker/src/index.js";
import { makeFakeCtx, makeFakeEnv } from "./helpers/fake-do-ctx.mjs";

function makeDO() {
  return new BridgeDO(makeFakeCtx(), makeFakeEnv());
}

describe("provision", () => {
  test("generates 3 distinct tokens and stores them", () => {
    const doo = makeDO();
    const r = doo.provision();
    assert.equal(typeof r.gptToken, "string");
    assert.equal(typeof r.linkToken, "string");
    assert.equal(typeof r.cliToken, "string");
    assert.notEqual(r.gptToken, r.linkToken);
    assert.notEqual(r.linkToken, r.cliToken);
    assert.equal(doo.getSecret("gpt_token"), r.gptToken);
    assert.equal(doo.getSecret("link_token"), r.linkToken);
    assert.equal(doo.getSecret("cli_token"), r.cliToken);
  });

  test("refuses to re-provision an already-provisioned workspace", () => {
    const doo = makeDO();
    const first = doo.provision();
    const second = doo.provision();
    assert.equal(second.error, "ALREADY_PROVISIONED");
    // original tokens are untouched
    assert.equal(doo.getSecret("gpt_token"), first.gptToken);
  });
});

describe("shared connector hub", () => {
  test("provisions one stable token and returns it on idempotent setup", () => {
    const doo = makeDO();
    const first = doo.provisionHub();
    const second = doo.provisionHub();
    assert.equal(typeof first.gptToken, "string");
    assert.equal(second.gptToken, first.gptToken);
    assert.equal(second.alreadyProvisioned, true);
    assert.equal(doo.checkToken("hub_gpt_token", first.gptToken), true);
  });

  test("rotating the hub token revokes every existing hub dashboard session", async () => {
    const doo = makeDO();
    doo.provisionHub();
    const session = await doo.createDashboardSession();
    assert.equal(await doo.verifyDashboardSession(session.raw), true);
    const r = doo.rotateHubToken();
    assert.equal(typeof r.value, "string");
    assert.equal(await doo.verifyDashboardSession(session.raw), false);
  });

  test("rotateHubToken refuses on an unprovisioned hub", () => {
    const doo = makeDO();
    assert.equal(doo.rotateHubToken().error, "NOT_PROVISIONED");
  });

  test("registers and removes workspace choices independently of workspace secrets", () => {
    const doo = makeDO();
    assert.deepEqual(doo.registerWorkspace({ workspace_id: "0123456789abcdef", name: "Project A" }), { ok: true });
    const registered = doo.registeredWorkspaces().map((row) => ({ workspace_id: row.workspace_id, name: row.name }));
    assert.deepEqual(registered, [{ workspace_id: "0123456789abcdef", name: "Project A" }]);
    assert.deepEqual(doo.unregisterWorkspace({ workspace_id: "0123456789abcdef" }), { ok: true });
    assert.deepEqual(doo.registeredWorkspaces(), []);
  });

  test("advertises workspace selection and requires it for shared tools", async () => {
    const doo = makeDO();
    const response = await doo.handleHubMcpRequest({ id: 1, method: "tools/list", params: {} });
    const body = await response.json();
    const list = body.result.tools.find((tool) => tool.name === "list_workspaces");
    const info = body.result.tools.find((tool) => tool.name === "workspace_info");
    const overview = body.result.tools.find((tool) => tool.name === "workspace_overview");
    assert.ok(list);
    assert.equal(info.inputSchema.properties.workspace_id.type, "string");
    assert.ok(info.inputSchema.required.includes("workspace_id"));
    assert.equal(overview.inputSchema.properties.workspace_id.type, "string");
    assert.ok(overview.inputSchema.required.includes("workspace_id"));
    assert.equal(overview.annotations.readOnlyHint, true);
  });

  test("operating_instructions is exposed without a workspace_id requirement", async () => {
    const doo = makeDO();
    const response = await doo.handleHubMcpRequest({ id: 1, method: "tools/list", params: {} });
    const body = await response.json();
    const tool = body.result.tools.find((t) => t.name === "operating_instructions");
    assert.ok(tool);
    assert.equal(tool.inputSchema.properties.workspace_id, undefined);
    assert.ok(!(tool.inputSchema.required || []).includes("workspace_id"));
  });

  test("operating_instructions answers locally, without a registered workspace_id", async () => {
    const doo = makeDO();
    const response = await doo.handleHubToolCall(1, { name: "operating_instructions", arguments: {} });
    const body = await response.json();
    assert.notEqual(body.result.structuredContent.error, "UNKNOWN_WORKSPACE");
    assert.match(body.result.structuredContent.instructions, /call list_workspaces first/);
  });

  test("initialize carries the connector-appropriate operating instructions", async () => {
    const doo = makeDO();
    const hub = await doo.handleHubMcpRequest({ id: 1, method: "initialize", params: {} });
    const hubBody = await hub.json();
    assert.match(hubBody.result.instructions, /call list_workspaces first/);

    const dedicated = await doo.handleMcpRequest({ id: 1, method: "initialize", params: {} });
    const dedicatedBody = await dedicated.json();
    assert.doesNotMatch(dedicatedBody.result.instructions, /call list_workspaces first/);
  });
});

describe("migrateDefault", () => {
  test("adopts exact given token values rather than generating new ones", () => {
    const doo = makeDO();
    const r = doo.migrateDefault({ gptToken: "g1", linkToken: "l1", cliToken: "c1" });
    assert.equal(r.ok, true);
    assert.equal(doo.getSecret("gpt_token"), "g1");
    assert.equal(doo.getSecret("link_token"), "l1");
    assert.equal(doo.getSecret("cli_token"), "c1");
  });

  test("rejects incomplete input", () => {
    const doo = makeDO();
    const r = doo.migrateDefault({ gptToken: "g1" });
    assert.equal(r.error, "INVALID_ARGS");
    assert.equal(doo.hasSecrets(), false);
  });

  test("also refuses if already provisioned", () => {
    const doo = makeDO();
    doo.provision();
    const r = doo.migrateDefault({ gptToken: "g1", linkToken: "l1", cliToken: "c1" });
    assert.equal(r.error, "ALREADY_PROVISIONED");
  });
});

describe("rotateSecret", () => {
  test("refuses on an unprovisioned workspace", () => {
    const doo = makeDO();
    assert.equal(doo.rotateSecret("gpt_token").error, "NOT_PROVISIONED");
  });

  test("replaces only the named key, leaving the others untouched", () => {
    const doo = makeDO();
    const { linkToken, cliToken } = doo.provision();
    const r = doo.rotateSecret("gpt_token");
    assert.equal(typeof r.value, "string");
    assert.equal(doo.getSecret("gpt_token"), r.value);
    assert.equal(doo.getSecret("link_token"), linkToken);
    assert.equal(doo.getSecret("cli_token"), cliToken);
  });

  test("rejects an unknown key", () => {
    const doo = makeDO();
    doo.provision();
    assert.equal(doo.rotateSecret("something_else").error, "INVALID_ARGS");
  });
});

describe("deprovision", () => {
  test("wipes secrets, queue, task state and settings; the workspace can be re-provisioned fresh", () => {
    const doo = makeDO();
    const { gptToken } = doo.provision();
    doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "x" });
    doo.localGuidanceSet({ text: "trusted" });

    const r = doo.deprovision();
    assert.equal(r.ok, true);
    assert.equal(doo.hasSecrets(), false);
    assert.equal(doo.checkToken("gpt_token", gptToken), false);
    assert.equal(doo.localList({}).messages.length, 0);
    assert.equal(doo.activeTask(), null);
    assert.deepEqual(doo.workspaceGuidance(), { set: false });

    // re-provisioning afterward is allowed (fresh tokens, not the old ones)
    const fresh = doo.provision();
    assert.notEqual(fresh.gptToken, gptToken);
  });
});

describe("checkToken", () => {
  test("false before provisioning (no stored secret yet)", () => {
    const doo = makeDO();
    assert.equal(doo.checkToken("gpt_token", "anything"), false);
  });

  test("true only for the exact stored value, per key", () => {
    const doo = makeDO();
    const { gptToken, linkToken, cliToken } = doo.provision();
    assert.equal(doo.checkToken("gpt_token", gptToken), true);
    assert.equal(doo.checkToken("gpt_token", linkToken), false); // right kind of value, wrong key
    assert.equal(doo.checkToken("link_token", linkToken), true);
    assert.equal(doo.checkToken("cli_token", cliToken), true);
    assert.equal(doo.checkToken("gpt_token", gptToken + "x"), false);
  });
});
