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
import WORKSPACE_DASHBOARD_APP_JS from "../worker/src/dashboard/workspace-app.js";
import HUB_DASHBOARD_APP_JS from "../worker/src/dashboard/hub-app.js";

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
    assert.doesNotMatch(html, /id="overview"/);
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

// ---------------------------------------------------------------------------
// Shared hub dashboard: login with hub_gpt_token, list every registered
// workspace, and relay authenticated operations to a target workspace's own
// DO over the binding-only /hub-dashboard-relay route (never forwarding the
// hub session/token itself). See worker/src/index.js's "hub authority
// propagation" comments on handleHubDashboardRelay/hubDashboardRelay.
// ---------------------------------------------------------------------------

function makeHub(env, instanceFor) {
  const hub = instanceFor("gpt-worker-hub");
  const { gptToken: hubGptToken } = hub.provisionHub();
  return { hub, hubGptToken };
}

async function loginHubAndGetCookie(env, hubGptToken) {
  const res = await worker.fetch(jsonReq(`/dashboard/hub/login`, { ownerToken: hubGptToken }), env);
  assert.equal(res.status, 200);
  return cookiePair(setCookieHeader(res));
}

describe("hub dashboard: routing", () => {
  test("/dashboard/hub renders the login form when unauthenticated", async () => {
    const { env } = makeRealBridgeDoEnv();
    const res = await worker.fetch(req(`/dashboard/hub`), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /login-form/);
    assert.doesNotMatch(html, /workspace-list/);
  });

  test("/dashboard/hub/app.js is served same-origin with a script content-type", async () => {
    const { env } = makeRealBridgeDoEnv();
    const res = await worker.fetch(req(`/dashboard/hub/app.js`), env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /javascript/);
  });

  test("the internal hub-dashboard-relay route is never reachable from a public URL", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    makeProvisionedWorkspace(env, instanceFor);
    const res = await worker.fetch(
      req(`/hub-dashboard-relay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "overview", method: "GET" }) }),
      env,
    );
    assert.equal(res.status, 404);
  });

  test("a literal 'hub' second segment never collides with a real 16-hex workspace_id", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    // "hub" itself is never a valid workspace_id, so the per-workspace
    // routing branch must never see it; confirm the hub branch handled it
    // instead by checking the hub-specific login copy appears.
    const res = await worker.fetch(req(`/dashboard/hub`), env);
    const html = await res.text();
    assert.match(html, /Shared hub token/);
  });
});

describe("hub dashboard: login", () => {
  test("hub_gpt_token logs in and sets a HttpOnly/Secure/SameSite=Strict cookie scoped to /dashboard/hub", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { hubGptToken } = makeHub(env, instanceFor);
    const res = await worker.fetch(jsonReq(`/dashboard/hub/login`, { ownerToken: hubGptToken }), env);
    assert.equal(res.status, 200);
    const cookie = setCookieHeader(res);
    assert.match(cookie, /^gw_dash_session=[0-9a-f]{64}/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\/dashboard\/hub/);
    assert.match(cookie, /Max-Age=86400/);
  });

  test("a workspace's own gpt_token cannot log in to the hub dashboard (disjoint secrets)", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { gptToken: workspaceToken } = makeProvisionedWorkspace(env, instanceFor);
    makeHub(env, instanceFor);
    const res = await worker.fetch(jsonReq(`/dashboard/hub/login`, { ownerToken: workspaceToken }), env);
    assert.equal(res.status, 403);
  });

  test("wrong token is rejected", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    makeHub(env, instanceFor);
    const res = await worker.fetch(jsonReq(`/dashboard/hub/login`, { ownerToken: "wrong" }), env);
    assert.equal(res.status, 403);
  });

  test("login without Origin is rejected (fail-closed CSRF gate)", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { hubGptToken } = makeHub(env, instanceFor);
    const res = await worker.fetch(
      req(`/dashboard/hub/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ownerToken: hubGptToken }) }),
      env,
    );
    assert.equal(res.status, 403);
  });

  test("a hub session renders the authenticated hub shell", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { hubGptToken } = makeHub(env, instanceFor);
    const cookie = await loginHubAndGetCookie(env, hubGptToken);
    const res = await worker.fetch(req(`/dashboard/hub`, { headers: { cookie } }), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /workspace-list/);
    assert.doesNotMatch(html, /login-form/);
  });
});

