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
import COMMON_DASHBOARD_APP_JS from "../worker/src/dashboard/common-app.js";
import WORKSPACE_PANEL_JS from "../worker/src/dashboard/workspace-panel.js";
import DASHBOARD_CSS from "../worker/src/dashboard/dashboard.css";

if (typeof globalThis.WebSocketPair === "undefined") {
  class FakeWebSocket {
    constructor() {
      this.sent = [];
      this.closed = null;
      this.attachment = null;
    }
    send(data) { this.sent.push(data); }
    close(code, reason) { this.closed = { code, reason }; }
    serializeAttachment(att) { this.attachment = att; }
    deserializeAttachment() { return this.attachment; }
  }
  globalThis.WebSocketPair = class WebSocketPair {
    constructor() {
      this[0] = new FakeWebSocket();
      this[1] = new FakeWebSocket();
    }
  };
}

const OriginalResponse = globalThis.Response;
try {
  new OriginalResponse(null, { status: 101 });
} catch {
  class PatchedResponse extends OriginalResponse {
    constructor(body, init) {
      if (init && init.status === 101) {
        super(null, { status: 200, headers: init.headers });
        Object.defineProperty(this, "status", { value: 101, writable: false });
        if (init.webSocket) this.webSocket = init.webSocket;
        return;
      }
      super(body, init);
    }
  }
  globalThis.Response = PatchedResponse;
}

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
    if (!instances.has(name)) {
      const ctx = makeFakeCtx();
      ctx.id = { name };
      const sockets = new Map();
      const waitedPromises = [];
      ctx.waitUntil = (p) => { waitedPromises.push(p); };
      ctx.waitedPromises = waitedPromises;
      ctx.acceptWebSocket = (ws, tags = []) => {
        ws.tags = tags;
        for (const t of tags) {
          if (!sockets.has(t)) sockets.set(t, new Set());
          sockets.get(t).add(ws);
        }
      };
      ctx.getWebSockets = (tag) => {
        if (!tag) {
          const all = new Set();
          for (const s of sockets.values()) {
            for (const ws of s) all.add(ws);
          }
          return Array.from(all);
        }
        return Array.from(sockets.get(tag) || []);
      };
      instances.set(name, new BridgeDO(ctx, env));
    }
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

  test("app.css is served same-origin with a stylesheet content-type and no-store", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId } = makeProvisionedWorkspace(env, instanceFor);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}/app.css`), env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/css/);
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

  test("BridgeDO keeps its dashboardApiDispatch compatibility delegate after the dashboard extraction", () => {
    const { instanceFor } = makeRealBridgeDoEnv();
    const doo = instanceFor("0123456789abcdef");
    assert.equal(typeof doo.dashboardApiDispatch, "function");
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

  test("browser-settings get/set/clear round-trip and validation on workspace dashboard", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);

    // Initial state: not set
    const getInit = await worker.fetch(req(`/dashboard/${workspaceId}/api/browser-settings`, { headers: { cookie } }), env);
    assert.equal(getInit.status, 200);
    const initBody = await getInit.json();
    assert.equal(initBody.chatUrlOverride, null);
    assert.equal(initBody.conversationUrl, null);

    // Set valid project override
    const setOverride = await worker.fetch(
      jsonReq(`/dashboard/${workspaceId}/api/browser-settings`, { chatUrlOverride: "https://chatgpt.com/g/g-p-test-proj/project" }, { cookie }),
      env
    );
    assert.equal(setOverride.status, 200);
    const overrideBody = await setOverride.json();
    assert.equal(overrideBody.chatUrlOverride, "https://chatgpt.com/g/g-p-test-proj/project");

    // Invalid project override
    const invalidOverride = await worker.fetch(
      jsonReq(`/dashboard/${workspaceId}/api/browser-settings`, { chatUrlOverride: "https://not-chatgpt.com" }, { cookie }),
      env
    );
    assert.equal((await invalidOverride.json()).error, "INVALID_ARGS");

    // Set conversation URL matching the project
    const setConv = await worker.fetch(
      jsonReq(`/dashboard/${workspaceId}/api/browser-settings`, { conversationUrl: "https://chatgpt.com/g/g-p-test-proj/c/68412345-1234-5678-9abc-def012345678" }, { cookie }),
      env
    );
    assert.equal(setConv.status, 200);
    const convBody = await setConv.json();
    assert.equal(convBody.conversationUrl, "https://chatgpt.com/g/g-p-test-proj/c/68412345-1234-5678-9abc-def012345678");

    // Clear conversation URL (reset conversation)
    const clearConv = await worker.fetch(
      jsonReq(`/dashboard/${workspaceId}/api/browser-settings`, { conversationUrl: null }, { cookie }),
      env
    );
    assert.equal(clearConv.status, 200);
    const clearConvBody = await clearConv.json();
    assert.equal(clearConvBody.conversationUrl, null);
    assert.equal(clearConvBody.chatUrlOverride, "https://chatgpt.com/g/g-p-test-proj/project");

    // Clear project override
    const clearOverride = await worker.fetch(
      jsonReq(`/dashboard/${workspaceId}/api/browser-settings`, { chatUrlOverride: null }, { cookie }),
      env
    );
    assert.equal(clearOverride.status, 200);
    assert.equal((await clearOverride.json()).chatUrlOverride, null);

    // Malformed mutation payloads are rejected with INVALID_ARGS and do not alter state
    for (const badPayload of [null, [], {}, "string", 123]) {
      const res = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/api/browser-settings`, badPayload, { cookie }), env);
      assert.equal((await res.json()).error, "INVALID_ARGS", `payload ${JSON.stringify(badPayload)} must be rejected`);
    }

    // Setting conversationUrl with neither override nor shared hub Project must be rejected
    const noProjectConv = await worker.fetch(
      jsonReq(`/dashboard/${workspaceId}/api/browser-settings`, { conversationUrl: "https://chatgpt.com/g/g-p-test-proj/c/68412345-1234-5678-9abc-def012345678" }, { cookie }),
      env
    );
    assert.equal((await noProjectConv.json()).error, "INVALID_ARGS");

    // Once shared hub Project is set, workspace without override accepts matching conversationUrl
    const { hub } = makeHub(env, instanceFor);
    hub.hubBrowserSettingsSet({ chatUrl: "https://chatgpt.com/g/g-p-shared-proj/project" });

    // Matching shared Project conversation succeeds
    const sharedMatch = await worker.fetch(
      jsonReq(`/dashboard/${workspaceId}/api/browser-settings`, { conversationUrl: "https://chatgpt.com/g/g-p-shared-proj/c/68412345-1234-5678-9abc-def012345678" }, { cookie }),
      env
    );
    assert.equal(sharedMatch.status, 200);
    assert.equal((await sharedMatch.json()).conversationUrl, "https://chatgpt.com/g/g-p-shared-proj/c/68412345-1234-5678-9abc-def012345678");

    // Mismatched conversation against shared Project is rejected
    const sharedMismatch = await worker.fetch(
      jsonReq(`/dashboard/${workspaceId}/api/browser-settings`, { conversationUrl: "https://chatgpt.com/g/g-p-other-proj/c/68412345-1234-5678-9abc-def012345678" }, { cookie }),
      env
    );
    assert.equal((await sharedMismatch.json()).error, "INVALID_ARGS");

    // GET browser-settings returns sharedChatUrl and effectiveProjectUrl
    const getWithShared = await worker.fetch(req(`/dashboard/${workspaceId}/api/browser-settings`, { headers: { cookie } }), env);
    const withSharedBody = await getWithShared.json();
    assert.equal(withSharedBody.sharedChatUrl, "https://chatgpt.com/g/g-p-shared-proj/project");
    assert.equal(withSharedBody.effectiveProjectUrl, "https://chatgpt.com/g/g-p-shared-proj/project");
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

  test("task-filtered metadata history omits bodies while the default response remains compatible", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    doo.sql.exec(
      `INSERT INTO msgs (message_id, dir, task_id, iteration, kind, title, body, state, lease_until, created_at) VALUES ('retained', 'to_gpt', 'task-a', 2, 'EXECUTED', 'Retained exchange title', 'private body', 'acked', NULL, ?), ('other-task', 'to_local', 'task-b', 0, 'PLAN', 'Other title', 'other body', 'pending', NULL, ?)`,
      Date.now(),
      Date.now(),
    );
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const metadataRes = await worker.fetch(req(`/dashboard/${workspaceId}/api/messages?task_id=task-a&include_body=0`, { headers: { cookie } }), env);
    const metadata = await metadataRes.json();
    assert.deepEqual(metadata.messages.map((m) => m.messageId), ["retained"]);
    assert.equal(Object.hasOwn(metadata.messages[0], "body"), false);
    assert.equal(metadata.messages[0].title, "Retained exchange title");
    assert.equal(metadata.messages[0].state, "acked");

    const defaultRes = await worker.fetch(req(`/dashboard/${workspaceId}/api/messages?task_id=task-a`, { headers: { cookie } }), env);
    const defaultJson = await defaultRes.json();
    assert.equal(defaultJson.messages[0].body, "private body");
    assert.equal(defaultJson.messages[0].title, "Retained exchange title");
  });

  test("tasks endpoint uses updatedAt (not taskHistory()'s misnamed created_at) and includes non-terminal tasks", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    doo.localStartTask({ task_id: "t1", goal: "in progress", text: "GOAL:\nin progress" });
    const next = doo.queueNext("t1");
    doo.queueSetTitle({ message_id: next.message_id, task_id: "t1", iteration: 0, title: "Visible task title" });
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}/api/tasks`, { headers: { cookie } }), env);
    const body = await res.json();
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0].protocolState, "WAITING_PLAN");
    assert.equal(body.tasks[0].updatedAt, doo.getTask("t1").updated_at);
    assert.equal(body.tasks[0].title, "Visible task title");
    const overviewResponse = await worker.fetch(req(`/dashboard/${workspaceId}/api/overview`, { headers: { cookie } }), env);
    const overview = await overviewResponse.json();
    assert.equal(overview.activeTask.title, "Visible task title");
  });

  test("tasks endpoint preserves null title for legacy and not-yet-titled tasks", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    doo.localStartTask({ task_id: "untitled", goal: "legacy-compatible goal", text: "GOAL:\nlegacy-compatible goal" });
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}/api/tasks`, { headers: { cookie } }), env);
    assert.equal((await res.json()).tasks[0].title, null);
  });

  test("tasks page newest-first, with a stable (updated_at, task_id) tie-break cursor", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    // Same updated_at for several rows exercises the tie-breaker id half of
    // the keyset cursor (mirrors the message pagination test above) rather
    // than only the timestamp half.
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      doo.sql.exec(
        `INSERT INTO tasks (task_id, goal, title, iteration, protocol_state, waiting_for, task_started_at, updated_at, terminal_summary) VALUES (?, ?, NULL, 0, 'WAITING_PLAN', 'WEB', ?, ?, NULL)`,
        `task-${i}`,
        `goal-${i}`,
        now,
        now,
      );
    }
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const page1 = await worker.fetch(req(`/dashboard/${workspaceId}/api/tasks?limit=2`, { headers: { cookie } }), env);
    const body1 = await page1.json();
    assert.equal(body1.tasks.length, 2);
    assert.ok(body1.nextCursor);

    const page2 = await worker.fetch(
      req(`/dashboard/${workspaceId}/api/tasks?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`, { headers: { cookie } }),
      env,
    );
    const body2 = await page2.json();
    assert.equal(body2.tasks.length, 2);

    const seenIds = new Set([...body1.tasks, ...body2.tasks].map((t) => t.taskId));
    assert.equal(seenIds.size, 4, "no row skipped or duplicated across pages despite identical timestamps");
  });
});

