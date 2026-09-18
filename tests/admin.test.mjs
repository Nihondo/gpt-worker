// Per-workspace provisioning and token storage (V2 multi-tenant design).
// Uses the same fake-do-ctx harness as queue.test.mjs — these methods only
// touch this.sql, so the real BridgeDO class is testable without Miniflare.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import worker, { BridgeDO } from "../worker/src/index.js";
import { makeFakeCtx, makeFakeEnv } from "./helpers/fake-do-ctx.mjs";

function makeDO() {
  return new BridgeDO(makeFakeCtx(), makeFakeEnv());
}

function makeHubAndWorkspaceEnv(extraEnv = {}) {
  const instances = new Map();
  const env = {
    ADMIN_TOKEN: "admin-secret-token",
    BRIDGE_DO: {
      idFromName: (name) => name,
      get: (name) => ({ fetch: (request) => instanceFor(name).fetch(request) }),
    },
    ...extraEnv,
  };
  function instanceFor(name) {
    if (!instances.has(name)) instances.set(name, new BridgeDO(makeFakeCtx(), env));
    return instances.get(name);
  }
  return { hub: instanceFor("gpt-worker-hub"), instanceFor, env };
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
    const setTitle = body.result.tools.find((tool) => tool.name === "set_title");
    assert.ok(list);
    assert.equal(info.inputSchema.properties.workspace_id.type, "string");
    assert.ok(info.inputSchema.required.includes("workspace_id"));
    assert.equal(overview.inputSchema.properties.workspace_id.type, "string");
    assert.ok(overview.inputSchema.required.includes("workspace_id"));
    assert.equal(overview.annotations.readOnlyHint, true);
    assert.ok(setTitle);
    assert.equal(setTitle.inputSchema.properties.workspace_id.type, "string");
    assert.ok(setTitle.inputSchema.required.includes("workspace_id"));
    assert.deepEqual(setTitle.inputSchema.required.filter((name) => name !== "workspace_id"), ["message_id", "task_id", "iteration", "title"]);
    assert.equal(setTitle.annotations.idempotentHint, true);
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

  test("shared set_title reaches only the registered selected workspace", async () => {
    const { hub, instanceFor } = makeHubAndWorkspaceEnv();
    const workspaceA = instanceFor("aaaaaaaaaaaaaaaa");
    const workspaceB = instanceFor("bbbbbbbbbbbbbbbb");
    hub.registerWorkspace({ workspace_id: "aaaaaaaaaaaaaaaa", name: "A" });

    workspaceA.localStartTask({ task_id: "a-task", goal: "A goal", text: "GOAL:\nA goal" });
    const aNext = workspaceA.queueNext("a-task");
    workspaceB.localStartTask({ task_id: "b-task", goal: "B goal", text: "GOAL:\nB goal" });
    const bNext = workspaceB.queueNext("b-task");

    const accepted = await hub.handleHubToolCall(1, {
      name: "set_title",
      arguments: { workspace_id: "aaaaaaaaaaaaaaaa", message_id: aNext.message_id, task_id: "a-task", iteration: 0, title: "A title" },
    });
    assert.equal((await accepted.json()).result.structuredContent.title, "A title");
    assert.equal(workspaceA.getTask("a-task").title, "A title");

    const rejected = await hub.handleHubToolCall(2, {
      name: "set_title",
      arguments: { workspace_id: "bbbbbbbbbbbbbbbb", message_id: bNext.message_id, task_id: "b-task", iteration: 0, title: "B title" },
    });
    assert.equal((await rejected.json()).result.structuredContent.error, "UNKNOWN_WORKSPACE");
    assert.equal(workspaceB.getTask("b-task").title, null);
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

describe("hubBrowserSettings and owner tokens", () => {
  test("hub settings refuse on unprovisioned hub", () => {
    const doo = makeDO();
    assert.equal(doo.hubBrowserSettingsGet().error, "NOT_PROVISIONED");
    assert.equal(doo.hubBrowserSettingsSet({ chatUrl: "https://chatgpt.com/g/g-p-12345678901234567890123456789012/project" }).error, "NOT_PROVISIONED");
    assert.equal(doo.hubOwnerTokenGet().error, "NOT_PROVISIONED");
  });

  test("fresh provisionHub leaves browser settings uninitialized until explicit set", () => {
    const doo = makeDO();
    doo.provisionHub();
    const settings = doo.hubBrowserSettingsGet();
    assert.equal(settings.initialized, false);
    assert.equal(settings.chatUrl, null);

    doo.hubBrowserSettingsSet({});
    const after = doo.hubBrowserSettingsGet();
    assert.equal(after.initialized, true);
    assert.equal(after.chatUrl, null);
  });

  test("hubBrowserSettingsSet validates and canonicalizes Project URL", () => {
    const doo = makeDO();
    doo.provisionHub();

    // Negative URLs: non-https, non-chatgpt domain, auth credentials, invalid path
    assert.equal(doo.hubBrowserSettingsSet({ chatUrl: "http://chatgpt.com/g/g-p-12345678901234567890123456789012/project" }).error, "INVALID_ARGS");
    assert.equal(doo.hubBrowserSettingsSet({ chatUrl: "https://example.com/g/g-p-12345678901234567890123456789012/project" }).error, "INVALID_ARGS");
    assert.equal(doo.hubBrowserSettingsSet({ chatUrl: "https://user:pass@chatgpt.com/g/g-p-12345678901234567890123456789012/project" }).error, "INVALID_ARGS");
    assert.equal(doo.hubBrowserSettingsSet({ chatUrl: "https://chatgpt.com/not-a-project" }).error, "INVALID_ARGS");

    // Valid URL
    const valid = doo.hubBrowserSettingsSet({
      chatUrl: "https://chatgpt.com/g/g-p-12345678901234567890123456789012-slug/project?prompt=test",
    });
    assert.equal(valid.initialized, true);
    assert.equal(valid.chatUrl, "https://chatgpt.com/g/g-p-12345678901234567890123456789012-slug/project?prompt=test");

    // Clear URL
    const cleared = doo.hubBrowserSettingsSet({ chatUrl: "" });
    assert.equal(cleared.initialized, true);
    assert.equal(cleared.chatUrl, null);
  });

  test("owner token getters return only gptToken", () => {
    const hub = makeDO();
    const hubProv = hub.provisionHub();
    const hubTokenRes = hub.hubOwnerTokenGet();
    assert.equal(hubTokenRes.gptToken, hubProv.gptToken);
    assert.equal(Object.keys(hubTokenRes).length, 1);

    const ws = makeDO();
    const wsProv = ws.provision();
    const wsTokenRes = ws.ownerTokenGet();
    assert.equal(wsTokenRes.gptToken, wsProv.gptToken);
    assert.equal(Object.keys(wsTokenRes).length, 1);

    // After rotation, ownerTokenGet returns updated token
    const rotated = ws.rotateSecret("gpt_token");
    assert.equal(ws.ownerTokenGet().gptToken, rotated.value);
  });

  test("deprovision clears workspace browser settings", () => {
    const ws = makeDO();
    ws.provision();
    ws.localBrowserSettingsSet({
      chatUrlOverride: "https://chatgpt.com/g/g-p-12345678901234567890123456789012/project",
    });
    const before = ws.localBrowserSettingsGet();
    assert.equal(before.initialized, true);
    assert.equal(before.chatUrlOverride, "https://chatgpt.com/g/g-p-12345678901234567890123456789012/project");

    ws.deprovision();
    assert.equal(ws.localBrowserSettingsGet().error, "NOT_PROVISIONED");
  });
});

describe("handleAdminRoute routing", () => {
  test("enforces ADMIN_TOKEN, origin gating, and POST method", async () => {
    const { env } = makeHubAndWorkspaceEnv();
    const validToken = env.ADMIN_TOKEN;

    // 1. Missing / wrong ADMIN_TOKEN -> 404
    const reqWrongToken = new Request("https://worker.example/admin/wrong-token", {
      method: "POST",
      body: JSON.stringify({ op: "hub_browser_settings_get" }),
    });
    const resWrongToken = await worker.fetch(reqWrongToken, env);
    assert.equal(resWrongToken.status, 404);

    // 2. Disallowed Origin header -> 403
    const reqBadOrigin = new Request(`https://worker.example/admin/${validToken}`, {
      method: "POST",
      headers: { Origin: "https://evil.com" },
      body: JSON.stringify({ op: "hub_browser_settings_get" }),
    });
    const resBadOrigin = await worker.fetch(reqBadOrigin, env);
    assert.equal(resBadOrigin.status, 403);

    // 3. Non-POST method -> 405
    const reqGet = new Request(`https://worker.example/admin/${validToken}`, {
      method: "GET",
    });
    const resGet = await worker.fetch(reqGet, env);
    assert.equal(resGet.status, 405);
  });

  test("routes hub browser settings and hub owner token to hub DO", async () => {
    const { hub, env } = makeHubAndWorkspaceEnv();
    const token = env.ADMIN_TOKEN;
    hub.provisionHub();

    // Set shared chatUrl
    const setReq = new Request(`https://worker.example/admin/${token}`, {
      method: "POST",
      body: JSON.stringify({
        op: "hub_browser_settings_set",
        chatUrl: "https://chatgpt.com/g/g-p-12345678901234567890123456789012/project",
      }),
    });
    const setRes = await worker.fetch(setReq, env);
    assert.equal(setRes.status, 200);
    const setBody = await setRes.json();
    assert.equal(setBody.initialized, true);
    assert.equal(setBody.chatUrl, "https://chatgpt.com/g/g-p-12345678901234567890123456789012/project");

    // Get shared chatUrl
    const getReq = new Request(`https://worker.example/admin/${token}`, {
      method: "POST",
      body: JSON.stringify({ op: "hub_browser_settings_get" }),
    });
    const getRes = await worker.fetch(getReq, env);
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.initialized, true);
    assert.equal(getBody.chatUrl, "https://chatgpt.com/g/g-p-12345678901234567890123456789012/project");

    // Hub owner token
    const tokenReq = new Request(`https://worker.example/admin/${token}`, {
      method: "POST",
      body: JSON.stringify({ op: "hub_owner_token_get" }),
    });
    const tokenRes = await worker.fetch(tokenReq, env);
    assert.equal(tokenRes.status, 200);
    const tokenBody = await tokenRes.json();
    assert.equal(typeof tokenBody.gptToken, "string");
    assert.equal(Object.keys(tokenBody).length, 1);
  });

  test("routes owner_token_get to designated workspace DO and enforces isolation", async () => {
    const { instanceFor, env } = makeHubAndWorkspaceEnv();
    const token = env.ADMIN_TOKEN;
    const wsA = "1111111111111111";
    const wsB = "2222222222222222";
    const instA = instanceFor(wsA);
    const instB = instanceFor(wsB);
    const provA = instA.provision();
    const provB = instB.provision();

    // Query A
    const reqA = new Request(`https://worker.example/admin/${token}`, {
      method: "POST",
      body: JSON.stringify({ op: "owner_token_get", workspace_id: wsA }),
    });
    const resA = await worker.fetch(reqA, env);
    assert.equal(resA.status, 200);
    const bodyA = await resA.json();
    assert.equal(bodyA.gptToken, provA.gptToken);
    assert.notEqual(bodyA.gptToken, provB.gptToken);
    assert.equal(Object.keys(bodyA).length, 1);

    // Query B
    const reqB = new Request(`https://worker.example/admin/${token}`, {
      method: "POST",
      body: JSON.stringify({ op: "owner_token_get", workspace_id: wsB }),
    });
    const resB = await worker.fetch(reqB, env);
    assert.equal(resB.status, 200);
    const bodyB = await resB.json();
    assert.equal(bodyB.gptToken, provB.gptToken);
    assert.equal(Object.keys(bodyB).length, 1);

    // Bad workspace_id -> 400
    const reqBad = new Request(`https://worker.example/admin/${token}`, {
      method: "POST",
      body: JSON.stringify({ op: "owner_token_get", workspace_id: "not-a-valid-id" }),
    });
    const resBad = await worker.fetch(reqBad, env);
    assert.equal(resBad.status, 400);

    // Missing workspace_id for workspace-targeted op -> 400
    const reqMissing = new Request(`https://worker.example/admin/${token}`, {
      method: "POST",
      body: JSON.stringify({ op: "owner_token_get" }),
    });
    const resMissing = await worker.fetch(reqMissing, env);
    assert.equal(resMissing.status, 400);
  });
});
