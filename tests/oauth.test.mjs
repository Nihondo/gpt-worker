// Phases 1-2 of docs/plans/oauth-mcp-authentication.md:
//  - Phase 1: OAuth discovery metadata and 401 Bearer challenges on the new
//    secret-free /mcp and /mcp/<workspace_id> resource URLs, plus regression
//    coverage that the legacy token-in-URL routes keep routing exactly as
//    before.
//  - Phase 2: a real Authorization Code + S256 PKCE + refresh-token issuer
//    (/oauth/authorize, /oauth/token) and Bearer validation that actually
//    reaches the existing MCP JSON-RPC handlers.
//
// Exercises the real top-level Worker `fetch` (the `export default` in
// worker/src/index.js), not just the OAuth helper functions, so route
// precedence between the new OAuth resources and the legacy token routes is
// actually covered.
//
// Phase 1 tests use a dumb Durable Object stub (just enough to prove
// forwarding happened). Phase 2 tests need the OAuth flow to actually work
// end-to-end, so they run against real `BridgeDO` instances (the same
// fake-do-ctx harness admin.test.mjs/queue.test.mjs use), wired up so
// env.BRIDGE_DO.get(name) returns whichever named instance (hub or a given
// workspace_id) and lazily creates it on first use.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import worker, { BridgeDO } from "../worker/src/index.js";
import { makeFakeCtx } from "./helpers/fake-do-ctx.mjs";

const ORIGIN = "https://example.com";
const HUB_TOKEN = "a".repeat(64); // shape of randomHex(32): 64 hex chars
const WORKSPACE_ID = "0123456789abcdef"; // shape of a real workspace_id: 16 hex chars

function makeFakeBridgeDoEnv() {
  const calls = [];
  const stub = {
    async fetch(request) {
      const url = new URL(request.url);
      calls.push({ pathname: url.pathname, method: request.method });
      return new Response("stub-forwarded", { status: 200 });
    },
  };
  return {
    calls,
    env: {
      BRIDGE_DO: {
        idFromName: (name) => name,
        get: () => stub,
      },
    },
  };
}

/** Real BridgeDO instances behind the same env.BRIDGE_DO binding shape, keyed
 *  by idFromName(name) exactly like the real multi-tenant routing (hub DO =
 *  HUB_DO_NAME, one DO per workspace_id). Each instance is constructed with
 *  this same `env` (not makeFakeEnv()'s bare `{}`), so a workspace DO's own
 *  cross-DO calls to the hub — e.g. BridgeDO.getOAuthClient()'s DCR lookup —
 *  resolve correctly instead of throwing on a missing `env.BRIDGE_DO`. */
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

function formReq(path, params, extraHeaders = {}) {
  return req(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...extraHeaders },
    body: new URLSearchParams(params).toString(),
  });
}

