// Web dashboard (docs/plans/queue-dashboard.md): workspace-owner-only login,
// short-lived hashed sessions, CSRF-gated mutations, retention-bounded
// keyset-paginated history, and the UI-constraint-preserving discard/ack
// wrappers around the existing local* methods.
//
// Exercises the real top-level Worker `fetch` (same E2E harness pattern as
// tests/oauth.test.mjs) so top-level route shape, DO-internal dispatch, and
// session/CSRF/workspace-isolation all get covered end-to-end rather than
// just the DO methods in isolation.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import worker, { BridgeDO } from "../worker/src/index.js";
import { makeFakeCtx } from "./helpers/fake-do-ctx.mjs";

const ORIGIN = "https://example.com";

/** Real BridgeDO instances behind the same env.BRIDGE_DO binding shape as
 *  the real multi-tenant routing — see tests/oauth.test.mjs's identical
 *  helper for the full rationale. */
function makeRealBridgeDoEnv() {
  const instances = new Map();
  const env = {
    BRIDGE_DO: {
      idFromName: (name) => name,
      get: (name) => ({ fetch: (request) => instanceFor(name).fetch(request) }),
    },
  };
  function instanceFor(name) {
    if (!instances.has(name)) instances.set(name, new BridgeDO(makeFakeCtx(), env));
    return instances.get(name);
  }
  return { instanceFor, env };
}

function req(path, init = {}) {
  return new Request(`${ORIGIN}${path}`, init);
}

function jsonReq(path, body, extraHeaders = {}) {
  return req(path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...extraHeaders },
    body: JSON.stringify(body),
  });
}

/** Parses one Set-Cookie header's first "name=value" pair, e.g.
 *  "gw_dash_session=abc; Path=...; HttpOnly" -> "gw_dash_session=abc". */
function cookiePair(setCookieHeader) {
  assert.ok(setCookieHeader, "expected a Set-Cookie header");
  return setCookieHeader.split(";")[0];
}

function setCookieHeader(res) {
  if (typeof res.headers.getSetCookie === "function") {
    const all = res.headers.getSetCookie();
    return all[0];
  }
  return res.headers.get("set-cookie");
}