describe("hub dashboard: session lifecycle", () => {
  test("logout revokes the hub session and clears the cookie (Max-Age=0, Path=/dashboard/hub)", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { hubGptToken } = makeHub(env, instanceFor);
    const cookie = await loginHubAndGetCookie(env, hubGptToken);
    const logoutRes = await worker.fetch(req(`/dashboard/hub/logout`, { method: "POST", headers: { cookie, origin: ORIGIN } }), env);
    assert.equal(logoutRes.status, 200);
    const logoutCookie = setCookieHeader(logoutRes);
    assert.match(logoutCookie, /Max-Age=0/);
    assert.match(logoutCookie, /Path=\/dashboard\/hub/);
    const after = await worker.fetch(req(`/dashboard/hub/api/workspaces`, { headers: { cookie } }), env);
    assert.equal(after.status, 401);
  });

  test("an expired hub session is rejected and swept lazily", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { hub, hubGptToken } = makeHub(env, instanceFor);
    const cookie = await loginHubAndGetCookie(env, hubGptToken);
    // Force every stored hub session to look already-expired, simulating
    // the 24h TTL elapsing, without waiting in real time — same technique
    // as the equivalent per-workspace test above.
    hub.sql.exec(`UPDATE dashboard_sessions SET expires_at = 0`);
    const res = await worker.fetch(req(`/dashboard/hub/api/workspaces`, { headers: { cookie } }), env);
    assert.equal(res.status, 401);
  });
});