function jsonReq(path, body, extraHeaders = {}) {
  return req(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkcePair() {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(64))); // ~86 chars, within 43-128
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

function codeFromRedirect(res) {
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location"));
  return location;
}

describe("OAuth discovery metadata (/.well-known)", () => {
  test("shared protected-resource metadata", async () => {
    const res = await worker.fetch(req("/.well-known/oauth-protected-resource"), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.resource, `${ORIGIN}/mcp`);
    assert.deepEqual(body.authorization_servers, [ORIGIN]);
  });

  test("path-specific shared protected-resource metadata matches the root form", async () => {
    const res = await worker.fetch(req("/.well-known/oauth-protected-resource/mcp"), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.resource, `${ORIGIN}/mcp`);
  });

  test("path-specific workspace protected-resource metadata", async () => {
    const res = await worker.fetch(req(`/.well-known/oauth-protected-resource/mcp/${WORKSPACE_ID}`), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.resource, `${ORIGIN}/mcp/${WORKSPACE_ID}`);
    assert.deepEqual(body.authorization_servers, [ORIGIN]);
  });

  test("invalid workspace id in path-specific metadata is 404", async () => {
    const res = await worker.fetch(req("/.well-known/oauth-protected-resource/mcp/not-a-workspace-id"), {});
    assert.equal(res.status, 404);
  });

  test("non-GET on metadata routes is 405 with Allow: GET", async () => {
    const res = await worker.fetch(req("/.well-known/oauth-protected-resource", { method: "POST" }), {});
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET");
  });

  test("authorization-server metadata advertises the planned endpoints", async () => {
    const res = await worker.fetch(req("/.well-known/oauth-authorization-server"), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.issuer, ORIGIN);
    assert.equal(body.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
    assert.equal(body.token_endpoint, `${ORIGIN}/oauth/token`);
    assert.equal(body.registration_endpoint, `${ORIGIN}/oauth/register`);
    assert.deepEqual(body.response_types_supported, ["code"]);
    assert.deepEqual(body.grant_types_supported, ["authorization_code", "refresh_token"]);
    assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
  });

  test("unknown well-known path is 404", async () => {
    const res = await worker.fetch(req("/.well-known/something-else"), {});
    assert.equal(res.status, 404);
  });
});

describe("OAuth MCP resources (/mcp, /mcp/<workspace_id>) — Phase 1: always 401", () => {
  test("POST /mcp without Authorization is 401 with a shared resource_metadata challenge", async () => {
    const { env } = makeFakeBridgeDoEnv();
    const res = await worker.fetch(req("/mcp", { method: "POST", headers: { "content-type": "application/json" } }), env);
    assert.equal(res.status, 401);
    const challenge = res.headers.get("www-authenticate");
    assert.match(challenge, /^Bearer /);
    assert.match(challenge, /resource_metadata="https:\/\/example\.com\/\.well-known\/oauth-protected-resource\/mcp"/);
    assert.doesNotMatch(challenge, /error="invalid_token"/);
  });

  test("POST /mcp/<workspace_id> without Authorization is 401 with a workspace-specific challenge", async () => {
    const { env } = makeFakeBridgeDoEnv();
    const res = await worker.fetch(req(`/mcp/${WORKSPACE_ID}`, { method: "POST" }), env);
    assert.equal(res.status, 401);
    const challenge = res.headers.get("www-authenticate");
    assert.match(challenge, new RegExp(`resource_metadata="https://example\\.com/\\.well-known/oauth-protected-resource/mcp/${WORKSPACE_ID}"`));
  });

  test("malformed Authorization header is 401 with error=invalid_token", async () => {
    const { env } = makeFakeBridgeDoEnv();
    const res = await worker.fetch(req("/mcp", { method: "POST", headers: { authorization: "Basic xyz" } }), env);
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate"), /error="invalid_token"/);
  });

  test("syntactically valid Bearer token is still rejected in Phase 1", async () => {
    const { env } = makeFakeBridgeDoEnv();
    const res = await worker.fetch(req("/mcp", { method: "POST", headers: { authorization: "Bearer sometoken" } }), env);
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate"), /error="invalid_token"/);
  });

  test("auth is checked before the JSON-RPC body is parsed (invalid JSON still yields 401, not a parse error)", async () => {
    const { env } = makeFakeBridgeDoEnv();
    const res = await worker.fetch(
      req("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{not valid json" }),
      env,
    );
    assert.equal(res.status, 401);
  });

  test("GET on an OAuth MCP resource is 405 with Allow: POST", async () => {
    const { env } = makeFakeBridgeDoEnv();
    const res = await worker.fetch(req("/mcp", { method: "GET" }), env);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
  });

  test("disallowed browser Origin on an OAuth MCP resource is 403 before Bearer handling", async () => {
    const { env } = makeFakeBridgeDoEnv();
    const res = await worker.fetch(req("/mcp", { method: "POST", headers: { origin: "https://evil.example" } }), env);
    assert.equal(res.status, 403);
  });
});

describe("Legacy token routes keep routing exactly as before", () => {
  test("/mcp/<64-hex-hub-token> still forwards to the hub DO as /hub-mcp/<token>, not the OAuth workspace route", async () => {
    const { env, calls } = makeFakeBridgeDoEnv();
    const res = await worker.fetch(req(`/mcp/${HUB_TOKEN}`, { method: "POST" }), env);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "stub-forwarded");
    assert.deepEqual(calls, [{ pathname: `/hub-mcp/${HUB_TOKEN}`, method: "POST" }]);
  });

  test("/mcp/<workspace_id>/<token> still forwards to the workspace DO as /mcp/<token>", async () => {
    const { env, calls } = makeFakeBridgeDoEnv();
    const res = await worker.fetch(req(`/mcp/${WORKSPACE_ID}/sometoken`, { method: "POST" }), env);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "stub-forwarded");
    assert.deepEqual(calls, [{ pathname: "/mcp/sometoken", method: "POST" }]);
  });

  test("/mcp/<16-hex-workspace-id> alone is now the OAuth resource (401), not the legacy hub route", async () => {
    const { env, calls } = makeFakeBridgeDoEnv();
    const res = await worker.fetch(req(`/mcp/${WORKSPACE_ID}`, { method: "POST" }), env);
    assert.equal(res.status, 401);
    assert.deepEqual(calls, []); // never reached the DO
  });

  test("/link/<workspace_id>/<token> and /admin/<token> are unaffected by the new routes", async () => {
    const { env, calls } = makeFakeBridgeDoEnv();
    const res = await worker.fetch(req(`/link/${WORKSPACE_ID}/sometoken`, {}), env);
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [{ pathname: "/link/sometoken", method: "GET" }]);
  });
});