async function loginAndGetCookie(env, workspaceId, ownerToken) {
  const res = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/login`, { ownerToken }), env);
  assert.equal(res.status, 200);
  return cookiePair(setCookieHeader(res));
}

function makeProvisionedWorkspace(env, instanceFor) {
  const workspaceId = "0123456789abcdef";
  const doo = instanceFor(workspaceId);
  const { gptToken } = doo.provision();
  return { workspaceId, doo, gptToken };
}

describe("dashboard: top-level routing", () => {
  test("invalid workspace_id is 404", async () => {
    const { env } = makeRealBridgeDoEnv();
    const res = await worker.fetch(req("/dashboard/not-a-workspace-id"), env);
    assert.equal(res.status, 404);
  });

  test("bare /dashboard with no workspace segment is 404", async () => {
    const { env } = makeRealBridgeDoEnv();
    const res = await worker.fetch(req("/dashboard"), env);
    assert.equal(res.status, 404);
  });

  test("unauthenticated GET on the shell renders the login form, not the dashboard", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId } = makeProvisionedWorkspace(env, instanceFor);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}`), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /login-form/);
    assert.doesNotMatch(html, /overview/);
  });

  test("unknown method on the shell is 405", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId } = makeProvisionedWorkspace(env, instanceFor);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}`, { method: "POST" }), env);
    assert.equal(res.status, 405);
  });

  test("unknown api route is 404", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}/api/nope`, { headers: { cookie } }), env);
    assert.equal(res.status, 404);
  });

  test("app.js is served same-origin with a script content-type and no-store", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId } = makeProvisionedWorkspace(env, instanceFor);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}/app.js`), env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /javascript/);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });
});

describe("dashboard: login", () => {
  test("workspace gpt_token logs in and sets a HttpOnly/Secure/SameSite=Strict/path-scoped cookie", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const res = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/login`, { ownerToken: gptToken }), env);
    assert.equal(res.status, 200);
    const cookie = setCookieHeader(res);
    assert.match(cookie, /^gw_dash_session=[0-9a-f]{64}/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, new RegExp(`Path=/dashboard/${workspaceId}`));
    assert.match(cookie, /Max-Age=86400/);
  });

  test("hub_gpt_token cannot log in to a workspace dashboard (disjoint secrets)", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId } = makeProvisionedWorkspace(env, instanceFor);
    // Provision the hub DO too, and prove its token is rejected here.
    const hub = instanceFor("gpt-worker-hub");
    const { gptToken: hubGptToken } = hub.provisionHub();
    const res = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/login`, { ownerToken: hubGptToken }), env);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "INVALID_CREDENTIAL");
  });

  test("wrong token is rejected", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId } = makeProvisionedWorkspace(env, instanceFor);
    const res = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/login`, { ownerToken: "wrong" }), env);
    assert.equal(res.status, 403);
  });

  test("login without Origin is rejected (fail-closed CSRF gate)", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const res = await worker.fetch(
      req(`/dashboard/${workspaceId}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ownerToken: gptToken }),
      }),
      env,
    );
    assert.equal(res.status, 403);
  });

  test("login with a cross-origin Origin is rejected", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const res = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/login`, { ownerToken: gptToken }, { origin: "https://evil.example" }), env);
    assert.equal(res.status, 403);
  });

  test("a valid session renders the authenticated shell", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}`, { headers: { cookie } }), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /overview/);
    assert.doesNotMatch(html, /login-form/);
  });
});

describe("dashboard: session lifecycle", () => {
  test("logout revokes the session and clears the cookie (Max-Age=0)", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const logoutRes = await worker.fetch(req(`/dashboard/${workspaceId}/logout`, { method: "POST", headers: { cookie, origin: ORIGIN } }), env);
    assert.equal(logoutRes.status, 200);
    assert.match(setCookieHeader(logoutRes), /Max-Age=0/);
    const after = await worker.fetch(req(`/dashboard/${workspaceId}/api/overview`, { headers: { cookie } }), env);
    assert.equal(after.status, 401);
  });

  test("an expired session is rejected and swept lazily", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    // Force every stored session to look already-expired, simulating the
    // 24h TTL elapsing, without waiting in real time.
    doo.sql.exec(`UPDATE dashboard_sessions SET expires_at = 0`);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}/api/overview`, { headers: { cookie } }), env);
    assert.equal(res.status, 401);
  });

  test("rotating gpt_token revokes every existing dashboard session", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    doo.rotateSecret("gpt_token");
    const res = await worker.fetch(req(`/dashboard/${workspaceId}/api/overview`, { headers: { cookie } }), env);
    assert.equal(res.status, 401);
  });

  test("deprovision wipes dashboard sessions", async () => {
    const { instanceFor } = makeRealBridgeDoEnv();
    const workspaceId = "0123456789abcdef";
    const doo = instanceFor(workspaceId);
    doo.provision();
    const session = await doo.createDashboardSession();
    doo.deprovision();
    assert.equal(await doo.verifyDashboardSession(session.raw), false);
  });

  test("no ambient CSRF: a session cookie alone (missing Origin) cannot perform a mutation", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(
      req(`/dashboard/${workspaceId}/api/guidance`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ text: "hi" }),
      }),
      env,
    );
    assert.equal(res.status, 403);
  });
});

describe("dashboard: workspace isolation", () => {
  test("workspace A's session cannot read or mutate workspace B's data", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const a = instanceFor("aaaaaaaaaaaaaaaa");
    const b = instanceFor("bbbbbbbbbbbbbbbb");
    const { gptToken: aToken } = a.provision();
    b.provision();
    b.localGuidanceSet({ text: "workspace B secret guidance" });

    const cookieA = await loginAndGetCookie(env, "aaaaaaaaaaaaaaaa", aToken);
    // Sending A's cookie to B's dashboard path: routes to DO B, whose
    // dashboard_sessions table never has this hash (see the routing
    // comment in worker/src/index.js) — must be rejected regardless of
    // cookie Path scoping (a defense-in-depth browser behavior, not the
    // actual security boundary).
    const res = await worker.fetch(req(`/dashboard/bbbbbbbbbbbbbbbb/api/overview`, { headers: { cookie: cookieA } }), env);
    assert.equal(res.status, 401);
  });
});