describe("dashboard: consolidated snapshot API", () => {
  test("direct GET /api/snapshot returns overview, tasks, and messages matching individual first-page responses", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "message body 1" });
    const now = Date.now();
    doo.sql.exec(
      `INSERT INTO tasks (task_id, goal, title, iteration, protocol_state, waiting_for, task_started_at, updated_at, terminal_summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "t2",
      "test goal",
      "test title",
      0,
      "WAITING_PLAN",
      "PLAN",
      now - 1000,
      now,
      null,
    );
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);

    // Direct snapshot
    const snapRes = await worker.fetch(req(`/dashboard/${workspaceId}/api/snapshot?limit=10`, { headers: { cookie } }), env);
    assert.equal(snapRes.status, 200);
    const snap = await snapRes.json();

    // Individual endpoints
    const overviewRes = await worker.fetch(req(`/dashboard/${workspaceId}/api/overview`, { headers: { cookie } }), env);
    const overviewExpected = await overviewRes.json();
    const tasksRes = await worker.fetch(req(`/dashboard/${workspaceId}/api/tasks?limit=10`, { headers: { cookie } }), env);
    const tasksExpected = await tasksRes.json();
    const messagesRes = await worker.fetch(req(`/dashboard/${workspaceId}/api/messages?limit=10`, { headers: { cookie } }), env);
    const messagesExpected = await messagesRes.json();

    assert.deepEqual(snap.overview, overviewExpected);
    assert.deepEqual(snap.tasks, tasksExpected);
    assert.deepEqual(snap.messages, messagesExpected);
  });

  test("direct GET /api/snapshot respects include_tasks=0 and include_messages=0 filtering", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "msg" });
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);

    // include_messages=0
    const noMsgRes = await worker.fetch(req(`/dashboard/${workspaceId}/api/snapshot?include_messages=0`, { headers: { cookie } }), env);
    const noMsg = await noMsgRes.json();
    assert.ok(noMsg.overview);
    assert.ok(noMsg.tasks);
    assert.equal(noMsg.messages, undefined);

    // include_tasks=0
    const noTasksRes = await worker.fetch(req(`/dashboard/${workspaceId}/api/snapshot?include_tasks=0`, { headers: { cookie } }), env);
    const noTasks = await noTasksRes.json();
    assert.ok(noTasks.overview);
    assert.equal(noTasks.tasks, undefined);
    assert.ok(noTasks.messages);
  });

  test("hub relay forwards snapshot queries and preserves filtering and isolation", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo } = makeProvisionedWorkspace(env, instanceFor);
    const { hub, hubGptToken } = makeHub(env, instanceFor);
    hub.registerWorkspace({ workspace_id: workspaceId, name: "A" });
    doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "msg" });
    const cookie = await loginHubAndGetCookie(env, hubGptToken);

    const res = await worker.fetch(
      req(`/dashboard/hub/api/workspaces/${workspaceId}/snapshot?limit=5&include_messages=0`, { headers: { cookie } }),
      env,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.overview);
    assert.ok(body.tasks);
    assert.equal(body.messages, undefined);

    // Isolation: unregistered workspace is 404
    const unregRes = await worker.fetch(
      req(`/dashboard/hub/api/workspaces/unknownworkspace12/snapshot`, { headers: { cookie } }),
      env,
    );
    assert.equal(unregRes.status, 404);
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
    assert.equal(doo.getTask("t1").protocol_state, "EXECUTING", "PLAN ack transitions task to EXECUTING");
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

describe("dashboard: complete-task and continue-task", () => {
  test("complete-task transitions LOCAL_DECISION task to DONE", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    doo.localStartTask({ task_id: "t-dec", goal: "review task", text: "INIT" });
    doo.queueNext("t-dec");
    const sub = doo.queueSubmit({ task_id: "t-dec", iteration: 0, state: "DONE", body: "Looks good" });
    doo.localAck({ message_id: sub.structuredContent.message_id });
    assert.equal(doo.getTask("t-dec").waiting_for, "LOCAL_DECISION");

    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/api/complete-task`, { taskId: "t-dec" }, { cookie }), env);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);

    const task = doo.getTask("t-dec");
    assert.equal(task.protocol_state, "DONE");
    assert.equal(task.waiting_for, "none");
    assert.equal(task.terminal_summary, "Looks good");
  });

  test("continue-task transitions LOCAL_DECISION task to EXECUTING and clears terminal_summary", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    doo.localStartTask({ task_id: "t-cont", goal: "review task", text: "INIT" });
    doo.queueNext("t-cont");
    const sub = doo.queueSubmit({ task_id: "t-cont", iteration: 0, state: "DONE", body: "Review points" });
    doo.localAck({ message_id: sub.structuredContent.message_id });

    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/api/continue-task`, { taskId: "t-cont" }, { cookie }), env);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);

    const task = doo.getTask("t-cont");
    assert.equal(task.protocol_state, "EXECUTING");
    assert.equal(task.waiting_for, "none");
    assert.equal(task.terminal_summary, null);
  });

  test("complete-task and continue-task reject task not in LOCAL_DECISION with INVALID_STATE", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    doo.localStartTask({ task_id: "t-wrong", goal: "running", text: "INIT" });

    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res1 = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/api/complete-task`, { taskId: "t-wrong" }, { cookie }), env);
    assert.equal((await res1.json()).error, "INVALID_STATE");

    const res2 = await worker.fetch(jsonReq(`/dashboard/${workspaceId}/api/continue-task`, { taskId: "t-wrong" }, { cookie }), env);
    assert.equal((await res2.json()).error, "INVALID_STATE");
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
  test("the HTML shell permits only same-origin scripts and styles, with no-store and no-referrer", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId } = makeProvisionedWorkspace(env, instanceFor);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}`), env);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    const csp = res.headers.get("content-security-policy");
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /style-src 'self'/);
    assert.doesNotMatch(csp, /(?:script|style)-src[^;]*unsafe-inline/);
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

  test("/dashboard/hub/app.css is served same-origin with a stylesheet content-type", async () => {
    const { env } = makeRealBridgeDoEnv();
    const res = await worker.fetch(req(`/dashboard/hub/app.css`), env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/css/);
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

    // complete-task through the hub
    doo.localStartTask({ task_id: "t-dec-hub", goal: "review", text: "GOAL:\nreview", force: true });
    doo.queueNext("t-dec-hub");
    const subHubDone = doo.queueSubmit({ task_id: "t-dec-hub", iteration: 0, state: "DONE", body: "Review done" });
    doo.localAck({ message_id: subHubDone.structuredContent.message_id });
    assert.equal(doo.getTask("t-dec-hub").waiting_for, "LOCAL_DECISION");

    const completeRes = await worker.fetch(jsonReq(`/dashboard/hub/api/workspaces/${workspaceId}/complete-task`, { taskId: "t-dec-hub" }, { cookie }), env);
    assert.equal((await completeRes.json()).ok, true);
    assert.equal(doo.getTask("t-dec-hub").protocol_state, "DONE");

    // continue-task through the hub
    doo.localStartTask({ task_id: "t-cont-hub", goal: "review2", text: "GOAL:\nreview2" });
    doo.queueNext("t-cont-hub");
    const subHubDone2 = doo.queueSubmit({ task_id: "t-cont-hub", iteration: 0, state: "DONE", body: "Review done 2" });
    doo.localAck({ message_id: subHubDone2.structuredContent.message_id });

    const continueRes = await worker.fetch(jsonReq(`/dashboard/hub/api/workspaces/${workspaceId}/continue-task`, { taskId: "t-cont-hub" }, { cookie }), env);
    assert.equal((await continueRes.json()).ok, true);
    assert.equal(doo.getTask("t-cont-hub").protocol_state, "EXECUTING");
    assert.equal(doo.getTask("t-cont-hub").terminal_summary, null);

    // workspace isolation: complete-task against unregistered workspace is 404
    const unregRes = await worker.fetch(jsonReq(`/dashboard/hub/api/workspaces/unknownworkspace12/complete-task`, { taskId: "any" }, { cookie }), env);
    assert.equal(unregRes.status, 404);
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
    const page1 = await worker.fetch(req(`/dashboard/hub/api/workspaces/${workspaceId}/messages?task_id=t1&include_body=0&limit=2`, { headers: { cookie } }), env);
    const body1 = await page1.json();
    assert.equal(body1.messages.length, 2);
    assert.equal(Object.hasOwn(body1.messages[0], "body"), false);
    assert.ok(body1.nextCursor);
    const page2 = await worker.fetch(
      req(`/dashboard/hub/api/workspaces/${workspaceId}/messages?task_id=t1&include_body=0&limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`, { headers: { cookie } }),
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

    const resetRes = await worker.fetch(jsonReq(`/dashboard/hub/api/workspaces/${workspaceId}/limits`, { maxBodyBytes: null }, { cookie: hubCookie }), env);
    assert.equal(resetRes.status, 200);
    const resetBody = await resetRes.json();
    assert.equal(resetBody.maxBodyBytes, resetBody.default);
  });

  test("shared hub browser-settings get/set/clear round-trip and validation", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { hub, hubGptToken } = makeHub(env, instanceFor);
    const cookie = await loginHubAndGetCookie(env, hubGptToken);

    // Initial state: not set
    const getInit = await worker.fetch(req("/dashboard/hub/api/browser-settings", { headers: { cookie } }), env);
    assert.equal(getInit.status, 200);
    const initBody = await getInit.json();
    assert.equal(initBody.chatUrl, null);

    // Set shared project URL
    const setRes = await worker.fetch(
      jsonReq("/dashboard/hub/api/browser-settings", { chatUrl: "https://chatgpt.com/g/g-p-shared-proj/project" }, { cookie }),
      env
    );
    assert.equal(setRes.status, 200);
    const setBody = await setRes.json();
    assert.equal(setBody.chatUrl, "https://chatgpt.com/g/g-p-shared-proj/project");

    // Invalid project URL rejected
    const invalidRes = await worker.fetch(
      jsonReq("/dashboard/hub/api/browser-settings", { chatUrl: "https://not-chatgpt.com" }, { cookie }),
      env
    );
    assert.equal((await invalidRes.json()).error, "INVALID_ARGS");

    // Clear shared project URL
    const clearRes = await worker.fetch(
      jsonReq("/dashboard/hub/api/browser-settings", { chatUrl: null }, { cookie }),
      env
    );
    assert.equal(clearRes.status, 200);
    assert.equal((await clearRes.json()).chatUrl, null);

    // Malformed mutation payloads on hub API are rejected
    for (const badPayload of [null, [], {}, "string", 123]) {
      const res = await worker.fetch(jsonReq("/dashboard/hub/api/browser-settings", badPayload, { cookie }), env);
      assert.equal((await res.json()).error, "INVALID_ARGS", `hub payload ${JSON.stringify(badPayload)} must be rejected`);
    }
  });

  test("hub relay forwards workspace browser-settings get and set", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo } = makeProvisionedWorkspace(env, instanceFor);
    const { hub, hubGptToken } = makeHub(env, instanceFor);
    hub.registerWorkspace({ workspace_id: workspaceId, name: "Relay Test" });
    const cookie = await loginHubAndGetCookie(env, hubGptToken);

    // Get via hub relay
    const getRes = await worker.fetch(req(`/dashboard/hub/api/workspaces/${workspaceId}/browser-settings`, { headers: { cookie } }), env);
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.chatUrlOverride, null);

    // Set via hub relay
    const setRes = await worker.fetch(
      jsonReq(`/dashboard/hub/api/workspaces/${workspaceId}/browser-settings`, { chatUrlOverride: "https://chatgpt.com/g/g-p-via-hub/project" }, { cookie }),
      env
    );
    assert.equal(setRes.status, 200);
    const setBody = await setRes.json();
    assert.equal(setBody.chatUrlOverride, "https://chatgpt.com/g/g-p-via-hub/project");
    assert.equal(doo.localBrowserSettingsGet().chatUrlOverride, "https://chatgpt.com/g/g-p-via-hub/project");

    // Malformed mutation payloads via hub relay are rejected
    const badRelay = await worker.fetch(
      jsonReq(`/dashboard/hub/api/workspaces/${workspaceId}/browser-settings`, [], { cookie }),
      env
    );
    assert.equal((await badRelay.json()).error, "INVALID_ARGS");
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

  test("the shared panel ack handler refreshes the first page rather than passing the response to loadMessages", () => {
    assert.match(WORKSPACE_PANEL_JS, /request\(target, "\/ack"/);
    assert.doesNotMatch(WORKSPACE_PANEL_JS, /\/ack"[\s\S]*?\.then\(loadMessages\)/);
    assert.match(WORKSPACE_PANEL_JS, /loadMessages\(target, false\)/);
  });

  // Regression coverage for the reviewed cross-workspace UI race (a slower
  // response for a previously selected workspace could otherwise overwrite
  // the newly selected workspace's rendered detail, and a stale "Save"
  // click could then write to the wrong target) — source-level, not a
  // browser/DOM test, same rationale as the ack-callback check above.
  test("hub app.js guards every per-workspace request with a selection generation and a fixed target id, never mutable global state alone", async () => {
    const js = HUB_DASHBOARD_APP_JS;

    assert.match(js, /selectionGen/, "must track a selection generation to detect a stale in-flight response");
    assert.match(js, /function wsApiFor\(workspaceId, path, options\)/, "every per-workspace call must take its target workspaceId explicitly");
    assert.doesNotMatch(js, /function wsApi\(path, options\)/, "must not keep the old mutable-state-derived wsApi() helper alongside wsApiFor");

    // selectWorkspace() must clear the previously rendered detail (messages/
    // tasks/guidance/limits) before the newly selected workspace's data
    // arrives, not merely swap the state.workspaceId pointer.
    const selectIndex = js.indexOf("function selectWorkspace(id, name)");
    assert.ok(selectIndex >= 0);
    const selectBody = js.slice(selectIndex, selectIndex + 1000);
    assert.match(selectBody, /selectionGen \+= 1/);
    assert.match(selectBody, /workspaceId: id, generation: state\.selectionGen/);
    assert.match(selectBody, /panel\.activate\(target, \{ clearView: true \}\)/);

    // Every load*() response handler must check the captured generation
    // against the current one before touching the DOM.
    assert.match(WORKSPACE_PANEL_JS, /adapter\.isCurrent\(target\)/);
    assert.match(WORKSPACE_PANEL_JS, /isCurrentTaskHistory\(target, taskId, requestGen\)/);
    assert.match(js, /wsApiFor\(target\.workspaceId, path, options\)/);
  });
});

describe("dashboard: app.js ack callback regression (loadMessages(more) argument coupling)", () => {
  // Source-level regression check, not a browser/DOM test: loadMessages(more)
  // treats any truthy `more` as "load more" (skips clearing the list, may
  // fetch the next cursor page instead of refreshing). `.then(loadMessages)`
  // would silently pass the resolved {ok,status,body} object through as
  // `more`. Assert the served app.js never does that for the ack call, and
  // does call loadMessages(false) (a real page-refresh) afterward instead.
  test("the shared panel ack callback never passes the fetch result to loadMessages", () => {
    assert.doesNotMatch(WORKSPACE_PANEL_JS, /\/ack"[\s\S]*?\.then\(loadMessages\)/);
    assert.match(WORKSPACE_PANEL_JS, /loadMessages\(target, false\)/);
  });
});

// Pins the exact cursor half of the fix: `state.<cursorField> =
// res.body.nextCursor;` must appear in a load*(more)/load*(id, gen, more)
// function body in exactly two places — the Load-more branch and the plain
// (not-yet-expanded) first-page branch — and never inside the expanded-poll
// merge branch. If that branch's `if (res.body.nextCursor) { ... merge ... }`
// were changed to also reassign the state cursor, the deepest boundary from
// Load more would be lost on the very next 10s poll, reintroducing the
// reported bug even though the row-merging assertions above would still
// pass. Also pins that the collapse sub-branch (first page now covers
// everything) resets to cursor=null/expanded=false, and that the Load more
// button's visibility reads the retained state cursor, not the raw response.
function assertExpandedPollNeverOverwritesDeepestCursor(fnBody, cursorField, expandedField) {
  const assignPattern = new RegExp("state\\." + cursorField + " = res\\.body\\.nextCursor;", "g");
  const assignCount = (fnBody.match(assignPattern) || []).length;
  assert.equal(
    assignCount,
    2,
    "state." + cursorField + " = res.body.nextCursor must be assigned by exactly the Load-more branch and the non-expanded first-page branch, never by the expanded-poll merge branch"
  );
  assert.match(
    fnBody,
    new RegExp("state\\." + cursorField + " = null;\\s*state\\." + expandedField + " = false;"),
    "the expanded-poll collapse branch must reset both the cursor and the expanded flag once the first page covers the whole retained dataset"
  );
  assert.match(fnBody, new RegExp("hidden = !state\\." + cursorField + ";"), "Load more visibility must read the retained state cursor");
  assert.doesNotMatch(fnBody, /hidden = !res\.body\.nextCursor;/, "Load more visibility must not read the raw response cursor directly");
}