describe("Phase 2: authorization-code + PKCE + refresh, against real BridgeDO instances", () => {
  function setup() {
    const { instanceFor, env } = makeRealBridgeDoEnv();
    const workspaceDo = instanceFor(WORKSPACE_ID);
    const { gptToken } = workspaceDo.provision();
    return { env, workspaceDo, gptToken };
  }

  const RESOURCE = `${ORIGIN}/mcp/${WORKSPACE_ID}`;
  const REDIRECT_URI = "https://client.example/callback";
  const CLIENT_ID = "test-client";

  async function authorize(env, { ownerToken, challenge, state = "xyz", resource = RESOURCE, redirectUri = REDIRECT_URI }) {
    return worker.fetch(
      formReq("/oauth/authorize", {
        resource,
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        owner_token: ownerToken,
        state,
      }),
      env,
    );
  }

  async function exchangeCode(env, code, verifier, overrides = {}) {
    return worker.fetch(
      formReq("/oauth/token", {
        grant_type: "authorization_code",
        code,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        resource: RESOURCE,
        code_verifier: verifier,
        ...overrides,
      }),
      env,
    );
  }

  test("authorize with the workspace's own gpt_token succeeds and redirects with code + state, no secret", async () => {
    const { env, gptToken } = setup();
    const { challenge } = await pkcePair();
    const res = await authorize(env, { ownerToken: gptToken, challenge });
    const location = codeFromRedirect(res);
    assert.equal(location.origin + location.pathname, REDIRECT_URI);
    assert.equal(location.searchParams.get("state"), "xyz");
    assert.ok(location.searchParams.get("code"));
    assert.doesNotMatch(location.toString(), new RegExp(gptToken));
  });

  test("authorize with the wrong owner token is a JSON 403, not a redirect", async () => {
    const { env } = setup();
    const { challenge } = await pkcePair();
    const res = await authorize(env, { ownerToken: "wrong-token", challenge });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "access_denied");
  });

  test("authorize rejects non-S256 challenge method, wrong response_type, and cross-origin resource", async () => {
    const { env, gptToken } = setup();
    const { challenge } = await pkcePair();

    const wrongMethod = await worker.fetch(
      formReq("/oauth/authorize", {
        resource: RESOURCE,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "plain",
        owner_token: gptToken,
      }),
      env,
    );
    assert.equal(wrongMethod.status, 400);
    assert.equal((await wrongMethod.json()).error, "invalid_request");

    const wrongResponseType = await worker.fetch(
      formReq("/oauth/authorize", {
        resource: RESOURCE,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "token",
        code_challenge: challenge,
        code_challenge_method: "S256",
        owner_token: gptToken,
      }),
      env,
    );
    assert.equal(wrongResponseType.status, 400);
    assert.equal((await wrongResponseType.json()).error, "unsupported_response_type");

    const crossOrigin = await authorize(env, { ownerToken: gptToken, challenge, resource: "https://not-this-host/mcp" });
    assert.equal(crossOrigin.status, 400);
    assert.equal((await crossOrigin.json()).error, "invalid_target");
  });

  test("authorization_code exchange succeeds once, returns Bearer tokens, and cannot be replayed", async () => {
    const { env, gptToken } = setup();
    const { verifier, challenge } = await pkcePair();
    const authRes = await authorize(env, { ownerToken: gptToken, challenge });
    const code = codeFromRedirect(authRes).searchParams.get("code");

    const tokenRes = await exchangeCode(env, code, verifier);
    assert.equal(tokenRes.status, 200);
    assert.equal(tokenRes.headers.get("cache-control"), "no-store");
    const body = await tokenRes.json();
    assert.equal(body.token_type, "Bearer");
    assert.ok(body.access_token);
    assert.ok(body.refresh_token);
    assert.equal(body.expires_in, 3600);
    assert.equal(body.resource, RESOURCE);

    const replay = await exchangeCode(env, code, verifier);
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error, "invalid_grant");
  });

  test("authorization_code exchange rejects a wrong code_verifier and a redirect_uri mismatch", async () => {
    const { env, gptToken } = setup();
    const { verifier, challenge } = await pkcePair();
    const authRes = await authorize(env, { ownerToken: gptToken, challenge });
    const code = codeFromRedirect(authRes).searchParams.get("code");

    const wrongVerifier = await exchangeCode(env, code, "wrong-verifier-wrong-verifier-wrong-verifier-000000");
    assert.equal(wrongVerifier.status, 400);
    assert.equal((await wrongVerifier.json()).error, "invalid_grant");

    // the code above was already consumed by the failed attempt (one-time use)
    const authRes2 = await authorize(env, { ownerToken: gptToken, challenge });
    const code2 = codeFromRedirect(authRes2).searchParams.get("code");
    const wrongRedirect = await exchangeCode(env, code2, verifier, { redirect_uri: "https://attacker.example/callback" });
    assert.equal(wrongRedirect.status, 400);
    assert.equal((await wrongRedirect.json()).error, "invalid_grant");
  });

  test("a valid access token authorizes POST /mcp/<workspace_id> and reaches the real MCP handler", async () => {
    const { env, gptToken } = setup();
    const { verifier, challenge } = await pkcePair();
    const authRes = await authorize(env, { ownerToken: gptToken, challenge });
    const code = codeFromRedirect(authRes).searchParams.get("code");
    const { access_token: accessToken } = await (await exchangeCode(env, code, verifier)).json();

    const mcpRes = await worker.fetch(
      req(`/mcp/${WORKSPACE_ID}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
      }),
      env,
    );
    assert.equal(mcpRes.status, 200);
    const body = await mcpRes.json();
    assert.deepEqual(body, { jsonrpc: "2.0", id: 1, result: {} });
  });

  test("an access token issued for one workspace's resource cannot authorize another workspace's resource", async () => {
    const { instanceFor, env } = makeRealBridgeDoEnv();
    const workspaceA = "0123456789abcdef";
    const workspaceB = "fedcba9876543210";
    const { gptToken: tokenA } = instanceFor(workspaceA).provision();
    instanceFor(workspaceB).provision();

    const { verifier, challenge } = await pkcePair();
    const authRes = await worker.fetch(
      formReq("/oauth/authorize", {
        resource: `${ORIGIN}/mcp/${workspaceA}`,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        owner_token: tokenA,
      }),
      env,
    );
    const code = codeFromRedirect(authRes).searchParams.get("code");
    const { access_token: accessToken } = await (
      await worker.fetch(
        formReq("/oauth/token", {
          grant_type: "authorization_code",
          code,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          resource: `${ORIGIN}/mcp/${workspaceA}`,
          code_verifier: verifier,
        }),
        env,
      )
    ).json();

    const crossResourceRes = await worker.fetch(
      req(`/mcp/${workspaceB}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
      }),
      env,
    );
    assert.equal(crossResourceRes.status, 401);
  });

  test("refresh rotates the token pair; reusing the old refresh token revokes the whole family", async () => {
    const { env, gptToken } = setup();
    const { verifier, challenge } = await pkcePair();
    const authRes = await authorize(env, { ownerToken: gptToken, challenge });
    const code = codeFromRedirect(authRes).searchParams.get("code");
    const first = await (await exchangeCode(env, code, verifier)).json();

    const refreshOnce = await worker.fetch(
      formReq("/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: CLIENT_ID,
        resource: RESOURCE,
      }),
      env,
    );
    assert.equal(refreshOnce.status, 200);
    const second = await refreshOnce.json();
    assert.notEqual(second.access_token, first.access_token);
    assert.notEqual(second.refresh_token, first.refresh_token);

    // reusing the now-rotated-away first.refresh_token is reuse detection
    const reuse = await worker.fetch(
      formReq("/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: CLIENT_ID,
        resource: RESOURCE,
      }),
      env,
    );
    assert.equal(reuse.status, 400);
    assert.equal((await reuse.json()).error, "invalid_grant");

    // the whole family (including the second-generation access token) is revoked
    const useSecondAccess = await worker.fetch(
      req(`/mcp/${WORKSPACE_ID}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${second.access_token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
      }),
      env,
    );
    assert.equal(useSecondAccess.status, 401);
  });

  test("token endpoint rejects an unsupported grant_type", async () => {
    const { env } = setup();
    const res = await worker.fetch(
      formReq("/oauth/token", { grant_type: "password", resource: RESOURCE, client_id: CLIENT_ID }),
      env,
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "unsupported_grant_type");
  });

  test("state containing CR/LF/NUL, or an oversized state, is rejected before a code is ever issued", async () => {
    const { env, gptToken } = setup();
    const { challenge } = await pkcePair();

    const withCrLf = await authorize(env, { ownerToken: gptToken, challenge, state: "line1\r\nline2" });
    assert.equal(withCrLf.status, 400);
    assert.equal((await withCrLf.json()).error, "invalid_request");

    const withNul = await authorize(env, { ownerToken: gptToken, challenge, state: "a b" });
    assert.equal(withNul.status, 400);
    assert.equal((await withNul.json()).error, "invalid_request");

    const oversized = await authorize(env, { ownerToken: gptToken, challenge, state: "x".repeat(600) });
    assert.equal(oversized.status, 400);
    assert.equal((await oversized.json()).error, "invalid_request");
  });

  test("a normal state still round-trips unchanged through authorize and into the redirect", async () => {
    const { env, gptToken } = setup();
    const { challenge } = await pkcePair();
    const res = await authorize(env, { ownerToken: gptToken, challenge, state: "opaque-client-state-123" });
    const location = codeFromRedirect(res);
    assert.equal(location.searchParams.get("state"), "opaque-client-state-123");
  });

  test("a valid multi-token scope is preserved from authorize through the token response", async () => {
    const { env, gptToken } = setup();
    const { verifier, challenge } = await pkcePair();
    const authRes = await worker.fetch(
      formReq("/oauth/authorize", {
        resource: RESOURCE,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        owner_token: gptToken,
        scope: "read write",
      }),
      env,
    );
    const code = codeFromRedirect(authRes).searchParams.get("code");
    const tokenRes = await exchangeCode(env, code, verifier);
    assert.equal(tokenRes.status, 200);
    const body = await tokenRes.json();
    assert.equal(body.scope, "read write");
  });

  test("a scope with an invalid character, or an oversized scope, is rejected as invalid_request", async () => {
    const { env, gptToken } = setup();
    const { challenge } = await pkcePair();

    async function authorizeWithScope(scope) {
      return worker.fetch(
        formReq("/oauth/authorize", {
          resource: RESOURCE,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          owner_token: gptToken,
          scope,
        }),
        env,
      );
    }

    const withControlChar = await authorizeWithScope("read\twrite");
    assert.equal(withControlChar.status, 400);
    assert.equal((await withControlChar.json()).error, "invalid_request");

    const withDoubleSpace = await authorizeWithScope("read  write"); // splits into an empty token
    assert.equal(withDoubleSpace.status, 400);
    assert.equal((await withDoubleSpace.json()).error, "invalid_request");

    const oversized = await authorizeWithScope("x".repeat(1025));
    assert.equal(oversized.status, 400);
    assert.equal((await oversized.json()).error, "invalid_request");
  });

  test("the shared hub resource (/mcp) goes through the same owner-auth -> PKCE code -> Bearer -> MCP handler path", async () => {
    const { instanceFor, env } = makeRealBridgeDoEnv();
    const hubDo = instanceFor("gpt-worker-hub");
    const { gptToken: hubOwnerToken } = hubDo.provisionHub();
    const { verifier, challenge } = await pkcePair();

    const authRes = await worker.fetch(
      formReq("/oauth/authorize", {
        resource: `${ORIGIN}/mcp`,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        owner_token: hubOwnerToken,
      }),
      env,
    );
    const code = codeFromRedirect(authRes).searchParams.get("code");

    const tokenRes = await worker.fetch(
      formReq("/oauth/token", {
        grant_type: "authorization_code",
        code,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        resource: `${ORIGIN}/mcp`,
        code_verifier: verifier,
      }),
      env,
    );
    assert.equal(tokenRes.status, 200);
    const { access_token: accessToken } = await tokenRes.json();

    const mcpRes = await worker.fetch(
      req("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
      }),
      env,
    );
    assert.equal(mcpRes.status, 200);
    assert.deepEqual(await mcpRes.json(), { jsonrpc: "2.0", id: 1, result: {} });
  });
});

describe("Phase 3: GET /oauth/authorize consent form + Dynamic Client Registration", () => {
  function setup() {
    const { instanceFor, env } = makeRealBridgeDoEnv();
    const workspaceDo = instanceFor(WORKSPACE_ID);
    const { gptToken } = workspaceDo.provision();
    return { env, workspaceDo, gptToken };
  }

  const RESOURCE = `${ORIGIN}/mcp/${WORKSPACE_ID}`;
  const REDIRECT_URI = "https://client.example/callback";
  const CLIENT_ID = "test-client"; // never registered via DCR in this describe block, unless noted

  function authorizeGetUrl(overrides = {}) {
    const params = new URLSearchParams({
      resource: RESOURCE,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      code_challenge: "x".repeat(43), // syntactically valid; only used where the actual value doesn't matter
      code_challenge_method: "S256",
      ...overrides,
    });
    return `/oauth/authorize?${params.toString()}`;
  }

  test("GET renders an HTML consent form with hidden OAuth params, no owner secret in the page", async () => {
    const { env } = setup();
    const { challenge } = await pkcePair();
    const res = await worker.fetch(req(authorizeGetUrl({ code_challenge: challenge, state: "abc123", scope: "read" }), { method: "GET" }), env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const html = await res.text();
    assert.match(html, /<form method="post" action="\/oauth\/authorize">/);
    assert.match(html, new RegExp(`name="code_challenge" value="${challenge}"`));
    assert.match(html, /name="state" value="abc123"/);
    assert.match(html, /name="scope" value="read"/);
    assert.match(html, /type="password"[^>]*name="owner_token"/);
  });

  test("GET rejects malformed/cross-origin resource, non-code response_type, non-S256 method, invalid state/scope, malformed redirect_uri", async () => {
    const { env } = setup();
    const { challenge } = await pkcePair();

    const crossOrigin = await worker.fetch(req(authorizeGetUrl({ code_challenge: challenge, resource: "https://not-this-host/mcp" }), { method: "GET" }), env);
    assert.equal(crossOrigin.status, 400);
    assert.equal((await crossOrigin.json()).error, "invalid_target");

    const wrongResponseType = await worker.fetch(req(authorizeGetUrl({ code_challenge: challenge, response_type: "token" }), { method: "GET" }), env);
    assert.equal(wrongResponseType.status, 400);
    assert.equal((await wrongResponseType.json()).error, "unsupported_response_type");

    const wrongMethod = await worker.fetch(req(authorizeGetUrl({ code_challenge: challenge, code_challenge_method: "plain" }), { method: "GET" }), env);
    assert.equal(wrongMethod.status, 400);
    assert.equal((await wrongMethod.json()).error, "invalid_request");

    const badState = await worker.fetch(req(authorizeGetUrl({ code_challenge: challenge, state: "a\nb" }), { method: "GET" }), env);
    assert.equal(badState.status, 400);

    const badScope = await worker.fetch(req(authorizeGetUrl({ code_challenge: challenge, scope: "bad\tscope" }), { method: "GET" }), env);
    assert.equal(badScope.status, 400);

    const badRedirect = await worker.fetch(req(authorizeGetUrl({ code_challenge: challenge, redirect_uri: "not-a-url" }), { method: "GET" }), env);
    assert.equal(badRedirect.status, 400);
  });

  test("DCR: POST /oauth/register succeeds with a standard body — no `resource` field, exactly what a real RFC 7591/MCP SDK client sends", async () => {
    const { env } = setup();
    const res = await worker.fetch(
      jsonReq("/oauth/register", { redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none", client_name: "Test Client" }),
      env,
    );
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.ok(body.client_id);
    assert.equal(body.client_secret, undefined);
    assert.deepEqual(body.redirect_uris, [REDIRECT_URI]);
    assert.equal(body.token_endpoint_auth_method, "none");
    assert.equal(body.client_name, "Test Client");
  });

  test("DCR accepts and echoes a typical MCP-SDK-style body with grant_types/response_types/application_type", async () => {
    const { env } = setup();
    const res = await worker.fetch(
      jsonReq("/oauth/register", {
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        application_type: "web",
      }),
      env,
    );
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.client_id);
    assert.deepEqual(body.grant_types, ["authorization_code", "refresh_token"]);
    assert.deepEqual(body.response_types, ["code"]);
    assert.equal(body.application_type, "web");
  });

  test("DCR rejects an unsupported grant_types/response_types/application_type value", async () => {
    const { env } = setup();

    const badGrant = await worker.fetch(jsonReq("/oauth/register", { redirect_uris: [REDIRECT_URI], grant_types: ["client_credentials"] }), env);
    assert.equal(badGrant.status, 400);
    assert.equal((await badGrant.json()).error, "invalid_client_metadata");

    const badResponseType = await worker.fetch(jsonReq("/oauth/register", { redirect_uris: [REDIRECT_URI], response_types: ["token"] }), env);
    assert.equal(badResponseType.status, 400);
    assert.equal((await badResponseType.json()).error, "invalid_client_metadata");

    const badAppType = await worker.fetch(jsonReq("/oauth/register", { redirect_uris: [REDIRECT_URI], application_type: "mobile" }), env);
    assert.equal(badAppType.status, 400);
    assert.equal((await badAppType.json()).error, "invalid_client_metadata");
  });

  test("DCR rejects missing/empty, too-many, duplicate, and malformed redirect_uris; unsupported auth method", async () => {
    const { env } = setup();

    const empty = await worker.fetch(jsonReq("/oauth/register", { redirect_uris: [] }), env);
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error, "invalid_client_metadata");

    const tooMany = await worker.fetch(
      jsonReq("/oauth/register", { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://client.example/cb${i}`) }),
      env,
    );
    assert.equal(tooMany.status, 400);
    assert.equal((await tooMany.json()).error, "invalid_client_metadata");

    const duplicate = await worker.fetch(jsonReq("/oauth/register", { redirect_uris: [REDIRECT_URI, REDIRECT_URI] }), env);
    assert.equal(duplicate.status, 400);
    assert.equal((await duplicate.json()).error, "invalid_client_metadata");

    const invalidUri = await worker.fetch(jsonReq("/oauth/register", { redirect_uris: ["not-a-url"] }), env);
    assert.equal(invalidUri.status, 400);
    assert.equal((await invalidUri.json()).error, "invalid_client_metadata");

    const unsupportedAuth = await worker.fetch(
      jsonReq("/oauth/register", { redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "client_secret_basic" }),
      env,
    );
    assert.equal(unsupportedAuth.status, 400);
    assert.equal((await unsupportedAuth.json()).error, "invalid_client_metadata");
  });

  test("DCR is rate-limited (429 after the per-minute cap)", async () => {
    const { env } = setup();
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      const res = await worker.fetch(jsonReq("/oauth/register", { redirect_uris: [REDIRECT_URI] }), env);
      statuses.push(res.status);
    }
    assert.equal(statuses.filter((s) => s === 201).length, 10);
    assert.equal(statuses[10], 429);
  });

  test("a client_id from one DCR registration works for both the hub resource and a workspace resource", async () => {
    const { instanceFor, env } = makeRealBridgeDoEnv();
    const workspaceDo = instanceFor(WORKSPACE_ID);
    const { gptToken: workspaceOwnerToken } = workspaceDo.provision();
    const { gptToken: hubOwnerToken } = instanceFor("gpt-worker-hub").provisionHub();

    const registerRes = await worker.fetch(jsonReq("/oauth/register", { redirect_uris: [REDIRECT_URI] }), env);
    const { client_id: registeredClientId } = await registerRes.json();

    for (const [resource, ownerToken] of [
      [RESOURCE, workspaceOwnerToken],
      [`${ORIGIN}/mcp`, hubOwnerToken],
    ]) {
      const { challenge } = await pkcePair();
      const formOk = await worker.fetch(
        req(`/oauth/authorize?${new URLSearchParams({ resource, client_id: registeredClientId, redirect_uri: REDIRECT_URI, response_type: "code", code_challenge: challenge, code_challenge_method: "S256" }).toString()}`, {
          method: "GET",
        }),
        env,
      );
      assert.equal(formOk.status, 200, `GET form should accept the registered client for resource ${resource}`);

      const authRes = await worker.fetch(
        formReq("/oauth/authorize", {
          resource,
          client_id: registeredClientId,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          owner_token: ownerToken,
        }),
        env,
      );
      const location = codeFromRedirect(authRes);
      assert.ok(location.searchParams.get("code"), `authorize should issue a code for resource ${resource}`);
      assert.equal(location.searchParams.get("iss"), ORIGIN);
    }
  });

  test("registered client, full flow: DCR -> GET form (registered redirect ok, unregistered rejected) -> POST authorize (unregistered redirect rejected, registered redirect issues code) -> token exchange -> Bearer reaches the real MCP handler", async () => {
    const { env, gptToken } = setup();
    const registerRes = await worker.fetch(jsonReq("/oauth/register", { redirect_uris: [REDIRECT_URI] }), env);
    const { client_id: registeredClientId } = await registerRes.json();
    const { verifier, challenge } = await pkcePair();

    const formOk = await worker.fetch(
      req(authorizeGetUrl({ client_id: registeredClientId, code_challenge: challenge }), { method: "GET" }),
      env,
    );
    assert.equal(formOk.status, 200);

    const formRejected = await worker.fetch(
      req(
        authorizeGetUrl({ client_id: registeredClientId, code_challenge: challenge, redirect_uri: "https://attacker.example/callback" }),
        { method: "GET" },
      ),
      env,
    );
    assert.equal(formRejected.status, 400);
    assert.equal((await formRejected.json()).error, "invalid_request");

    const postRejected = await worker.fetch(
      formReq("/oauth/authorize", {
        resource: RESOURCE,
        client_id: registeredClientId,
        redirect_uri: "https://attacker.example/callback",
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        owner_token: gptToken,
      }),
      env,
    );
    assert.equal(postRejected.status, 400);
    assert.equal((await postRejected.json()).error, "invalid_request");

    const authRes = await worker.fetch(
      formReq("/oauth/authorize", {
        resource: RESOURCE,
        client_id: registeredClientId,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        owner_token: gptToken,
      }),
      env,
    );
    const code = codeFromRedirect(authRes).searchParams.get("code");

    const tokenRes = await worker.fetch(
      formReq("/oauth/token", {
        grant_type: "authorization_code",
        code,
        client_id: registeredClientId,
        redirect_uri: REDIRECT_URI,
        resource: RESOURCE,
        code_verifier: verifier,
      }),
      env,
    );
    assert.equal(tokenRes.status, 200);
    const { access_token: accessToken } = await tokenRes.json();

    const mcpRes = await worker.fetch(
      req(`/mcp/${WORKSPACE_ID}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
      }),
      env,
    );
    assert.equal(mcpRes.status, 200);
    assert.deepEqual(await mcpRes.json(), { jsonrpc: "2.0", id: 1, result: {} });
  });

  test("an unregistered client_id keeps the Phase 2 compatibility path: any syntactically valid redirect_uri is accepted and bound into the code", async () => {
    const { env, gptToken } = setup();
    const { verifier, challenge } = await pkcePair();
    const unusualButValidRedirect = "https://another-client.example/cb?x=1";

    const authRes = await worker.fetch(
      formReq("/oauth/authorize", {
        resource: RESOURCE,
        client_id: CLIENT_ID, // never registered
        redirect_uri: unusualButValidRedirect,
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        owner_token: gptToken,
      }),
      env,
    );
    const code = codeFromRedirect(authRes).searchParams.get("code");

    const tokenRes = await worker.fetch(
      formReq("/oauth/token", {
        grant_type: "authorization_code",
        code,
        client_id: CLIENT_ID,
        redirect_uri: unusualButValidRedirect,
        resource: RESOURCE,
        code_verifier: verifier,
      }),
      env,
    );
    assert.equal(tokenRes.status, 200);
    assert.ok((await tokenRes.json()).access_token);
  });

  test("the consent form's same-origin POST back to /oauth/authorize is not blocked by Origin checking, but a genuinely different disallowed Origin still is", async () => {
    const { env, gptToken } = setup();
    const { challenge } = await pkcePair();

    const sameOrigin = await worker.fetch(
      formReq(
        "/oauth/authorize",
        {
          resource: RESOURCE,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          owner_token: gptToken,
        },
        { origin: ORIGIN }, // exactly what a real browser sends posting this Worker's own consent form back to itself
      ),
      env,
    );
    assert.equal(sameOrigin.status, 302);

    const disallowedOrigin = await worker.fetch(
      formReq(
        "/oauth/authorize",
        {
          resource: RESOURCE,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          owner_token: gptToken,
        },
        { origin: "https://evil.example" },
      ),
      env,
    );
    assert.equal(disallowedOrigin.status, 403);
  });
});