describe("dashboard: overview + guidance + limits", () => {
  test("overview reflects status, active task, guidance and limits", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    doo.localStartTask({ task_id: "t1", goal: "ship it", text: "GOAL:\nship it" });
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}/api/overview`, { headers: { cookie } }), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.activeTask.taskId, "t1");
    assert.equal(body.guidanceSet, false);
    assert.equal(typeof body.maxBodyBytes, "number");
    assert.equal(body.retention.terminalTasksMs > body.retention.ackedMessagesMs, true);
  });

  test("guidance get/set/clear round-trips through the same local* methods the CLI uses", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    await worker.fetch(
      jsonReq(`/dashboard/${workspaceId}/api/guidance`, { text: "be careful" }, { cookie }),
      env,
    );
    assert.deepEqual(doo.workspaceGuidance(), { set: true, guidance: "be careful" });
    await worker.fetch(jsonReq(`/dashboard/${workspaceId}/api/guidance`, { clear: true }, { cookie }), env);
    assert.deepEqual(doo.workspaceGuidance(), { set: false });
  });

  test("limits set/reset round-trip and respect the existing floor/ceiling", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);

    const setRes = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/api/limits`, { maxBodyBytes: 8192 }, { cookie }), env);
    const setBody = await setRes.json();
    assert.equal(setBody.maxBodyBytes, 8192);
    assert.equal(doo.localMaxBodyBytesGet().maxBodyBytes, 8192);

    const tooSmall = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/api/limits`, { maxBodyBytes: 1 }, { cookie }), env);
    assert.equal((await tooSmall.json()).error, "INVALID_ARGS");

    const resetRes = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/api/limits`, { maxBodyBytes: null }, { cookie }), env);
    const resetBody = await resetRes.json();
    assert.equal(resetBody.maxBodyBytes, resetBody.default);
  });
});

describe("dashboard: message/task history pagination and retention framing", () => {
  test("messages page newest-first, with a stable (created_at, message_id) tie-break cursor", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    // Same created_at for several rows exercises the tie-breaker id half of
    // the keyset cursor (U4's "created_at 単独では...取りこぼし・重複が起き
    // 得る" concern) rather than only the timestamp half.
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      doo.sql.exec(
        `INSERT INTO msgs (message_id, dir, task_id, iteration, kind, body, state, lease_until, created_at) VALUES (?, 'to_gpt', 't1', 0, 'INIT', ?, 'pending', NULL, ?)`,
        `m${i}`,
        `body-${i}`,
        now,
      );
    }
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const page1 = await worker.fetch(req(`/dashboard/${workspaceId}/api/messages?limit=2`, { headers: { cookie } }), env);
    const body1 = await page1.json();
    assert.equal(body1.messages.length, 2);
    assert.ok(body1.nextCursor);

    const page2 = await worker.fetch(
      req(`/dashboard/${workspaceId}/api/messages?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`, { headers: { cookie } }),
      env,
    );
    const body2 = await page2.json();
    assert.equal(body2.messages.length, 2);

    const seenIds = new Set([...body1.messages, ...body2.messages].map((m) => m.messageId));
    assert.equal(seenIds.size, 4, "no row skipped or duplicated across pages despite identical timestamps");
  });

  test("messages endpoint includes acked rows (unlike localList)", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "x" });
    doo.sql.exec(`UPDATE msgs SET state = 'acked'`);
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}/api/messages`, { headers: { cookie } }), env);
    const body = await res.json();
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].state, "acked");
  });

  test("tasks endpoint uses updatedAt (not taskHistory()'s misnamed created_at) and includes non-terminal tasks", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    doo.localStartTask({ task_id: "t1", goal: "in progress", text: "GOAL:\nin progress" });
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}/api/tasks`, { headers: { cookie } }), env);
    const body = await res.json();
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0].protocolState, "WAITING_PLAN");
    assert.equal(body.tasks[0].updatedAt, doo.getTask("t1").updated_at);
  });
});