describe("dashboard: Load more rows survive 10s polling (tasksExpanded/messagesExpanded contract)", () => {
  // Regression coverage for the reported bug: Load more appended rows past
  // the first page, but the 10s poll (loadTasks(false)/loadMessages(false))
  // unconditionally replaced state.tasks/state.messages with a fresh first
  // page and unconditionally overwrote the cursor with the first page's
  // nextCursor, silently dropping every row loaded past page 1 and resetting
  // the "load more" boundary. Source-level regression check, not a
  // browser/DOM test, same rationale as the ack-callback checks above.
  test("shared panel tracks expansion state and merges (not replaces) the list once Load more has been used", () => {
    const js = WORKSPACE_PANEL_JS;

    assert.match(js, /tasksExpanded: false, messagesExpanded: false/, "state must track whether Load more has expanded each list");

    const loadTasksIndex = js.indexOf("function applyTasksPage(res, target, more)");
    assert.ok(loadTasksIndex >= 0);
    const loadTasksBody = js.slice(loadTasksIndex, js.indexOf('document.getElementById("tasks-load-more").addEventListener', loadTasksIndex));
    assert.match(loadTasksBody, /state\.tasksExpanded = true/, "Load more must mark the list expanded");
    assert.match(loadTasksBody, /mergeRows\(state\.tasks, rows, "taskId", taskComparator\)/, "an expanded poll response must be merged into the retained cache, not replace it");
    assert.doesNotMatch(loadTasksBody, /if \(!more\) \{\s*state\.tasks = rows;/, "must not unconditionally replace the list on every non-Load-more fetch regardless of expansion state");

    const loadMessagesIndex = js.indexOf("function applyMessagesPage(res, target, more)");
    assert.ok(loadMessagesIndex >= 0);
    const loadMessagesBody = js.slice(loadMessagesIndex, js.indexOf('document.getElementById("messages-load-more").addEventListener', loadMessagesIndex));
    assert.match(loadMessagesBody, /state\.messagesExpanded = true/, "Load more must mark the list expanded");
    assert.match(loadMessagesBody, /mergeRows\(state\.messages, rows, "messageId", messageComparator\)/, "an expanded poll response must be merged into the retained cache, not replace it");
    assert.doesNotMatch(loadMessagesBody, /if \(!more\) \{\s*state\.messages = rows;/, "must not unconditionally replace the list on every non-Load-more fetch regardless of expansion state");

    assertExpandedPollNeverOverwritesDeepestCursor(loadTasksBody, "tasksCursor", "tasksExpanded");
    assertExpandedPollNeverOverwritesDeepestCursor(loadMessagesBody, "messagesCursor", "messagesExpanded");
  });

  test("hub uses the shared Load-more-survives-polling controller and resets it on panel activation", () => {
    const js = WORKSPACE_PANEL_JS;

    assert.match(js, /tasksExpanded: false, messagesExpanded: false/, "state must track whether Load more has expanded each list");

    const resetIndex = js.indexOf("function reset()");
    assert.ok(resetIndex >= 0);
    const selectBody = js.slice(resetIndex, resetIndex + 1000);
    assert.match(selectBody, /tasksExpanded: false/, "switching workspaces must reset the previous workspace's expansion state");
    assert.match(selectBody, /messagesExpanded: false/, "switching workspaces must reset the previous workspace's expansion state");

    const loadTasksIndex = js.indexOf("function applyTasksPage(res, target, more)");
    assert.ok(loadTasksIndex >= 0);
    const loadTasksBody = js.slice(loadTasksIndex, js.indexOf('document.getElementById("tasks-load-more").addEventListener', loadTasksIndex));
    assert.match(loadTasksBody, /state\.tasksExpanded = true/);
    assert.match(loadTasksBody, /mergeRows\(state\.tasks, rows, "taskId", taskComparator\)/);

    const loadMessagesIndex = js.indexOf("function applyMessagesPage(res, target, more)");
    assert.ok(loadMessagesIndex >= 0);
    const loadMessagesBody = js.slice(loadMessagesIndex, js.indexOf('document.getElementById("messages-load-more").addEventListener', loadMessagesIndex));
    assert.match(loadMessagesBody, /state\.messagesExpanded = true/);
    assert.match(loadMessagesBody, /mergeRows\(state\.messages, rows, "messageId", messageComparator\)/);

    assertExpandedPollNeverOverwritesDeepestCursor(loadTasksBody, "tasksCursor", "tasksExpanded");
    assertExpandedPollNeverOverwritesDeepestCursor(loadMessagesBody, "messagesCursor", "messagesExpanded");
  });
});

describe("dashboard: task exchange-history detail", () => {
  test("shared panel loads all body-free task messages, renders them chronologically, and guards stale responses", () => {
    [WORKSPACE_PANEL_JS].forEach((js) => {
      assert.match(js, /function renderTaskHistory\(t\)/);
      assert.match(js, /Exchange history/);
      assert.match(js, /task-history-list/);
      assert.match(COMMON_DASHBOARD_APP_JS, /function formatTimelineTime\(ms\)/);
      assert.match(js, /encodeURIComponent\(taskId\).*include_body=0/);
      assert.match(js, /function loadTaskHistory\(/);
      assert.match(js, /res\.body\.nextCursor/);
      assert.match(js, /a\.createdAt - b\.createdAt/);
      assert.match(js, /String\(a\.messageId\)\.localeCompare\(String\(b\.messageId\)\)/);
      assert.match(js, /m\.kind \|\| "UNKNOWN"/);
      assert.doesNotMatch(js.slice(js.indexOf("function renderTaskHistory"), js.indexOf("function isCurrentTaskHistory")), /m\.body/);
    });
    assert.match(WORKSPACE_PANEL_JS, /taskHistoryRequestGen/);
    assert.match(WORKSPACE_PANEL_JS, /state\.selectedTaskId === taskId/);
    assert.match(HUB_DASHBOARD_APP_JS, /state\.workspaceId === target\.workspaceId && state\.selectionGen === target\.generation/);
    assert.match(HUB_DASHBOARD_APP_JS, /wsApiFor\(target\.workspaceId, path, options\)/);
  });

  test("shared modules render exchange history titles and prefer message titles in message lists", () => {
    assert.match(COMMON_DASHBOARD_APP_JS, /function messageListLabel\(message\)/);
    assert.match(COMMON_DASHBOARD_APP_JS, /typeof message\.title === "string" && message\.title/);
    ["task-history-title", "message-title", "message-detail-title"].forEach((className) => assert.match(WORKSPACE_PANEL_JS, new RegExp(className)));
    assert.match(DASHBOARD_CSS, /\.task-history-title/);
    assert.match(DASHBOARD_CSS, /\.list-row \.message-title/);
    assert.match(DASHBOARD_CSS, /\.message-detail-title/);
  });
});

describe("dashboard: Phase 4 browser ESM/controller boundaries", () => {
  test("panel imports only the relative common helper module and both entries dynamically load it from their own base", () => {
    assert.match(WORKSPACE_PANEL_JS, /from "\.\/common-app\.js"/);
    assert.doesNotMatch(WORKSPACE_PANEL_JS, /from "https?:\/\//);
    [WORKSPACE_DASHBOARD_APP_JS, HUB_DASHBOARD_APP_JS].forEach((js) => {
      assert.match(js, /import\("\.\/workspace-panel\.js"\)/);
      assert.doesNotMatch(js, /import\("https?:\/\//);
    });
  });

  test("direct and hub entries preserve their distinct polling, discard, and navigator-refresh policies", () => {
    assert.match(WORKSPACE_DASHBOARD_APP_JS, /discardMessageRefresh: "messages"/);
    assert.match(WORKSPACE_DASHBOARD_APP_JS, /panel\.pollActivity\(\)/);
    assert.match(HUB_DASHBOARD_APP_JS, /discardMessageRefresh: "all"/);
    assert.doesNotMatch(HUB_DASHBOARD_APP_JS, /onTaskStarted:\s*function\s*\(\)\s*\{\s*loadWorkspaceList\(\);?\s*\}/);
    assert.match(HUB_DASHBOARD_APP_JS, /panel\.pollActivity\(\)/);
  });

  test("direct and hub entries adapt cadence to visibility and task activity using completion-driven scheduling", () => {
    [WORKSPACE_DASHBOARD_APP_JS, HUB_DASHBOARD_APP_JS].forEach((js) => {
      assert.match(js, /visibilitychange/);
      assert.match(js, /document\.hidden/);
      assert.match(js, /ACTIVE_POLL_MS\s*=\s*30000/);
      assert.match(js, /IDLE_POLL_MS\s*=\s*120000/);
      assert.match(js, /setTimeout\(/);
      assert.doesNotMatch(js, /setInterval\(/);
      assert.match(js, /panel\.hasActiveTask\(\)/);
    });
    assert.match(HUB_DASHBOARD_APP_JS, /LIST_POLL_MS\s*=\s*60000/);
    assert.match(HUB_DASHBOARD_APP_JS, /scheduleNextList/);
    assert.match(HUB_DASHBOARD_APP_JS, /scheduleNextActivity/);
  });

  test("shared panel optimizes activity polling by subview and immediately catches up on tab switch", () => {
    assert.match(WORKSPACE_PANEL_JS, /function pollActivity\(\)/);
    assert.match(WORKSPACE_PANEL_JS, /state\.activitySubview === "messages"/);
    assert.match(WORKSPACE_PANEL_JS, /function hasActiveTask\(\)/);
    assert.match(WORKSPACE_PANEL_JS, /Boolean\(state\.activeTaskId\)/);
    const tabSwitchBody = WORKSPACE_PANEL_JS.slice(WORKSPACE_PANEL_JS.indexOf("function setActivityTab"), WORKSPACE_PANEL_JS.indexOf('node("tab-tasks").addEventListener'));
    assert.match(tabSwitchBody, /loadSnapshot\(currentTarget,\s*\{\s*messages:\s*false\s*\}\)/);
    assert.match(tabSwitchBody, /loadSnapshot\(currentTarget,\s*\{\s*tasks:\s*false\s*\}\)/);
  });

  test("shared panel activation and polling consolidate activity reads through snapshot", () => {
    assert.match(WORKSPACE_PANEL_JS, /function loadSnapshot\(target, options\)/);
    assert.match(WORKSPACE_PANEL_JS, /request\(target, "\/snapshot" \+ q\)/);
    const loadAllBody = WORKSPACE_PANEL_JS.slice(WORKSPACE_PANEL_JS.indexOf("function loadAll()"), WORKSPACE_PANEL_JS.indexOf("function pollActivity()"));
    assert.match(loadAllBody, /loadSnapshot\(target\)/);
    assert.doesNotMatch(loadAllBody, /loadOverview/);
    assert.doesNotMatch(loadAllBody, /loadTasks/);
    assert.doesNotMatch(loadAllBody, /loadMessages/);
    const pollActivityBody = WORKSPACE_PANEL_JS.slice(WORKSPACE_PANEL_JS.indexOf("function pollActivity()"), WORKSPACE_PANEL_JS.indexOf("function refreshAll()"));
    assert.match(pollActivityBody, /loadSnapshot\(target, \{\s*tasks:\s*false\s*\}\)/);
    assert.match(pollActivityBody, /loadSnapshot\(target, \{\s*messages:\s*false\s*\}\)/);
    assert.match(WORKSPACE_PANEL_JS, /request\(target, "\/tasks" \+ q\)/);
    assert.match(WORKSPACE_PANEL_JS, /request\(target, "\/messages" \+ q\)/);
  });

  test("direct and hub entries re-arm activity schedulers when panel notifies activity state changes", () => {
    assert.match(WORKSPACE_PANEL_JS, /adapter\.onActivityStateChanged/);
    assert.match(WORKSPACE_DASHBOARD_APP_JS, /onActivityStateChanged:\s*function\s*\(\)\s*\{\s*if\s*\(!document\.hidden\s*&&\s*!wsHealthy\)\s*scheduleNext\(\);?\s*\}/);
    assert.match(HUB_DASHBOARD_APP_JS, /onActivityStateChanged:\s*function\s*\(\)\s*\{\s*if\s*\(state\.workspaceId\s*&&\s*!document\.hidden\s*&&\s*!wsHealthy\)\s*scheduleNextActivity\(\);?\s*\}/);
  });

  test("panel applies adapter and task-history request generations together, including recursive pages", () => {
    assert.match(WORKSPACE_PANEL_JS, /currentTarget === target && adapter\.isCurrent\(target\)/);
    assert.match(WORKSPACE_PANEL_JS, /state\.selectedTaskId === taskId && state\.taskHistoryTaskId === taskId && state\.taskHistoryRequestGen === requestGen/);
    assert.match(WORKSPACE_PANEL_JS, /if \(res\.body\.nextCursor\) \{ loadPage\(res\.body\.nextCursor\); return; \}/);
  });

  test("direct activation preserves shell placeholders while hub selection explicitly clears stale workspace content", () => {
    assert.match(WORKSPACE_PANEL_JS, /function activate\(target, options\).*options && options\.clearView/s);
    assert.match(WORKSPACE_DASHBOARD_APP_JS, /panel\.activate\(target\);/);
    assert.match(HUB_DASHBOARD_APP_JS, /panel\.activate\(target, \{ clearView: true \}\);/);
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

  test("workspace and hub serve the shared ESM module bytes with JavaScript no-store headers", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId } = makeProvisionedWorkspace(env, instanceFor);
    for (const [url, expected] of [
      [`/dashboard/${workspaceId}/common-app.js`, COMMON_DASHBOARD_APP_JS],
      [`/dashboard/${workspaceId}/workspace-panel.js`, WORKSPACE_PANEL_JS],
      ["/dashboard/hub/common-app.js", COMMON_DASHBOARD_APP_JS],
      ["/dashboard/hub/workspace-panel.js", WORKSPACE_PANEL_JS],
    ]) {
      const res = await worker.fetch(req(url), env);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), /javascript/);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(await res.text(), expected);
    }
  });

  test("workspace and hub app.css routes both serve the one imported stylesheet Text module", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId } = makeProvisionedWorkspace(env, instanceFor);
    const workspaceCss = await (await worker.fetch(req(`/dashboard/${workspaceId}/app.css`), env)).text();
    const hubCss = await (await worker.fetch(req(`/dashboard/hub/app.css`), env)).text();
    assert.equal(workspaceCss, DASHBOARD_CSS);
    assert.equal(hubCss, DASHBOARD_CSS);
  });

  test("unauthenticated workspace login HTML resolves every {{marker}}: correct workspaceId and asset URLs, no leftover braces", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId } = makeProvisionedWorkspace(env, instanceFor);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}`), env);
    const html = await res.text();
    assert.match(html, new RegExp(`Workspace: <strong>${workspaceId}</strong>`));
    assert.match(html, new RegExp(`<link rel="stylesheet" href="/dashboard/${workspaceId}/app\\.css">`));
    assert.match(html, new RegExp(`<script type="module" src="/dashboard/${workspaceId}/app\\.js"></script>`));
    assert.doesNotMatch(html, /\{\{|\}\}/, "no unresolved {{marker}} may reach the browser");
  });

  test("authenticated workspace shell HTML resolves every {{marker}}: correct workspaceId and asset URLs, no leftover braces", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const res = await worker.fetch(req(`/dashboard/${workspaceId}`, { headers: { cookie } }), env);
    const html = await res.text();
    assert.match(html, new RegExp(`<h2>${workspaceId}</h2>`));
    assert.match(html, new RegExp(`<link rel="stylesheet" href="/dashboard/${workspaceId}/app\\.css">`));
    assert.match(html, new RegExp(`<script type="module" src="/dashboard/${workspaceId}/app\\.js"></script>`));
    assert.doesNotMatch(html, /\{\{|\}\}/, "no unresolved {{marker}} may reach the browser");
  });

  test("hub login HTML references /dashboard/hub fixed CSS and JS assets, with no leftover braces", async () => {
    const { env } = makeRealBridgeDoEnv();
    const res = await worker.fetch(req(`/dashboard/hub`), env);
    const html = await res.text();
    assert.match(html, /<link rel="stylesheet" href="\/dashboard\/hub\/app\.css">/);
    assert.match(html, /<script type="module" src="\/dashboard\/hub\/app\.js"><\/script>/);
    assert.doesNotMatch(html, /\{\{|\}\}/, "no unresolved {{marker}} may reach the browser");
  });

  test("hub shell HTML references /dashboard/hub fixed CSS and JS assets, with no leftover braces", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { hubGptToken } = makeHub(env, instanceFor);
    const cookie = await loginHubAndGetCookie(env, hubGptToken);
    const res = await worker.fetch(req(`/dashboard/hub`, { headers: { cookie } }), env);
    const html = await res.text();
    assert.match(html, /<link rel="stylesheet" href="\/dashboard\/hub\/app\.css">/);
    assert.match(html, /<script type="module" src="\/dashboard\/hub\/app\.js"><\/script>/);
    assert.doesNotMatch(html, /\{\{|\}\}/, "no unresolved {{marker}} may reach the browser");
  });
});

// ---------------------------------------------------------------------------
// UX redesign (docs/plans/dashboard-ux-redesign.md): Activity/Settings tabs,
// Tasks/Messages sub-tabs, list-pane -> detail-pane split, truncation with
// compact list rows, full detail text, and the [Web]-[Hub]-[Local] stage
// indicator. Frontend-only —
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
    ["new-task-goal", "guidance-text", "limits-value", "chat-project-override", "conversation-url"].forEach((id) => {
      assert.match(context, new RegExp(`id="${id}"`), id + " must be inside workspace context");
    });
    assert.match(context, /<details class="settings-disclosure">/);
    const afterContext = html.slice(html.indexOf('class="tabs'));
    ["new-task-goal", "guidance-text", "limits-value", "chat-project-override", "conversation-url"].forEach((id) => {
      assert.doesNotMatch(afterContext, new RegExp(`id="${id}"`), id + " must not also appear in the activity panes");
    });
  });

  test("hub shell: workspace picker stays in the sidebar while selected-workspace controls live in context", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { hubGptToken } = makeHub(env, instanceFor);
    const cookie = await loginHubAndGetCookie(env, hubGptToken);
    const res = await worker.fetch(req(`/dashboard/hub`, { headers: { cookie } }), env);
    const html = await res.text();
    assert.match(html, /id="hub-shared-project-url"/, "hub shell must contain shared project URL input");
    const sidebarStart = html.indexOf('class="workspace-sidebar"');
    const contextStart = html.indexOf('class="workspace-context"');
    const sidebar = html.slice(sidebarStart, contextStart);
    assert.match(sidebar, /id="workspace-list"/);
    ["new-task-goal", "guidance-text", "limits-value", "chat-project-override", "conversation-url"].forEach((id) => {
      assert.doesNotMatch(sidebar, new RegExp(`id="${id}"`), id + " must not be inside the workspace sidebar");
      assert.match(contextSection(html), new RegExp(`id="${id}"`), id + " must be inside selected workspace context");
    });
  });

  test("workspace and hub shells contain no inline style attributes or style tags (CSP invariant)", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const wsCookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const wsRes = await worker.fetch(req(`/dashboard/${workspaceId}`, { headers: { cookie: wsCookie } }), env);
    const wsHtml = await wsRes.text();

    const { hubGptToken } = makeHub(env, instanceFor);
    const hubCookie = await loginHubAndGetCookie(env, hubGptToken);
    const hubRes = await worker.fetch(req(`/dashboard/hub`, { headers: { cookie: hubCookie } }), env);
    const hubHtml = await hubRes.text();

    [wsHtml, hubHtml].forEach((html) => {
      assert.doesNotMatch(html, /\bstyle\s*=/i, "rendered shell must not contain any inline style attributes");
      assert.doesNotMatch(html, /<style\b/i, "rendered shell must not contain <style> blocks");
    });
  });

  test("browser settings placeholders use canonical /project and /c/ URL shapes", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const wsCookie = await loginAndGetCookie(env, workspaceId, gptToken);
    const wsRes = await worker.fetch(req(`/dashboard/${workspaceId}`, { headers: { cookie: wsCookie } }), env);
    const wsHtml = await wsRes.text();

    assert.match(wsHtml, /id="chat-project-override"[^>]*placeholder="https:\/\/chatgpt\.com\/g\/[^"]+\/project/);
    assert.match(wsHtml, /id="conversation-url"[^>]*placeholder="https:\/\/chatgpt\.com\/g\/[^"]+\/c\//);

    const { hubGptToken } = makeHub(env, instanceFor);
    const hubCookie = await loginHubAndGetCookie(env, hubGptToken);
    const hubRes = await worker.fetch(req(`/dashboard/hub`, { headers: { cookie: hubCookie } }), env);
    const hubHtml = await hubRes.text();

    assert.match(hubHtml, /id="hub-shared-project-url"[^>]*placeholder="https:\/\/chatgpt\.com\/g\/[^"]+\/project/);
    assert.match(hubHtml, /id="chat-project-override"[^>]*placeholder="https:\/\/chatgpt\.com\/g\/[^"]+\/project/);
    assert.match(hubHtml, /id="conversation-url"[^>]*placeholder="https:\/\/chatgpt\.com\/g\/[^"]+\/c\//);
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
  test("shared browser modules use no unsafe HTML-insertion sink", () => {
    [COMMON_DASHBOARD_APP_JS, WORKSPACE_PANEL_JS, WORKSPACE_DASHBOARD_APP_JS, HUB_DASHBOARD_APP_JS].forEach((js) => {
      UNSAFE_HTML_SINKS.forEach((pattern) => assert.doesNotMatch(js, pattern, "must not use " + pattern));
    });
    assert.match(COMMON_DASHBOARD_APP_JS, /Never innerHTML/);
    assert.match(COMMON_DASHBOARD_APP_JS, /function el\(tag, opts\)/);
  });

  // The task/message stage mapping is the source of truth for the
  // [Web]-[Hub]-[Local] indicator (docs/plans/dashboard-ux-redesign.md's
  // "3ステージマッピング"). Pin that all 5 protocolState values and the
  // message dir/state branches are actually present in both copies.
  function assertStageMappingPresent(js) {
    const taskStageIdx = js.indexOf("function taskStage(t)");
    assert.ok(taskStageIdx >= 0, "taskStage(t) must exist");
    const taskStageBody = js.slice(taskStageIdx, taskStageIdx + 1800);
    ["WAITING_PLAN", "EXECUTING", "WAITING_REVIEW", "DONE", "BLOCKED"].forEach((s) => {
      assert.match(taskStageBody, new RegExp(s), "taskStage must branch on " + s);
    });

    const messageStageIdx = js.indexOf("function messageStage(m)");
    assert.ok(messageStageIdx >= 0, "messageStage(m) must exist");
    const messageStageBody = js.slice(messageStageIdx, messageStageIdx + 1000);
    assert.match(messageStageBody, /m\.dir === "to_gpt"/);
    assert.match(messageStageBody, /m\.state === "pending"/);
    assert.match(messageStageBody, /m\.state === "leased"/);
    assert.match(messageStageBody, /m\.state === "acked"/);
  }

  test("common-app.js's stage mapping covers all protocol and message states", () => {
    assertStageMappingPresent(COMMON_DASHBOARD_APP_JS);
  });

  // Unicode-safe list truncation: must slice on code points (Array.from),
  // not UTF-16 code units, so a surrogate pair is never split in half.
  function assertTruncationContract(js) {
    assert.match(js, /LIST_PREVIEW_CHARS\s*=\s*180/);
    const fnIdx = js.indexOf("function truncateText(value, maxChars)");
    assert.ok(fnIdx >= 0, "truncateText(value, maxChars) must exist");
    const fnBody = js.slice(fnIdx, fnIdx + 400);
    assert.match(fnBody, /Array\.from\(/, "must slice on code points via Array.from, not a raw UTF-16 .slice()");
  }

  test("common-app.js defines a 180-char, code-point-safe list truncation contract", () => {
    assertTruncationContract(COMMON_DASHBOARD_APP_JS);
  });

  test("task rows prefer the durable title, preserve the goal fallback, and render both as text", async () => {
    [COMMON_DASHBOARD_APP_JS].forEach((js) => {
      const start = js.indexOf("function taskListLabel(task)");
      const labelFn = js.slice(start, js.indexOf("// ---- 3-stage indicator", start));
      assert.ok(start >= 0, "taskListLabel must exist");
      assert.match(labelFn, /typeof task\.title === "string"/);
      assert.match(labelFn, /truncateText\(task\.goal, LIST_PREVIEW_CHARS\)/);
      assert.match(WORKSPACE_PANEL_JS, /" task-title"/);
      assert.match(WORKSPACE_PANEL_JS, /task-detail-title/);
      assert.doesNotMatch(js, /innerHTML\s*=/);
    });
  });

  test("detail panes show the full text without redundant Read more controls", async () => {
    [WORKSPACE_PANEL_JS].forEach((js) => {
      assert.match(js, /function renderTextSection\(containerId, label, fullText\)/);
      assert.doesNotMatch(js, /function renderExpandable\(/);
      assert.doesNotMatch(js, /DETAIL_PREVIEW_CHARS/);
      assert.doesNotMatch(js, /Read more/);
    });
  });

  test("hub workspace navigator renders only name and an activity badge", async () => {
    const { env } = makeRealBridgeDoEnv();
    const res = await worker.fetch(req(`/dashboard/hub/app.js`), env);
    const js = await res.text();
    const start = js.indexOf("function renderWorkspaceList(data)");
    const listFn = js.slice(start, js.indexOf("function loadWorkspaceList()", start));
    assert.match(listFn, /className: "workspace-choice"/);
    assert.match(listFn, /w\.overview && w\.overview\.activeTask \? "In progress" : "Idle"/);
    assert.doesNotMatch(listFn, /to ChatGPT/);
    assert.doesNotMatch(listFn, /to local/);
  });

  test("hub workspace navigator updates the selected button before loading its detail", async () => {
    const { env } = makeRealBridgeDoEnv();
    const js = await (await worker.fetch(req(`/dashboard/hub/app.js`), env)).text();
    const selectStart = js.indexOf("function selectWorkspace(id, name)");
    const selectFn = js.slice(selectStart, js.indexOf("// ---- overview ----", selectStart));
    assert.match(js, /function updateWorkspaceSelection\(workspaceId\)/);
    assert.match(selectFn, /state\.workspaceId = id; updateWorkspaceSelection\(id\);/);
    assert.match(selectFn, /panel\.activate\(target, \{ clearView: true \}\)/);
    assert.match(js, /setAttribute\("aria-current", "true"\)/);
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

  test("shared workspace panel selectTask/selectMessage take the row object and store a snapshot", () => {
    assertSelectionSnapshotContract(WORKSPACE_PANEL_JS);
  });

  test("shared modules render WAITING_LOCAL sub-states and LOCAL_DECISION action buttons", () => {
    [COMMON_DASHBOARD_APP_JS].forEach((js) => {
      assert.match(js, /WAITING_LOCAL/);
      assert.match(js, /LOCAL_PLAN_ACK/);
      assert.match(js, /LOCAL_DONE_ACK/);
      assert.match(js, /LOCAL_BLOCKED_ACK/);
      assert.match(js, /LOCAL_DECISION/);
    });
    [WORKSPACE_PANEL_JS].forEach((js) => {
      assert.match(js, /Complete task/);
      assert.match(js, /Continue implementation/);
      assert.match(js, /complete-task/);
      assert.match(js, /continue-task/);
      assert.match(js, /decision-actions/);
      assert.doesNotMatch(js, /style:.*margin-top/);
    });

    assert.match(DASHBOARD_CSS, /\.decision-actions/);
  });
});

describe("dashboard: push-first hibernation WebSocket, targeted invalidation, and body-less messages", () => {
  test("workspace and hub /ws require GET, websocket upgrade, strict origin, and valid session cookie", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);

    // non-GET
    const postRes = await worker.fetch(new Request(`${ORIGIN}/dashboard/${workspaceId}/ws`, {
      method: "POST",
      headers: { origin: ORIGIN, upgrade: "websocket", cookie },
    }), env);
    assert.equal(postRes.status, 405);

    // non-upgrade
    const nonUpgradeRes = await worker.fetch(new Request(`${ORIGIN}/dashboard/${workspaceId}/ws`, {
      method: "GET",
      headers: { origin: ORIGIN, cookie },
    }), env);
    assert.equal(nonUpgradeRes.status, 426);

    // cross-origin
    const crossOriginRes = await worker.fetch(new Request(`${ORIGIN}/dashboard/${workspaceId}/ws`, {
      method: "GET",
      headers: { origin: "https://evil.com", upgrade: "websocket", cookie },
    }), env);
    assert.equal(crossOriginRes.status, 403);

    // unauthenticated
    const unauthRes = await worker.fetch(new Request(`${ORIGIN}/dashboard/${workspaceId}/ws`, {
      method: "GET",
      headers: { origin: ORIGIN, upgrade: "websocket" },
    }), env);
    assert.equal(unauthRes.status, 401);

    // valid authenticated upgrade
    const okRes = await worker.fetch(new Request(`${ORIGIN}/dashboard/${workspaceId}/ws`, {
      method: "GET",
      headers: { origin: ORIGIN, upgrade: "websocket", cookie },
    }), env);
    assert.equal(okRes.status, 101);

    // Hub /ws checks
    const hub = instanceFor("gpt-worker-hub");
    const { gptToken: hubGptToken } = hub.provisionHub();
    const hubCookie = await loginHubAndGetCookie(env, hubGptToken);

    const hubUnauthRes = await worker.fetch(new Request(`${ORIGIN}/dashboard/hub/ws`, {
      method: "GET",
      headers: { origin: ORIGIN, upgrade: "websocket" },
    }), env);
    assert.equal(hubUnauthRes.status, 401);

    const hubOkRes = await worker.fetch(new Request(`${ORIGIN}/dashboard/hub/ws`, {
      method: "GET",
      headers: { origin: ORIGIN, upgrade: "websocket", cookie: hubCookie },
    }), env);
    assert.equal(hubOkRes.status, 101);
  });

  test("openDashboardWebSocket receives correct tag and attachment, and closeDashboardSockets closes them", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const cookie = await loginAndGetCookie(env, workspaceId, gptToken);

    let recorded = null;
    const origOpen = doo.openDashboardWebSocket.bind(doo);
    doo.openDashboardWebSocket = ({ tag, attachment }) => {
      recorded = { tag, attachment };
      return origOpen({ tag, attachment });
    };

    const res = await worker.fetch(new Request(`${ORIGIN}/dashboard/${workspaceId}/ws`, {
      method: "GET",
      headers: { origin: ORIGIN, upgrade: "websocket", cookie },
    }), env);
    assert.equal(res.status, 101);
    assert.ok(recorded);
    assert.equal(recorded.tag, "dashboard-workspace");
    assert.equal(recorded.attachment.kind, "dashboard");
    assert.equal(recorded.attachment.role, "workspace");
    assert.ok(recorded.attachment.sessionHash);
    assert.ok(recorded.attachment.expiresAt > Date.now());

    // Verify socket close on logout
    const sockets = doo.ctx.getWebSockets("dashboard-workspace");
    assert.equal(sockets.length, 1);
    const ws = sockets[0];
    assert.equal(ws.closed, null);

    await worker.fetch(req(`/dashboard/${workspaceId}/logout`, {
      method: "POST",
      headers: { origin: ORIGIN, cookie },
    }), env);
    assert.deepEqual(ws.closed, { code: 1008, reason: "session revoked" });
  });

  test("dashboard socket events do not dispatch to local transport or fail pending RPC", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo } = makeProvisionedWorkspace(env, instanceFor);

    let failed = false;
    doo.transport.failAllPending = () => { failed = true; };

    const fakeWs = {
      deserializeAttachment: () => ({ kind: "dashboard" }),
    };

    doo.webSocketMessage(fakeWs, JSON.stringify({ rid: "r1" }));
    doo.webSocketClose(fakeWs);
    doo.webSocketError(fakeWs);
    assert.equal(failed, false, "dashboard socket close/error must not fail local pending RPC");
  });

  test("workspace mutations broadcast activity invalidation to direct socket and relays to hub DO", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo, gptToken } = makeProvisionedWorkspace(env, instanceFor);
    const hub = instanceFor("gpt-worker-hub");
    hub.provisionHub();
    hub.registerWorkspace({ workspace_id: workspaceId, name: "ws1" });

    // Open workspace socket
    const wsPair = new WebSocketPair();
    doo.ctx.acceptWebSocket(wsPair[1], ["dashboard-workspace"]);
    wsPair[1].serializeAttachment({ kind: "dashboard", sessionHash: "h1", expiresAt: Date.now() + 100000 });

    // Open hub socket
    const hubWsPair = new WebSocketPair();
    hub.ctx.acceptWebSocket(hubWsPair[1], ["dashboard-hub"]);
    hubWsPair[1].serializeAttachment({ kind: "dashboard", sessionHash: "h2", expiresAt: Date.now() + 100000 });

    // Perform mutation on workspace: localEnqueue
    doo.localEnqueue({ kind: "INIT", task_id: "t1", iteration: 0, body: "test" });

    // Wait for waitUntil promises if any
    if (doo.ctx.waitedPromises) {
      await Promise.all(doo.ctx.waitedPromises);
    }

    assert.equal(wsPair[1].sent.length, 1);
    const wsMsg = JSON.parse(wsPair[1].sent[0]);
    assert.deepEqual(wsMsg, { type: "invalidate", scope: "activity" });

    assert.equal(hubWsPair[1].sent.length, 1);
    const hubMsg = JSON.parse(hubWsPair[1].sent[0]);
    assert.deepEqual(hubMsg, { type: "invalidate", workspaceId, scope: "activity" });
  });

  test("unregistered workspace invalidation is rejected by hub DO and not broadcast to hub sockets", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const hub = instanceFor("gpt-worker-hub");
    hub.provisionHub();

    const hubWsPair = new WebSocketPair();
    hub.ctx.acceptWebSocket(hubWsPair[1], ["dashboard-hub"]);
    hubWsPair[1].serializeAttachment({ kind: "dashboard", sessionHash: "h2", expiresAt: Date.now() + 100000 });

    const res = await hub.fetch(new Request("https://gpt-worker.internal/hub-dashboard-invalidate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "unregistered_id", scope: "activity" }),
    }));
    assert.equal(res.status, 404);
    assert.equal(hubWsPair[1].sent.length, 0);
  });

  test("register/unregister broadcasts scope: registry, and settings mutation broadcasts scope: settings", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const hub = instanceFor("gpt-worker-hub");
    hub.provisionHub();

    const hubWsPair = new WebSocketPair();
    hub.ctx.acceptWebSocket(hubWsPair[1], ["dashboard-hub"]);
    hubWsPair[1].serializeAttachment({ kind: "dashboard", sessionHash: "h", expiresAt: Date.now() + 100000 });

    hub.registerWorkspace({ workspace_id: "0123456789abcdef", name: "ws" });
    assert.equal(hubWsPair[1].sent.length, 1);
    assert.deepEqual(JSON.parse(hubWsPair[1].sent[0]), { type: "invalidate", scope: "registry" });

    hub.hubBrowserSettingsSet({ chatUrl: "https://chatgpt.com/g/g-p-test/project" });
    assert.equal(hubWsPair[1].sent.length, 2);
    assert.deepEqual(JSON.parse(hubWsPair[1].sent[1]), { type: "invalidate", scope: "settings" });

    hub.unregisterWorkspace({ workspace_id: "0123456789abcdef" });
    assert.equal(hubWsPair[1].sent.length, 3);
    assert.deepEqual(JSON.parse(hubWsPair[1].sent[2]), { type: "invalidate", scope: "registry" });
  });

  test("link connect and webSocketClose trigger activity invalidation", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo } = makeProvisionedWorkspace(env, instanceFor);

    const wsPair = new WebSocketPair();
    doo.ctx.acceptWebSocket(wsPair[1], ["dashboard-workspace"]);
    wsPair[1].serializeAttachment({ kind: "dashboard", sessionHash: "h1", expiresAt: Date.now() + 100000 });

    // handleLink
    const linkSecret = doo.getSecret("link_token");
    const linkReq = new Request(`${ORIGIN}/link/${linkSecret}`, {
      method: "GET",
      headers: { upgrade: "websocket" },
    });
    const linkRes = await doo.handleLink(linkReq, linkSecret);
    assert.equal(linkRes.status, 101);
    assert.equal(wsPair[1].sent.length, 1);
    assert.deepEqual(JSON.parse(wsPair[1].sent[0]), { type: "invalidate", scope: "activity" });

    // webSocketClose on local socket (not dashboard)
    const localWs = { deserializeAttachment: () => ({ connected_at: Date.now() }) };
    doo.webSocketClose(localWs);
    assert.equal(wsPair[1].sent.length, 2);
    assert.deepEqual(JSON.parse(wsPair[1].sent[1]), { type: "invalidate", scope: "activity" });
  });

  test("source contract: direct and hub apps connect to WebSocket and suppress periodic polling while healthy", () => {
    [WORKSPACE_DASHBOARD_APP_JS, HUB_DASHBOARD_APP_JS].forEach((js) => {
      assert.match(js, /new WebSocket\(wsUrl\)/);
      assert.match(js, /wsHealthy\s*=\s*true/);
      assert.match(js, /if\s*\(document\.hidden\s*\|\|\s*wsHealthy\)\s*return;/);
      assert.match(js, /socket\.onclose\s*=\s*function\s*\(\)\s*\{\s*handleWsDown\(socket\);\s*\}/);
      assert.match(js, /socket\.onerror\s*=\s*function\s*\(\)\s*\{\s*handleWsDown\(socket\);\s*\}/);
      assert.match(js, /hasConnectedOnce/);
    });

    // Hub specific: onTaskStarted does not load list, non-selected workspace updates only single row
    assert.match(HUB_DASHBOARD_APP_JS, /refreshSingleWorkspaceStatus\(workspaceId\)/);
    assert.match(HUB_DASHBOARD_APP_JS, /updateWorkspaceRowStatus\(target\.workspaceId,\s*data,\s*null\)/);
  });

  test("source contract: gapless first connection, bounded backoff, and stale socket protection", () => {
    [WORKSPACE_DASHBOARD_APP_JS, HUB_DASHBOARD_APP_JS].forEach((js) => {
      // Stale socket ignore
      assert.match(js, /if\s*\(socket\s*&&\s*socket\s*!==\s*ws\)\s*return;/);
      assert.match(js, /if\s*\(socket\s*!==\s*ws\)\s*return;/);
      assert.match(js, /socket\.onclose\s*=\s*function\s*\(\)\s*\{\s*handleWsDown\(socket\);\s*\}/);
      assert.match(js, /socket\.onerror\s*=\s*function\s*\(\)\s*\{\s*handleWsDown\(socket\);\s*\}/);

      // Bounded backoff
      assert.match(js, /RECONNECT_CAP_MS\s*=\s*60000/);
      assert.match(js, /reconnectDelay\s*===\s*5000\s*\?\s*15000\s*:\s*reconnectDelay\s*===\s*15000\s*\?\s*30000\s*:\s*RECONNECT_CAP_MS/);
      assert.match(js, /reconnectDelay\s*=\s*5000/);

      // Hidden tab stops reconnect timer, visible resumes
      assert.match(js, /clearReconnectTimer\(\)/);
      assert.match(js, /if\s*\(reconnectTimer\s*\|\|\s*document\.hidden\s*\|\|\s*wsHealthy\)\s*return;/);
      assert.match(js, /if\s*\(ws\s*\|\|\s*document\.hidden\)\s*return;/);

      // Gapless first connect: buffers during initial load, catch-up refresh on first open after initial load
      assert.match(js, /initialLoadDone\s*=\s*false/);
      assert.match(js, /initialLoadDone\s*=\s*true/);
    });

    // Direct: first open after initial load refreshes panel
    assert.match(WORKSPACE_DASHBOARD_APP_JS, /if\s*\(hasConnectedOnce\)\s*\{\s*panel\.refreshAll\(\);\s*\}\s*else\s*\{\s*hasConnectedOnce\s*=\s*true;\s*if\s*\(initialLoadDone\)\s*\{\s*panel\.refreshAll\(\);\s*\}\s*\}/);

    // Hub: first open after initial load refreshes list and settings
    assert.match(HUB_DASHBOARD_APP_JS, /if\s*\(hasConnectedOnce\)\s*\{.*loadWorkspaceList\(\);.*loadHubBrowserSettings\(\);/s);
    assert.match(HUB_DASHBOARD_APP_JS, /hasConnectedOnce\s*=\s*true;\s*if\s*\(initialLoadDone\)\s*\{/);
  });

  test("queueSetTitle invalidates on first title change, and does not invalidate on idempotent retry", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo } = makeProvisionedWorkspace(env, instanceFor);

    // Connect WS
    const wsPair = new WebSocketPair();
    doo.ctx.acceptWebSocket(wsPair[1], ["dashboard-workspace"]);
    wsPair[1].serializeAttachment({ kind: "dashboard", sessionHash: "h1", expiresAt: Date.now() + 100000 });

    // Enqueue an INIT task and lease it
    doo.localStartTask({ task_id: "t1", goal: "test goal", text: "GOAL:\ntest goal" });
    const taskId = "t1";
    const nextRes = doo.queueNext({ task_id: taskId });
    const messageId = nextRes.message_id;

    // Wait for waitUntil promises if any
    if (doo.ctx.waitedPromises) await Promise.all(doo.ctx.waitedPromises);
    // Drain any previous sent invalidations
    wsPair[1].sent.length = 0;

    // First set_title: should succeed and notify invalidation
    const res1 = doo.queueSetTitle({
      message_id: messageId,
      task_id: taskId,
      iteration: 0,
      title: "First Title",
    });
    assert.equal(res1.isError, undefined);
    assert.equal(res1.structuredContent?.idempotent, false);
    assert.equal(wsPair[1].sent.length, 1);
    assert.deepEqual(JSON.parse(wsPair[1].sent[0]), { type: "invalidate", scope: "activity" });

    // Idempotent retry with same title: should NOT notify invalidation
    const res2 = doo.queueSetTitle({
      message_id: messageId,
      task_id: taskId,
      iteration: 0,
      title: "First Title",
    });
    assert.equal(res2.isError, undefined);
    assert.equal(res2.structuredContent?.idempotent, true);
    assert.equal(wsPair[1].sent.length, 1); // No new message
  });

  test("alarm() sends activity invalidation when retention purge actually deletes rows", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const { workspaceId, doo } = makeProvisionedWorkspace(env, instanceFor);
    const hub = instanceFor("gpt-worker-hub");
    hub.provisionHub();
    hub.registerWorkspace({ workspace_id: workspaceId, name: "ws1" });

    // Direct socket
    const wsPair = new WebSocketPair();
    doo.ctx.acceptWebSocket(wsPair[1], ["dashboard-workspace"]);
    wsPair[1].serializeAttachment({ kind: "dashboard", sessionHash: "h1", expiresAt: Date.now() + 100000 });

    // Hub socket
    const hubWsPair = new WebSocketPair();
    hub.ctx.acceptWebSocket(hubWsPair[1], ["dashboard-hub"]);
    hubWsPair[1].serializeAttachment({ kind: "dashboard", sessionHash: "h2", expiresAt: Date.now() + 100000 });

    // Case 1: Empty or fresh rows -> alarm() should NOT broadcast invalidation
    await doo.alarm();
    if (doo.ctx.waitedPromises) await Promise.all(doo.ctx.waitedPromises);
    assert.equal(wsPair[1].sent.length, 0);
    assert.equal(hubWsPair[1].sent.length, 0);

    // Insert an expired acked message (> 7 days old)
    const oldCreatedAt = Date.now() - (8 * 24 * 60 * 60 * 1000);
    doo.sql.exec(
      `INSERT INTO msgs (message_id, task_id, iteration, dir, kind, state, lease_until, body, title, created_at)
       VALUES ('old_m1', 't_old', 0, 'to_gpt', 'INIT', 'acked', 0, 'old body', null, ?)`,
      oldCreatedAt
    );

    // Case 2: Alarm with expired message -> deletes row and broadcasts activity invalidation
    await doo.alarm();
    if (doo.ctx.waitedPromises) await Promise.all(doo.ctx.waitedPromises);
    assert.equal(wsPair[1].sent.length, 1);
    assert.deepEqual(JSON.parse(wsPair[1].sent[0]), { type: "invalidate", scope: "activity" });
    assert.equal(hubWsPair[1].sent.length, 1);
    assert.deepEqual(JSON.parse(hubWsPair[1].sent[0]), { type: "invalidate", workspaceId, scope: "activity" });

    // Case 3: Running alarm again immediately -> no rows deleted, no extra invalidation
    await doo.alarm();
    if (doo.ctx.waitedPromises) await Promise.all(doo.ctx.waitedPromises);
    assert.equal(wsPair[1].sent.length, 1);
    assert.equal(hubWsPair[1].sent.length, 1);
  });

  test("real /admin route triggers dashboard invalidations for registry, settings, deprovision and provision", async () => {
    const { env, instanceFor } = makeRealBridgeDoEnv();
    const adminToken = "secret-admin-token-123";
    env.ADMIN_TOKEN = adminToken;

    const hub = instanceFor("gpt-worker-hub");
    hub.provisionHub();

    // Open hub socket
    const hubWsPair = new WebSocketPair();
    hub.ctx.acceptWebSocket(hubWsPair[1], ["dashboard-hub"]);
    hubWsPair[1].serializeAttachment({ kind: "dashboard", sessionHash: "h1", expiresAt: Date.now() + 100000 });

    function adminReq(body) {
      return new Request(`${ORIGIN}/admin/${adminToken}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    // 1. register_workspace via /admin route
    const regRes = await worker.fetch(adminReq({
      op: "register_workspace",
      workspace_id: "0123456789abcdef",
      name: "ws-alpha",
    }), env);
    assert.equal(regRes.status, 200);
    assert.equal(hubWsPair[1].sent.length, 1);
    assert.deepEqual(JSON.parse(hubWsPair[1].sent[0]), { type: "invalidate", scope: "registry" });

    // 2. hub_browser_settings_set via /admin route (invalid args: no event added)
    const badSettingsRes = await worker.fetch(adminReq({
      op: "hub_browser_settings_set",
      chatUrl: "not-a-valid-url",
    }), env);
    assert.equal(badSettingsRes.status, 200);
    const badSettingsBody = await badSettingsRes.json();
    assert.equal(badSettingsBody.error, "INVALID_ARGS");
    assert.equal(hubWsPair[1].sent.length, 1); // no extra event

    // 3. hub_browser_settings_set via /admin route (valid args: emits settings event)
    const goodSettingsRes = await worker.fetch(adminReq({
      op: "hub_browser_settings_set",
      chatUrl: "https://chatgpt.com/g/g-p-test123456789012345678901234/project",
    }), env);
    assert.equal(goodSettingsRes.status, 200);
    assert.equal(hubWsPair[1].sent.length, 2);
    assert.deepEqual(JSON.parse(hubWsPair[1].sent[1]), { type: "invalidate", scope: "settings" });

    // 4. unregister_workspace via /admin route
    const unregRes = await worker.fetch(adminReq({
      op: "unregister_workspace",
      workspace_id: "0123456789abcdef",
    }), env);
    assert.equal(unregRes.status, 200);
    assert.equal(hubWsPair[1].sent.length, 3);
    assert.deepEqual(JSON.parse(hubWsPair[1].sent[2]), { type: "invalidate", scope: "registry" });

    // 5. registered workspace /admin deprovision
    const wsId = "0123456789abcdef";
    const ws = instanceFor(wsId);
    ws.provision();
    hub.registerWorkspace({ workspace_id: wsId, name: "ws-deprov" });
    // Drain previous events
    if (ws.ctx.waitedPromises) await Promise.all(ws.ctx.waitedPromises);
    hubWsPair[1].sent.length = 0;

    // Open direct workspace socket
    const wsPair = new WebSocketPair();
    ws.ctx.acceptWebSocket(wsPair[1], ["dashboard-workspace"]);
    wsPair[1].serializeAttachment({ kind: "dashboard", sessionHash: "w1", expiresAt: Date.now() + 100000 });

    const deprovRes = await worker.fetch(adminReq({
      op: "deprovision",
      workspace_id: wsId,
    }), env);
    assert.equal(deprovRes.status, 200);

    // Wait for ws.ctx.waitUntil relay to hub
    if (ws.ctx.waitedPromises) await Promise.all(ws.ctx.waitedPromises);

    // Workspace socket received activity invalidation
    assert.equal(wsPair[1].sent.length, 1);
    assert.deepEqual(JSON.parse(wsPair[1].sent[0]), { type: "invalidate", scope: "activity" });

    // Hub socket received targeted activity invalidation for that workspaceId
    assert.equal(hubWsPair[1].sent.length, 1);
    assert.deepEqual(JSON.parse(hubWsPair[1].sent[0]), { type: "invalidate", workspaceId: wsId, scope: "activity" });

    // 6. provision via /admin route
    wsPair[1].sent.length = 0;
    hubWsPair[1].sent.length = 0;
    const provRes = await worker.fetch(adminReq({
      op: "provision",
      workspace_id: wsId,
    }), env);
    assert.equal(provRes.status, 200);
    if (ws.ctx.waitedPromises) await Promise.all(ws.ctx.waitedPromises);

    assert.equal(wsPair[1].sent.length, 1);
    assert.deepEqual(JSON.parse(wsPair[1].sent[0]), { type: "invalidate", scope: "activity" });
    assert.equal(hubWsPair[1].sent.length, 1);
    assert.deepEqual(JSON.parse(hubWsPair[1].sent[0]), { type: "invalidate", workspaceId: wsId, scope: "activity" });
  });

  test("source contract: body-less messages in panel, lazy loading, and body preservation", () => {
    // Snapshot and loadMessages include &include_body=0
    assert.match(WORKSPACE_PANEL_JS, /loadSnapshot.*&include_body=0/s);
    assert.match(WORKSPACE_PANEL_JS, /loadMessages.*&include_body=0/s);

    // Detail lazy loads via loadMessageDetail when body === undefined
    assert.match(WORKSPACE_PANEL_JS, /function loadMessageDetail\(messageId,\s*taskId,\s*target\)/);
    assert.match(WORKSPACE_PANEL_JS, /loadMessageDetail\(m\.messageId,\s*m\.taskId,\s*target\)/);
    assert.match(WORKSPACE_PANEL_JS, /q\s*=\s*"\?task_id="\s*\+\s*encodeURIComponent\(taskId\)\s*\+\s*"&limit=100"/);

    // Preserves loaded bodies
    assert.match(WORKSPACE_PANEL_JS, /bodyMap\[m\.messageId\]/);
    assert.match(WORKSPACE_PANEL_JS, /prevBody !== undefined \? Object\.assign\(\{\},\s*fresh,\s*\{\s*body:\s*prevBody\s*\}\)\s*:\s*fresh/);
  });
});