describe("hub dashboard: session isolation from workspace dashboards", () => {
  test("a hub session cannot authenticate a workspace's own dashboard API", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId } = makeProvisionedWorkspace(env, instanceFor);
    const { hubGptToken } = makeHub(env, instanceFor);
    const hubCookie = await loginHubAndGetCookie(env, hubGptToken);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}/api/overview`, { headers: { cookie: hubCookie } }), env);
    assert.equal(res.status, 401);
  });

  test("a workspace session cannot authenticate the hub dashboard API", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    makeHub(env, instanceFor);
    const workspaceCookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(req(`/dashboard/hub/api/workspaces`, { headers: { cookie: workspaceCookie } }), env);
    assert.equal(res.status, 401);
  });

  test("rotating hub_gpt_token revokes hub dashboard sessions but not a workspace's own session", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const { hub, hubGptToken } = makeHub(env, instanceFor);
    const hubCookie = await loginHubAndGetCookie(env, hubGptToken);
    const workspaceCookie = await loginAndGetCookie(env, workspaceId, gptToken);

    hub.rotateHubToken();

    const hubRes = await worker.fetch(req(`/dashboard/hub/api/workspaces`, { headers: { cookie: hubCookie } }), env);
    assert.equal(hubRes.status, 401, "the hub session must be revoked by rotating the hub token");

    const wsRes = await worker.fetch(req(`/dashboard/${workspaceId}/api/overview`, { headers: { cookie: workspaceCookie } }), env);
    assert.equal(wsRes.status, 200, "a workspace's own dashboard session must be unaffected by hub token rotation");
  });

  test("rotating a workspace's gpt_token does not revoke the hub session", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo } = makeProvisionedWorkspace(env, instanceFor);
    const { hubGptToken } = makeHub(env, instanceFor);
    const hubCookie = await loginHubAndGetCookie(env, hubGptToken);
    doo.rotateSecret("gpt_token");
    const hubRes = await worker.fetch(req(`/dashboard/hub/api/workspaces`, { headers: { cookie: hubCookie } }), env);
    assert.equal(hubRes.status, 200);
  });
});

describe("hub dashboard: rate-limit bucket isolation from workspace dashboards", () => {
  test("exhausting a workspace's dashboard-api bucket does not affect the hub dashboard", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo } = makeProvisionedWorkspace(env, instanceFor);
    const { hub, hubGptToken } = makeHub(env, instanceFor);
    for (let i = 0; i < 120; i++) doo.rateLimit("dashboard-api", 120);
    const cookie = await loginHubAndGetCookie(env, hubGptToken);
    const res = await worker.fetch(req(`/dashboard/hub/api/workspaces`, { headers: { cookie } }), env);
    assert.equal(res.status, 200);
  });

  test("exhausting the hub-dashboard-api-unauth bucket does not block a fresh hub login", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { hub, hubGptToken } = makeHub(env, instanceFor);
    for (let i = 0; i < 120; i++) hub.rateLimit("hub-dashboard-api-unauth", 120);
    const res = await worker.fetch(jsonReq(`/dashboard/hub/login`, { ownerToken: hubGptToken }), env);
    assert.equal(res.status, 200);
  });

  test("an unauthenticated flood of hub api requests cannot exhaust the authenticated hub-dashboard-api bucket", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { hub, hubGptToken } = makeHub(env, instanceFor);
    for (let i = 0; i < 120; i++) {
      const res = await worker.fetch(req(`/dashboard/hub/api/workspaces`), env);
      assert.equal(res.status, 401);
    }
    const cookie = await loginHubAndGetCookie(env, hubGptToken);
    const res = await worker.fetch(req(`/dashboard/hub/api/workspaces`, { headers: { cookie } }), env);
    assert.equal(res.status, 200);
  });
});

describe("hub dashboard: workspace listing and registry membership", () => {
  test("the authenticated workspace list is exactly registeredWorkspaces()", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo } = makeProvisionedWorkspace(env, instanceFor);
    const { hub, hubGptToken } = makeHub(env, instanceFor);
    hub.registerWorkspace({ workspace_id: workspaceId, name: "Project A" });
    const cookie = await loginHubAndGetCookie(env, hubGptToken);
    const res = await worker.fetch(req(`/dashboard/hub/api/workspaces`, { headers: { cookie } }), env);
    const body = await res.json();
    assert.equal(body.workspaces.length, 1);
    assert.equal(body.workspaces[0].workspaceId, workspaceId);
    assert.equal(body.workspaces[0].name, "Project A");
    assert.equal(body.workspaces[0].error, null);
    assert.equal(body.workspaces[0].overview.connected, false);
  });

  test("a workspace that fails to respond is reported as unavailable without failing the whole listing", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { hub, hubGptToken } = makeHub(env, instanceFor);
    // Registered but never provisioned: handleHubDashboardRelay refuses
    // with NOT_PROVISIONED rather than recreating state for it.
    hub.registerWorkspace({ workspace_id: "0123456789abcdef", name: "Ghost" });
    const cookie = await loginHubAndGetCookie(env, hubGptToken);
    const res = await worker.fetch(req(`/dashboard/hub/api/workspaces`, { headers: { cookie } }), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.workspaces.length, 1);
    assert.equal(body.workspaces[0].overview, null);
    assert.equal(body.workspaces[0].error, "NOT_PROVISIONED");
  });

  test("a valid-looking but unregistered workspace_id is rejected by the relay", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    makeProvisionedWorkspace(env, instanceFor); // provisioned, but never registered with the hub
    const { hub, hubGptToken } = makeHub(env, instanceFor);
    const cookie = await loginHubAndGetCookie(env, hubGptToken);
    const res = await worker.fetch(req(`/dashboard/hub/api/workspaces/0123456789abcdef/overview`, { headers: { cookie } }), env);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, "UNKNOWN_WORKSPACE");
  });

  test("unregistering a workspace immediately revokes hub access to it under an already-existing session", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId } = makeProvisionedWorkspace(env, instanceFor);
    const { hub, hubGptToken } = makeHub(env, instanceFor);
    hub.registerWorkspace({ workspace_id: workspaceId, name: "Project A" });
    const cookie = await loginHubAndGetCookie(env, hubGptToken);

    const before = await worker.fetch(req(`/dashboard/hub/api/workspaces/${workspaceId}/overview`, { headers: { cookie } }), env);
    assert.equal(before.status, 200);

    hub.unregisterWorkspace({ workspace_id: workspaceId });
    const after = await worker.fetch(req(`/dashboard/hub/api/workspaces/${workspaceId}/overview`, { headers: { cookie } }), env);
    assert.equal(after.status, 404);
    assert.equal((await after.json()).error, "UNKNOWN_WORKSPACE");
  });

  test("a stale registry entry for a since-deprovisioned workspace refuses the relay without recreating task/settings state", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo } = makeProvisionedWorkspace(env, instanceFor);
    const { hub, hubGptToken } = makeHub(env, instanceFor);
    hub.registerWorkspace({ workspace_id: workspaceId, name: "Project A" });
    doo.deprovision(); // registry entry now outlives the workspace's own tokens/state
    const cookie = await loginHubAndGetCookie(env, hubGptToken);
    const res = await worker.fetch(req(`/dashboard/hub/api/workspaces/${workspaceId}/overview`, { headers: { cookie } }), env);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, "NOT_PROVISIONED");
    assert.equal(doo.hasSecrets(), false, "the relay must not have re-provisioned or recreated any state");
  });
});

describe("hub dashboard: relayed operations reach only the selected target workspace", () => {
  test("guidance set through the hub relay lands on the target workspace only", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const a = instanceFor("aaaaaaaaaaaaaaaa");
    const b = instanceFor("bbbbbbbbbbbbbbbb");
    a.provision();
    b.provision();
    const { hub, hubGptToken } = makeHub(env, instanceFor);
    hub.registerWorkspace({ workspace_id: "aaaaaaaaaaaaaaaa", name: "A" });
    hub.registerWorkspace({ workspace_id: "bbbbbbbbbbbbbbbb", name: "B" });
    const cookie = await loginHubAndGetCookie(env, hubGptToken);

    await worker.fetch(jsonReq(`/dashboard/hub/api/workspaces/aaaaaaaaaaaaaaaa/guidance`, { text: "for A only" }, { cookie }), env);
    assert.deepEqual(a.workspaceGuidance(), { set: true, guidance: "for A only" });
    assert.deepEqual(b.workspaceGuidance(), { set: false }, "workspace B must be untouched");
  });

  test("ack/discard/discard-task/start-task relayed through the hub reuse the exact same local* semantics as the CLI/workspace dashboard", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo } = makeProvisionedWorkspace(env, instanceFor);
    const { hub, hubGptToken } = makeHub(env, instanceFor);
    hub.registerWorkspace({ workspace_id: workspaceId, name: "A" });
    const cookie = await loginHubAndGetCookie(env, hubGptToken);

    // start-task through the hub, server-generated task_id, same GOAL: contract
    const startRes = await worker.fetch(jsonReq(`/dashboard/hub/api/workspaces/${workspaceId}/start-task`, { goal: "ship it" }, { cookie }), env);
    const startBody = await startRes.json();
    assert.equal(startBody.task.protocolState, "WAITING_PLAN");
    assert.equal(doo.activeTask().goal, "ship it");
    assert.equal(startBody.nudge.status, "local_offline");

    // discard-task through the hub
    const discardRes = await worker.fetch(jsonReq(`/dashboard/hub/api/workspaces/${workspaceId}/discard-task`, { taskId: startBody.task.taskId }, { cookie }), env);
    assert.equal((await discardRes.json()).ok, true);
    assert.equal(doo.getTask(startBody.task.taskId).protocol_state, "BLOCKED");

    // ack through the hub
    doo.localStartTask({ task_id: "t2", goal: "g2", text: "GOAL:\ng2" });
    doo.queueNext("t2");
    const submitted = doo.queueSubmit({ task_id: "t2", iteration: 0, state: "PLAN", body: "do it" });
    const toLocalId = submitted.structuredContent.message_id;
    const ackRes = await worker.fetch(jsonReq(`/dashboard/hub/api/workspaces/${workspaceId}/ack`, { messageId: toLocalId }, { cookie }), env);
    assert.equal((await ackRes.json()).ok, true);
    assert.equal(doo.localList({}).messages.some((m) => m.message_id === toLocalId), false);
  });

  test("messages/tasks pagination cursor and query params are forwarded through the hub relay", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo } = makeProvisionedWorkspace(env, instanceFor);
    const { hub, hubGptToken } = makeHub(env, instanceFor);
    hub.registerWorkspace({ workspace_id: workspaceId, name: "A" });
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      doo.sql.exec(
        `INSERT INTO msgs (message_id, dir, task_id, iteration, kind, body, state, lease_until, created_at) VALUES (?, 'to_gpt', 't1', 0, 'INIT', ?, 'pending', NULL, ?)`,
        `m${i}`,
        `body-${i}`,
        now - i,
      );
    }
    const cookie = await loginHubAndGetCookie(env, hubGptToken);
    const page1 = await worker.fetch(req(`/dashboard/hub/api/workspaces/${workspaceId}/messages?limit=2`, { headers: { cookie } }), env);
    const body1 = await page1.json();
    assert.equal(body1.messages.length, 2);
    assert.ok(body1.nextCursor);
    const page2 = await worker.fetch(
      req(`/dashboard/hub/api/workspaces/${workspaceId}/messages?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`, { headers: { cookie } }),
      env,
    );
    const body2 = await page2.json();
    assert.equal(body2.messages.length, 1);
  });

  test("a POST relay without Origin is rejected at the hub (fail-closed CSRF gate), never reaching the target workspace", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo } = makeProvisionedWorkspace(env, instanceFor);
    const { hub, hubGptToken } = makeHub(env, instanceFor);
    hub.registerWorkspace({ workspace_id: workspaceId, name: "A" });
    const cookie = await loginHubAndGetCookie(env, hubGptToken);
    const res = await worker.fetch(
      req(`/dashboard/hub/api/workspaces/${workspaceId}/guidance`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ text: "should not apply" }),
      }),
      env,
    );
    assert.equal(res.status, 403);
    assert.deepEqual(doo.workspaceGuidance(), { set: false });
  });

  // Reviewed correctness fix: handleHubDashboardRelay used to reconstruct a
  // relayed POST body as `JSON.stringify(envelope.body ?? {})`, which turned
  // a literal JSON `null` body into `{}` — silently upgrading a malformed
  // request into a valid, state-changing one only on the hub path. It must
  // now preserve the exact parsed value, including `null`, so the hub path
  // and the direct workspace-dashboard path agree on what counts as valid.
  test("a literal JSON null body is rejected identically through the workspace and hub limits endpoints, and neither changes the stored limit", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const { hub, hubGptToken } = makeHub(env, instanceFor);
    hub.registerWorkspace({ workspace_id: workspaceId, name: "A" });
    doo.localMaxBodyBytesSet({ maxBodyBytes: 8192 });

    const workspaceCookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const directRes = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/api/limits`, null, { cookie: workspaceCookie }), env);
    assert.equal((await directRes.json()).error, "INVALID_ARGS");
    assert.equal(doo.localMaxBodyBytesGet().maxBodyBytes, 8192, "the direct workspace path must not have changed the stored limit");

    const hubCookie = await loginHubAndGetCookie(env, hubGptToken);
    const hubRes = await worker.fetch(jsonReq(`/dashboard/hub/api/workspaces/${workspaceId}/limits`, null, { cookie: hubCookie }), env);
    assert.equal(hubRes.status, directRes.status, "the hub relay must reject exactly like the direct workspace path");
    assert.equal((await hubRes.json()).error, "INVALID_ARGS");
    assert.equal(doo.localMaxBodyBytesGet().maxBodyBytes, 8192, "the hub relay must not have changed the stored limit either");

    // The normal, well-formed reset request ({maxBodyBytes:null}, a real
    // object — not a bare JSON null) must still work through the hub.
    const resetRes = await worker.fetch(jsonReq(`/dashboard/hub/api/workspaces/${workspaceId}/limits`, { maxBodyBytes: null }, { cookie: hubCookie }), env);
    assert.equal(resetRes.status, 200);
    const resetBody = await resetRes.json();
    assert.equal(resetBody.maxBodyBytes, resetBody.default);
  });
});