describe("dashboard: ack / discard / discard-task constraints", () => {
  test("ack only succeeds for to_local messages", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const { message_id: toGptId } = doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "x" });
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/api/ack`, { messageId: toGptId }, { cookie }), env);
    const body = await res.json();
    assert.equal(body.error, "ACK_NOT_ALLOWED");
  });

  test("ack succeeds for a pending to_local message (e.g. a PLAN reply) and clears it from the live queue", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    doo.localStartTask({ task_id: "t1", goal: "g", text: "GOAL:\ng" });
    doo.queueNext("t1");
    const submitted = doo.queueSubmit({ task_id: "t1", iteration: 0, state: "PLAN", body: "implement it" });
    const toLocalId = submitted.structuredContent.message_id;
    assert.equal(doo.localList({}).messages.some((m) => m.message_id === toLocalId), true, "the PLAN reply is pending before ack");

    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/api/ack`, { messageId: toLocalId }, { cookie }), env);
    assert.equal((await res.json()).ok, true);
    assert.equal(doo.localList({}).messages.some((m) => m.message_id === toLocalId), false, "acked messages drop out of the unacked queue view");
  });

  test("discard of an active task's to_gpt message is refused in favor of discard-task", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const started = doo.localStartTask({ task_id: "t1", goal: "g", text: "GOAL:\ng" });
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/api/discard`, { messageId: started.message_id }, { cookie }), env);
    const body = await res.json();
    assert.equal(body.error, "USE_DISCARD_TASK");
    // The task must still be intact (protocol state untouched) — this is
    // exactly the "queue is empty but the task is stuck" failure mode the
    // constraint exists to prevent.
    assert.equal(doo.getTask("t1").protocol_state, "WAITING_PLAN");
  });

  test("discard-task BLOCKs the task and clears its open to_gpt messages", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    doo.localStartTask({ task_id: "t1", goal: "g", text: "GOAL:\ng" });
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/api/discard-task`, { taskId: "t1" }, { cookie }), env);
    assert.equal((await res.json()).ok, true);
    assert.equal(doo.getTask("t1").protocol_state, "BLOCKED");
  });

  test("discard-task on an already-terminal task is refused", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    doo.localStartTask({ task_id: "t1", goal: "g", text: "GOAL:\ng" });
    doo.localDiscardTask({ task_id: "t1" }); // already BLOCKED
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/api/discard-task`, { taskId: "t1" }, { cookie }), env);
    assert.equal((await res.json()).error, "ALREADY_TERMINAL");
  });

  test("discard of a terminal task's leftover message is allowed directly", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const started = doo.localStartTask({ task_id: "t1", goal: "g", text: "GOAL:\ng" });
    doo.sql.exec(`UPDATE tasks SET protocol_state = 'DONE' WHERE task_id = 't1'`);
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/api/discard`, { messageId: started.message_id }, { cookie }), env);
    assert.equal((await res.json()).ok, true);
  });
});

describe("dashboard: starting a task", () => {
  test("creates the task through localStartTask() with a server-generated task_id and the standard GOAL: body", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/api/start-task`, { goal: "ship it" }, { cookie }), env);
    const body = await res.json();
    assert.equal(body.task.protocolState, "WAITING_PLAN");
    assert.equal(typeof body.task.taskId, "string");
    assert.equal(doo.activeTask().goal, "ship it");
    // No local bridge is connected in this test harness, so the best-effort
    // nudge must report that plainly rather than pretending it happened —
    // and, crucially, task creation above must have already succeeded
    // regardless (see dashboardStartTask's doc comment).
    assert.equal(body.nudge.status, "local_offline");
  });

  test("refuses a second task without force, same ACTIVE_TASK contract as the CLI", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    doo.localStartTask({ task_id: "t1", goal: "first", text: "GOAL:\nfirst" });
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/api/start-task`, { goal: "second" }, { cookie }), env);
    assert.equal((await res.json()).error, "ACTIVE_TASK");
  });

  test("an oversized goal is rejected before any task/queue row is created (preflight, no orphaned state)", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    doo.localMaxBodyBytesSet({ maxBodyBytes: 4096 });
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const hugeGoal = "x".repeat(5000);
    const res = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/api/start-task`, { goal: hugeGoal }, { cookie }), env);
    assert.equal((await res.json()).error, "BODY_TOO_LARGE");
    assert.equal(doo.activeTask(), null, "no orphaned WAITING_PLAN task left behind");
    assert.equal(doo.localList({}).messages.length, 0, "no orphaned queue row left behind");
  });

  test("force replaces the active task and BLOCKs the previous one, same as the CLI's --force", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    doo.localStartTask({ task_id: "t1", goal: "first", text: "GOAL:\nfirst" });
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/api/start-task`, { goal: "second", force: true }, { cookie }), env);
    const body = await res.json();
    assert.equal(body.task.goal, "second");
    assert.equal(doo.getTask("t1").protocol_state, "BLOCKED");
  });
});

describe("dashboard: untrusted content is never inlined into HTML", () => {
  test("a message body containing markup round-trips verbatim through the JSON API but never appears in the server-rendered HTML shell", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const payload = '<script>alert(1)</script>';
    doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: payload });
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);

    const apiRes = await worker.fetch(req(`/dashboard/${workspaceId}/api/messages`, { headers: { cookie } }), env);
    const apiBody = await apiRes.json();
    assert.equal(apiBody.messages[0].body, payload, "the API returns the raw value unmodified (JSON, not HTML)");

    const shellRes = await worker.fetch(req(`/dashboard/${workspaceId}`, { headers: { cookie } }), env);
    const html = await shellRes.text();
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, "server-rendered HTML never embeds queue content — only client JS renders it via textContent");
  });
});

describe("dashboard: rate-limit bucket isolation", () => {
  test("exhausting the public shell/app.js bucket does not 429 an already-authenticated owner's API calls", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);

    // Exhaust the unauthenticated "dashboard-public" bucket directly
    // (cheaper/faster than 120 real fetch() round trips, and exercises the
    // exact bucket key handleDashboardShell/handleDashboardAppJs/
    // handleDashboardLogout share) — this simulates an outside caller
    // flooding the public shell, which needs no credential at all since
    // workspace_id is not a secret.
    for (let i = 0; i < 120; i++) doo.rateLimit("dashboard-public", 120);

    const shellRes = await worker.fetch(req(`/dashboard/${workspaceId}`), env);
    assert.equal(shellRes.status, 429, "the exhausted public bucket itself should now reject");

    const apiRes = await worker.fetch(req(`/dashboard/${workspaceId}/api/overview`, { headers: { cookie } }), env);
    assert.equal(apiRes.status, 200, "the authenticated API path must not share a bucket with the public shell");
  });

  test("exhausting the authenticated dashboard-api bucket does not block a fresh login or the public shell", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    for (let i = 0; i < 120; i++) doo.rateLimit("dashboard-api", 120);

    const shellRes = await worker.fetch(req(`/dashboard/${workspaceId}`), env);
    assert.equal(shellRes.status, 200);

    const loginRes = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/login`, { ownerToken: gptToken }), env);
    assert.equal(loginRes.status, 200);
  });

  test("an unauthenticated flood of api requests cannot exhaust the authenticated dashboard-api bucket", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    for (let i = 0; i < 120; i++) {
      const res = await worker.fetch(req(`/dashboard/${workspaceId}/api/overview`), env);
      assert.equal(res.status, 401, "no cookie at all, every one of these must be rejected as unauthenticated");
    }
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}/api/overview`, { headers: { cookie } }), env);
    assert.equal(res.status, 200, "the post-auth dashboard-api bucket must be untouched by the unauthenticated flood above");
  });
});

describe("dashboard: response headers", () => {
  test("the HTML shell carries a script-src 'self' CSP, no-store, and no-referrer", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId } = makeProvisionedWorkspace(env, instanceFor);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}`), env);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    const csp = res.headers.get("content-security-policy");
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/, "script-src itself must not allow unsafe-inline (style-src separately does, harmlessly)");
  });

  test("api responses are no-store", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}/api/overview`, { headers: { cookie } }), env);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });
});

describe("dashboard: app.js ack callback regression (loadMessages(more) argument coupling)", () => {
  // Source-level regression check, not a browser/DOM test: loadMessages(more)
  // treats any truthy `more` as "load more" (skips clearing the list, may
  // fetch the next cursor page instead of refreshing). `.then(loadMessages)`
  // would silently pass the resolved {ok,status,body} object through as
  // `more`. Assert the served app.js never does that for the ack call, and
  // does call loadMessages(false) (a real page-refresh) afterward instead.
  test("the ack button's api(...).then(...) never passes the fetch result straight into loadMessages", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId } = makeProvisionedWorkspace(env, instanceFor);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}/app.js`), env);
    const js = await res.text();
    assert.match(js, /api\("\/api\/ack"/);
    assert.doesNotMatch(js, /\/api\/ack"[\s\S]*?\)\.then\(loadMessages\)/, "must not pass the api() result directly as loadMessages(more)");
    const ackCallIndex = js.indexOf('api("/api/ack"');
    const nextChunk = js.slice(ackCallIndex, ackCallIndex + 400);
    assert.match(nextChunk, /loadMessages\(false\)/, "the ack handler must explicitly refresh the first page");
  });
});