describe("hub dashboard: untrusted content and app.js safety", () => {
  test("registered workspace names are never inlined as HTML in the server-rendered shell", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId } = makeProvisionedWorkspace(env, instanceFor);
    const { hub, hubGptToken } = makeHub(env, instanceFor);
    hub.registerWorkspace({ workspace_id: workspaceId, name: "<script>alert(1)</script>" });
    const cookie = await loginHubAndGetCookie(env, hubGptToken);
    const shellRes = await worker.fetch(req(`/dashboard/hub`, { headers: { cookie } }), env);
    const html = await shellRes.text();
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, "the server-rendered shell never embeds registry content — only client JS renders it via textContent");
  });

  test("hub app.js's ack handler also refreshes via loadMessages(id, gen, false), not the raw fetch result", async () => {
    const { env } = makeRealBridgeDoEnv();
    const res = await worker.fetch(req(`/dashboard/hub/app.js`), env);
    const js = await res.text();
    assert.match(js, /wsApiFor\(id, "\/ack"/);
    assert.doesNotMatch(js, /\/ack"[\s\S]*?\)\.then\(loadMessages\)/, "must not pass the api() result directly as loadMessages(more)");
    const ackCallIndex = js.indexOf('wsApiFor(id, "/ack"');
    const nextChunk = js.slice(ackCallIndex, ackCallIndex + 400);
    assert.match(nextChunk, /loadMessages\(id, gen, false\)/);
  });

  // Regression coverage for the reviewed cross-workspace UI race (a slower
  // response for a previously selected workspace could otherwise overwrite
  // the newly selected workspace's rendered detail, and a stale "Save"
  // click could then write to the wrong target) — source-level, not a
  // browser/DOM test, same rationale as the ack-callback check above.
  test("hub app.js guards every per-workspace request with a selection generation and a fixed target id, never mutable global state alone", async () => {
    const { env } = makeRealBridgeDoEnv();
    const res = await worker.fetch(req(`/dashboard/hub/app.js`), env);
    const js = await res.text();

    assert.match(js, /selectionGen/, "must track a selection generation to detect a stale in-flight response");
    assert.match(js, /function wsApiFor\(workspaceId, path, options\)/, "every per-workspace call must take its target workspaceId explicitly");
    assert.doesNotMatch(js, /function wsApi\(path, options\)/, "must not keep the old mutable-state-derived wsApi() helper alongside wsApiFor");

    // selectWorkspace() must clear the previously rendered detail (messages/
    // tasks/guidance/limits) before the newly selected workspace's data
    // arrives, not merely swap the state.workspaceId pointer.
    const selectIndex = js.indexOf("function selectWorkspace(id, name)");
    assert.ok(selectIndex >= 0);
    const selectBody = js.slice(selectIndex, selectIndex + 900);
    assert.match(selectBody, /selectionGen \+= 1/);
    assert.match(selectBody, /clearEl\(document\.getElementById\("messages-list"\)\)/);
    assert.match(selectBody, /clearEl\(document\.getElementById\("tasks-list"\)\)/);

    // Every load*() response handler must check the captured generation
    // against the current one before touching the DOM.
    ["loadOverview", "loadGuidance", "loadLimits", "loadMessages", "loadTasks"].forEach((fnName) => {
      const fnIndex = js.indexOf("function " + fnName + "(");
      assert.ok(fnIndex >= 0, fnName + " must exist");
      const fnBody = js.slice(fnIndex, fnIndex + 500);
      assert.match(fnBody, /gen === state\.selectionGen|gen !== state\.selectionGen/, fnName + " must guard its response against a stale selection generation");
    });
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

// ---------------------------------------------------------------------------
// Dashboard assets are Wrangler Text-module imports (worker/src/dashboard/*),
// not inline template-literal constants — see worker/wrangler.jsonc's `rules`
// and tests/helpers/text-modules.mjs's matching Node loader hook. These tests
// pin two things a refactor of that extraction could silently break: (1) the
// served bytes are exactly the imported asset, not a copy that drifted, and
// (2) the HTML templates' `{{MARKER}}` placeholders are always fully
// resolved before reaching the browser — see fillDashboardTemplate's
// "never leak an unresolved marker" guarantee in worker/src/index.js.
// ---------------------------------------------------------------------------

describe("dashboard: Text-module asset extraction", () => {
  test("served /dashboard/<id>/app.js body is exactly the imported workspace-app.js Text module", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId } = makeProvisionedWorkspace(env, instanceFor);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}/app.js`), env);
    const body = await res.text();
    assert.equal(body, WORKSPACE_DASHBOARD_APP_JS);
  });

  test("served /dashboard/hub/app.js body is exactly the imported hub-app.js Text module", async () => {
    const { env } = makeRealBridgeDoEnv();
    const res = await worker.fetch(req(`/dashboard/hub/app.js`), env);
    const body = await res.text();
    assert.equal(body, HUB_DASHBOARD_APP_JS);
  });

  test("unauthenticated workspace login HTML resolves every {{marker}}: correct workspaceId, correct app.js URL, no leftover braces", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId } = makeProvisionedWorkspace(env, instanceFor);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}`), env);
    const html = await res.text();
    assert.match(html, new RegExp(`Workspace: <strong>${workspaceId}</strong>`));
    assert.match(html, new RegExp(`<script src="/dashboard/${workspaceId}/app\\.js"></script>`));
    assert.doesNotMatch(html, /\{\{|\}\}/, "no unresolved {{marker}} may reach the browser");
  });

  test("authenticated workspace shell HTML resolves every {{marker}}: correct workspaceId, correct app.js URL, no leftover braces", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}`, { headers: { cookie } }), env);
    const html = await res.text();
    assert.match(html, new RegExp(`<h2>${workspaceId}</h2>`));
    assert.match(html, new RegExp(`<script src="/dashboard/${workspaceId}/app\\.js"></script>`));
    assert.doesNotMatch(html, /\{\{|\}\}/, "no unresolved {{marker}} may reach the browser");
  });

  test("hub login HTML resolves {{DASHBOARD_STYLE}}, references /dashboard/hub/app.js, no leftover braces", async () => {
    const { env } = makeRealBridgeDoEnv();
    const res = await worker.fetch(req(`/dashboard/hub`), env);
    const html = await res.text();
    assert.match(html, /<script src="\/dashboard\/hub\/app\.js"><\/script>/);
    assert.doesNotMatch(html, /\{\{|\}\}/, "no unresolved {{marker}} may reach the browser");
  });

  test("hub shell HTML resolves {{DASHBOARD_STYLE}}, references /dashboard/hub/app.js, no leftover braces", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { hubGptToken } = makeHub(env, instanceFor);
    const cookie = await loginHubAndGetCookie(env, hubGptToken);
    const res = await worker.fetch(req(`/dashboard/hub`, { headers: { cookie } }), env);
    const html = await res.text();
    assert.match(html, /<script src="\/dashboard\/hub\/app\.js"><\/script>/);
    assert.doesNotMatch(html, /\{\{|\}\}/, "no unresolved {{marker}} may reach the browser");
  });
});

// ---------------------------------------------------------------------------
// UX redesign (docs/plans/dashboard-ux-redesign.md): Activity/Settings tabs,
// Tasks/Messages sub-tabs, list-pane -> detail-pane split, truncation with
// "Read more", and the [Web]-[Hub]-[Local] stage indicator. Frontend-only —
// no dashboardApiDispatch/auth/CSRF/rate-limit/pagination/retention change,
// so this block only pins markup/source-level contracts on top of the
// existing suites above (all of which must remain green unmodified).
// ---------------------------------------------------------------------------

// Extracts the full opening tag containing a given id, regardless of
// attribute order (e.g. `role="tab"` may appear before or after `id="..."`),
// so structural assertions below don't depend on incidental attribute order.
function tagWithId(html, id) {
  const m = html.match(new RegExp(`<[a-zA-Z0-9]+\\b[^>]*\\bid="${id}"[^>]*>`));
  return m ? m[0] : null;
}

describe("dashboard: graphical workspace layout (workspace navigation + context controls + list/detail panes)", () => {
  test("workspace shell exposes context controls above Tasks/Messages and the list+detail pane containers", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}`, { headers: { cookie } }), env);
    const html = await res.text();
    ["tab-tasks", "tab-messages"].forEach((id) => {
      const tag = tagWithId(html, id);
      assert.ok(tag, id + " element must exist");
      assert.match(tag, /role="tab"/, id + " must have role=tab");
    });
    assert.match(html, /id="tasks-list"/);
    assert.match(html, /id="tasks-detail"/);
    assert.match(html, /id="messages-list"/);
    assert.match(html, /id="messages-detail"/);
    assert.match(html, /class="workspace-context"/);
    assert.match(html, /class="settings-disclosure"/);
    assert.match(html, /class="three-pane"/);
  });

  test("hub shell exposes the same top-level Tasks/Messages tabs and list+detail pane containers", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { hubGptToken } = makeHub(env, instanceFor);
    const cookie = await loginHubAndGetCookie(env, hubGptToken);
    const res = await worker.fetch(req(`/dashboard/hub`, { headers: { cookie } }), env);
    const html = await res.text();
    ["tab-tasks", "tab-messages"].forEach((id) => {
      const tag = tagWithId(html, id);
      assert.ok(tag, id + " element must exist");
      assert.match(tag, /role="tab"/, id + " must have role=tab");
    });
    assert.match(html, /id="tasks-detail"/);
    assert.match(html, /id="messages-detail"/);
    assert.match(html, /class="dashboard-layout wide"/);
    assert.match(html, /class="workspace-sidebar"/);
    assert.match(html, /class="workspace-context"/);
    assert.match(html, /class="three-pane hub-gated"/);
  });

  // Settings and task creation belong in the compact context region above
  // the activity tabs. In the hub, the left sidebar is intentionally limited
  // to workspace navigation, so the controls never compete with that list.
  function contextSection(html) {
    const start = html.indexOf('class="workspace-context"');
    assert.ok(start >= 0, "workspace context must exist");
    const after = html.indexOf('class="tabs', start);
    assert.ok(after > start, "activity tabs must follow workspace context");
    return html.slice(start, after);
  }

  test("workspace shell: start-task/guidance/limits controls are collapsed in the context region above activity", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}`, { headers: { cookie } }), env);
    const html = await res.text();
    const context = contextSection(html);
    ["new-task-goal", "guidance-text", "limits-value"].forEach((id) => {
      assert.match(context, new RegExp(`id="${id}"`), id + " must be inside workspace context");
    });
    assert.match(context, /<details class="settings-disclosure">/);
    const afterContext = html.slice(html.indexOf('class="tabs'));
    ["new-task-goal", "guidance-text", "limits-value"].forEach((id) => {
      assert.doesNotMatch(afterContext, new RegExp(`id="${id}"`), id + " must not also appear in the activity panes");
    });
  });

  test("hub shell: workspace picker stays in the sidebar while selected-workspace controls live in context", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { hubGptToken } = makeHub(env, instanceFor);
    const cookie = await loginHubAndGetCookie(env, hubGptToken);
    const res = await worker.fetch(req(`/dashboard/hub`, { headers: { cookie } }), env);
    const html = await res.text();
    const sidebarStart = html.indexOf('class="workspace-sidebar"');
    const contextStart = html.indexOf('class="workspace-context"');
    const sidebar = html.slice(sidebarStart, contextStart);
    assert.match(sidebar, /id="workspace-list"/);
    ["new-task-goal", "guidance-text", "limits-value"].forEach((id) => {
      assert.doesNotMatch(sidebar, new RegExp(`id="${id}"`), id + " must not be inside the workspace sidebar");
      assert.match(contextSection(html), new RegExp(`id="${id}"`), id + " must be inside selected workspace context");
    });
  });

  // The Tasks/Messages tab strip and their list/detail columns start hidden
  // for the hub shell until a workspace is picked (there is nothing to show
  // tabs for otherwise) — selectWorkspace() reveals them via the shared
  // "hub-gated" class (see hub-app.js).
  test("hub shell's Tasks/Messages tabs and list/detail columns start hidden until a workspace is selected", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { hubGptToken } = makeHub(env, instanceFor);
    const cookie = await loginHubAndGetCookie(env, hubGptToken);
    const res = await worker.fetch(req(`/dashboard/hub`, { headers: { cookie } }), env);
    const html = await res.text();
    ["tab-tasks", "tab-messages"].forEach((id) => {
      const tag = tagWithId(html, id);
      // the tag containing this id is the tab button itself; its ancestor
      // .tabs.hub-gated element carries the `hidden` attribute, so check the
      // wrapping tabs block directly instead.
      assert.ok(tag);
    });
    const tabsBlockMatch = html.match(/<div class="tabs hub-gated" role="tablist"[^>]*>/);
    assert.ok(tabsBlockMatch, "the Tasks/Messages tabs wrapper must exist");
    assert.match(tabsBlockMatch[0], /hidden/, "the tabs wrapper must start hidden before a workspace is selected");
    assert.match(tagWithId(html, "tasks-list-col"), /hidden/, "tasks-list-col must start hidden");
    assert.match(tagWithId(html, "tasks-detail"), /hidden/, "tasks-detail must start hidden");
  });

  // Not a naive /innerHTML/ word match — both files legitimately contain the
  // comment "Never innerHTML, even to clear ...", which a bare word match
  // would misreport as a violation. Check the actual unsafe sinks instead.
  const UNSAFE_HTML_SINKS = [/\.innerHTML\s*=/, /\.outerHTML\s*=/, /insertAdjacentHTML\s*\(/, /document\.write\s*\(/];
  test("workspace app.js uses no unsafe HTML-insertion sink, only textContent/element construction", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId } = makeProvisionedWorkspace(env, instanceFor);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}/app.js`), env);
    const js = await res.text();
    assert.match(js, /Never innerHTML/, "the safety-rationale comment itself is expected and must not trip the sink check below");
    UNSAFE_HTML_SINKS.forEach((pattern) => assert.doesNotMatch(js, pattern, "must not use " + pattern));
    assert.match(js, /function el\(tag, opts\)/, "must still build all elements through the shared el() helper");
    assert.match(js, /\.textContent = /);
  });

  test("hub app.js uses no unsafe HTML-insertion sink, only textContent/element construction", async () => {
    const { env } = makeRealBridgeDoEnv();
    const res = await worker.fetch(req(`/dashboard/hub/app.js`), env);
    const js = await res.text();
    assert.match(js, /Never innerHTML/);
    UNSAFE_HTML_SINKS.forEach((pattern) => assert.doesNotMatch(js, pattern, "must not use " + pattern));
    assert.match(js, /function el\(tag, opts\)/);
  });

  // The task/message stage mapping is the source of truth for the
  // [Web]-[Hub]-[Local] indicator (docs/plans/dashboard-ux-redesign.md's
  // "3ステージマッピング"). Pin that all 5 protocolState values and the
  // message dir/state branches are actually present in both copies.
  function assertStageMappingPresent(js) {
    const taskStageIdx = js.indexOf("function taskStage(t)");
    assert.ok(taskStageIdx >= 0, "taskStage(t) must exist");
    const taskStageBody = js.slice(taskStageIdx, js.indexOf("\n  }\n", taskStageIdx) + 5);
    ["WAITING_PLAN", "EXECUTING", "WAITING_REVIEW", "DONE", "BLOCKED"].forEach((s) => {
      assert.match(taskStageBody, new RegExp(s), "taskStage must branch on " + s);
    });

    const messageStageIdx = js.indexOf("function messageStage(m)");
    assert.ok(messageStageIdx >= 0, "messageStage(m) must exist");
    const messageStageBody = js.slice(messageStageIdx, js.indexOf("\n  }\n", messageStageIdx) + 5);
    assert.match(messageStageBody, /m\.dir === "to_gpt"/);
    assert.match(messageStageBody, /m\.state === "pending"/);
    assert.match(messageStageBody, /m\.state === "leased"/);
    assert.match(messageStageBody, /m\.state === "acked"/);
  }

  test("workspace app.js's stage mapping covers all 5 protocolState values and the message dir/state branches", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId } = makeProvisionedWorkspace(env, instanceFor);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}/app.js`), env);
    assertStageMappingPresent(await res.text());
  });

  test("hub app.js's stage mapping covers all 5 protocolState values and the message dir/state branches", async () => {
    const { env } = makeRealBridgeDoEnv();
    const res = await worker.fetch(req(`/dashboard/hub/app.js`), env);
    assertStageMappingPresent(await res.text());
  });

  // Unicode-safe truncation: must slice on code points (Array.from), not
  // UTF-16 code units, so a surrogate pair is never split in half.
  function assertTruncationContract(js) {
    assert.match(js, /LIST_PREVIEW_CHARS\s*=\s*180/);
    assert.match(js, /DETAIL_PREVIEW_CHARS\s*=\s*1200/);
    const fnIdx = js.indexOf("function truncateText(value, maxChars)");
    assert.ok(fnIdx >= 0, "truncateText(value, maxChars) must exist");
    const fnBody = js.slice(fnIdx, fnIdx + 400);
    assert.match(fnBody, /Array\.from\(/, "must slice on code points via Array.from, not a raw UTF-16 .slice()");
  }

  test("workspace app.js defines the 180/1200-char, code-point-safe truncation contract", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId } = makeProvisionedWorkspace(env, instanceFor);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}/app.js`), env);
    assertTruncationContract(await res.text());
  });

  test("hub app.js defines the 180/1200-char, code-point-safe truncation contract", async () => {
    const { env } = makeRealBridgeDoEnv();
    const res = await worker.fetch(req(`/dashboard/hub/app.js`), env);
    assertTruncationContract(await res.text());
  });

  // Read more/Show less accessibility contract: aria-expanded paired with
  // aria-controls, per docs/plans/dashboard-ux-redesign.md Phase 4.
  test("workspace app.js's expandable sections wire aria-expanded/aria-controls, never innerHTML", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId } = makeProvisionedWorkspace(env, instanceFor);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}/app.js`), env);
    const js = await res.text();
    assert.match(js, /setAttribute\("aria-expanded"/);
    assert.match(js, /setAttribute\("aria-controls"/);
  });

  // Selection-snapshot contract (docs/plans/dashboard-ux-redesign.md's
  // "選択スナップショットの契約"): selectTask/selectMessage must be called
  // with the row *object*, not a bare id, so the detail pane can survive a
  // later poll dropping the row off the first refreshed page.
  function assertSelectionSnapshotContract(js) {
    assert.doesNotMatch(js, /selectTask\(t\.taskId\)/, "must pass the row object, not a bare taskId, to selectTask");
    assert.doesNotMatch(js, /selectMessage\(m\.messageId\)/, "must pass the row object, not a bare messageId, to selectMessage");
    assert.match(js, /state\.selectedTask\s*=\s*t;/, "selectTask must store a full row snapshot, not just the id");
    assert.match(js, /state\.selectedMessage\s*=\s*m;/, "selectMessage must store a full row snapshot, not just the id");
  }

  test("workspace app.js's selectTask/selectMessage take the row object and store a snapshot", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId } = makeProvisionedWorkspace(env, instanceFor);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}/app.js`), env);
    assertSelectionSnapshotContract(await res.text());
  });

  test("hub app.js's selectTask/selectMessage take the row object and store a snapshot", async () => {
    const { env } = makeRealBridgeDoEnv();
    const res = await worker.fetch(req(`/dashboard/hub/app.js`), env);
    assertSelectionSnapshotContract(await res.text());
  });
});
