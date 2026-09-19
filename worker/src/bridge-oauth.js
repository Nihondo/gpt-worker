// OAuth authorization-server + resource-token domain, extracted verbatim
// from BridgeDO (see worker/src/index.js). Behavior, response shapes, error
// codes, and state-transition semantics are unchanged from the
// pre-extraction implementation — this module only relocates the code. See
// docs/plans/pending/worker-cli-dashboard-modularization-phase0-map.md §13
// for the domain dependency/capability matrix this extraction follows.
//
// Dependency direction: this module imports only pure helpers from
// worker-http.js and worker-oauth-http.js. It never imports index.js or any
// sibling bridge-*.js domain module (admin/protocol/dashboard/mcp/transport)
// — the genuine cross-domain needs are received as narrow capability
// callbacks from createBridgeOAuth's caller (BridgeDO's constructor)
// instead:
//  - checkHubOwnerToken(token)/checkWorkspaceOwnerToken(token): () => boolean
//    — compare a presented owner token against this instance's own
//    hub_gpt_token/gpt_token (index.js's checkToken, itself a thin delegate
//    onto bridge-admin.js). checkResourceOwnerToken()'s hub_gpt_token ||
//    gpt_token OR-check itself stays in this module — only the two
//    individual comparisons are injected, so the hub/workspace disjoint-
//    secret invariant (see that method's own doc comment) is preserved
//    exactly.
//  - hasHubOwnerSecret(): () => boolean — whether this instance has
//    hub_gpt_token set (index.js's getSecret), used only by isHubInstance().
//  - lookupHubOAuthClient(clientId, resource): (string, string) =>
//    Promise<object|null> — the cross-DO binding call a non-hub instance
//    makes to the hub DO's own oauth-client-lookup route (index.js's own
//    env.BRIDGE_DO access), used only by getOAuthClient() when
//    isHubInstance() is false. This module never sees `env`/`BRIDGE_DO`
//    itself.
//  - checkOAuthRegisterRateLimit(): () => boolean — the "oauth-register"
//    10/min bucket (index.js's generic rateLimit), used only by
//    handleOAuthRegister(). Not the generic rateLimit() itself, which stays
//    in index.js and is shared by non-OAuth routes too.
//  - generateHex(bytes): (number) => string — index.js's own randomHex,
//    injected rather than duplicated (it's also used outside OAuth, e.g.
//    admin's token generation).
//  - hashValue(value): (string) => Promise<string> — index.js's own
//    sha256Hex, injected for the same reason (also used by dashboard session
//    hashing).
//  - renderConsentHtml(fields): (object) => Response — index.js's own
//    renderOAuthConsentHtml, a stateless HTML renderer that stays in
//    index.js's public-HTTP layer and is injected here rather than moved,
//    since it owns no OAuth state itself.
//  - maxOAuthRequestBytes: number — index.js's own MAX_REQUEST_BYTES, the
//    fixed envelope-size cap used to parse an incoming OAuth request body
//    (unrelated to the per-workspace maxBodyBytes()/maxRequestBytes() owned
//    by bridge-admin.js).
//
// handleOAuthMcpDispatch (Bearer-authenticated JSON-RPC envelope parsing and
// dispatch into handleMcpRequest/handleHubMcpRequest) stays in index.js
// despite its name — it belongs to Phase 2D's bridge-mcp.js, not this
// domain. The public HTTP layer (handleOAuthAuthorizeRoute/
// handleOAuthTokenRoute/handleOAuthRegisterRoute/handleOAuthMcpResource,
// discovery metadata, Bearer challenge/DO selection, and the stateless
// helpers only they use — resolveOAuthResource/extractBearerToken/
// oauthUnauthorized/validateAccessToken/renderOAuthConsentHtml) also stays
// in index.js: this module only owns the internal, DO-resident authorization
// server + resource-token state and the oauth-* route handlers reached
// through it.

import { constantTimeEqual, byteLength, readJsonWithLimit, base64UrlEncode, json } from "./worker-http.js";
import { oauthError, parseOAuthForm } from "./worker-oauth-http.js";

const OAUTH_CODE_TTL_MS = 5 * 60 * 1000; // authorization code: 5 min
const OAUTH_ACCESS_TTL_MS = 60 * 60 * 1000; // access token: 1 hour
const OAUTH_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // refresh token: 30 days
const PKCE_CHALLENGE_RE = /^[A-Za-z0-9\-_]{43}$/; // base64url(SHA-256(...)), unpadded, always 43 chars
const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/; // RFC 7636 unreserved charset
const OAUTH_STATE_MAX_BYTES = 512;
const OAUTH_SCOPE_MAX_BYTES = 1024;
const OAUTH_REDIRECT_URI_MAX_BYTES = 2048;
// RFC 6749 scope-token = 1*NQCHAR, NQCHAR = %x21 / %x23-5B / %x5D-7E
// (any visible ASCII except SP, '"', '\\').
const OAUTH_SCOPE_TOKEN_RE = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

/** RFC 7636 S256: BASE64URL(SHA256(ASCII(code_verifier))). */
async function pkceChallengeFromVerifier(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function isValidPkceChallenge(challenge) {
  return typeof challenge === "string" && PKCE_CHALLENGE_RE.test(challenge);
}

function isValidPkceVerifier(verifier) {
  return typeof verifier === "string" && PKCE_VERIFIER_RE.test(verifier);
}

/** HTTPS redirect URIs only, except loopback HTTP for local development
 *  clients (localhost / 127.0.0.1 / ::1) — matches common OAuth 2.1 native-app
 *  guidance. No fragment (it would be dropped by user agents anyway and must
 *  not be relied on). Client registration doesn't exist yet in Phase 2, so
 *  the exact string is bound into the authorization code and re-checked
 *  verbatim at token exchange instead of validated against a registry. */
function isValidRedirectUri(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
  return false;
}

function normalizeOAuthScope(scope) {
  if (typeof scope !== "string" || scope.trim() === "") return "";
  return scope.trim().split(/\s+/).join(" ");
}

/** `state` is optional and opaque to us — we only bound its size and reject
 *  control characters (CR/LF/NUL in particular, since it's echoed verbatim
 *  into a redirect URL query parameter via URL.searchParams, never string
 *  concatenation, so this isn't an injection vector, but a byte/control-char
 *  cap keeps it from being abused as an arbitrary data channel). */
function isValidOAuthState(state) {
  if (state === null) return true;
  if (typeof state !== "string") return false;
  if (byteLength(state) > OAUTH_STATE_MAX_BYTES) return false;
  for (let i = 0; i < state.length; i++) {
    const code = state.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/** `scope` is optional (absent/empty means "no scope"). When present, every
 *  space-separated token must be a valid RFC 6749 scope-token — this also
 *  rejects leading/trailing/doubled spaces, since those split into empty
 *  tokens. */
function isValidOAuthScope(scope) {
  if (scope === null || scope === "") return true;
  if (typeof scope !== "string") return false;
  if (byteLength(scope) > OAUTH_SCOPE_MAX_BYTES) return false;
  return scope.split(" ").every((token) => OAUTH_SCOPE_TOKEN_RE.test(token));
}

/**
 * Builds the OAuth authorization-server + resource-token domain's operations
 * against a Durable Object's own SQLite (`sql`) plus the narrow capabilities
 * documented in this file's header comment. Methods call each other through
 * `this` (e.g. handleOAuthAuthorize calling this.renderOAuthAuthorizeForm),
 * which works because every call site invokes them as
 * `this.oauth.<method>(...)` from BridgeDO — a plain dot-call binds `this`
 * to the returned object itself, no class/prototype needed.
 */
function createBridgeOAuth({
  sql,
  checkHubOwnerToken,
  checkWorkspaceOwnerToken,
  hasHubOwnerSecret,
  lookupHubOAuthClient,
  checkOAuthRegisterRateLimit,
  generateHex,
  hashValue,
  renderConsentHtml,
  maxOAuthRequestBytes,
}) {
  return {
    // ======================= OAuth: authorization server + resource validation =======================
    // Internal-only: every method here is reached exclusively through the
    // oauth-* routes in BridgeDO.fetch, which are themselves reachable only
    // via a BRIDGE_DO binding call from the top-level Worker's
    // handleOAuthAuthorizeRoute/handleOAuthTokenRoute/validateAccessToken/
    // handleOAuthMcpResource — never from a public URL directly.

    /** A DO instance is either the hub (has hub_gpt_token, never gpt_token) or
     *  one workspace (has gpt_token, never hub_gpt_token) — provisionHub() and
     *  provision() are called on disjoint DO instances, so checking both keys
     *  here is sufficient without the caller having to tell us which one this
     *  is. */
    checkResourceOwnerToken(ownerToken) {
      return checkHubOwnerToken(ownerToken) || checkWorkspaceOwnerToken(ownerToken);
    },

    /** GET/POST /oauth-authorize (internal). GET renders a minimal HTML
     *  consent form (a real OAuth client navigates the browser here); POST
     *  processes that form's submission — or a direct POST from a
     *  non-interactive caller — and, on success, issues a short-lived
     *  one-time authorization code. Resource-owner auth is this workspace's/
     *  the hub's own existing gpt token, submitted only as POST body field
     *  `owner_token` — never in the URL, query string, or redirect. */
    async handleOAuthAuthorize(request) {
      return request.method === "GET" ? this.renderOAuthAuthorizeForm(request) : this.processOAuthAuthorizePost(request);
    },

    /** Shared by both the GET form-render path and the POST code-issuing
     *  path, so the two can never validate a request differently. Excludes
     *  `owner_token`, which only ever appears in a POST body and is checked
     *  separately by processOAuthAuthorizePost. Async because client lookup
     *  may be a cross-DO call (see getOAuthClient). */
    async validateOAuthAuthorizeRequest({ resource, clientId, redirectUri, responseType, codeChallenge, codeChallengeMethod, state, rawScope }) {
      if (!resource || !clientId || !redirectUri) {
        return { error: "invalid_request", description: "missing required parameter" };
      }
      if (clientId.length > 256) return { error: "invalid_request", description: "client_id too long" };
      if (byteLength(redirectUri) > OAUTH_REDIRECT_URI_MAX_BYTES) return { error: "invalid_request", description: "redirect_uri too long" };
      if (!isValidRedirectUri(redirectUri)) return { error: "invalid_request", description: "malformed redirect_uri" };
      if (responseType !== "code") return { error: "unsupported_response_type" };
      if (codeChallengeMethod !== "S256") return { error: "invalid_request", description: "code_challenge_method must be S256" };
      if (!isValidPkceChallenge(codeChallenge)) return { error: "invalid_request", description: "malformed code_challenge" };
      if (!isValidOAuthState(state)) return { error: "invalid_request", description: "malformed state" };
      if (!isValidOAuthScope(rawScope)) return { error: "invalid_request", description: "malformed scope" };

      // A DCR-registered client_id is bound to its registered redirect URIs;
      // an unregistered client_id keeps the Phase 2 compatibility behavior
      // (any syntactically valid redirect_uri, bound exactly into the code).
      const client = await this.getOAuthClient(clientId, resource);
      if (client && !client.redirectUris.includes(redirectUri)) {
        return { error: "invalid_request", description: "redirect_uri is not registered for this client" };
      }
      return { ok: true, client };
    },

    async renderOAuthAuthorizeForm(request) {
      const params = new URL(request.url).searchParams;
      const fields = {
        resource: params.get("resource") || "",
        clientId: params.get("client_id") || "",
        redirectUri: params.get("redirect_uri") || "",
        responseType: params.get("response_type") || "",
        codeChallenge: params.get("code_challenge") || "",
        codeChallengeMethod: params.get("code_challenge_method") || "",
        state: params.get("state"),
        rawScope: params.get("scope"),
      };
      const validation = await this.validateOAuthAuthorizeRequest(fields);
      if (validation.error) return oauthError(validation.error, validation.description, 400);
      return renderConsentHtml({ ...fields, scope: normalizeOAuthScope(fields.rawScope) });
    },

    async processOAuthAuthorizePost(request) {
      const parsed = await parseOAuthForm(request, maxOAuthRequestBytes);
      if (parsed.tooLarge) return oauthError("invalid_request", "payload too large", 413);
      if (parsed.unsupportedMediaType) return oauthError("invalid_request", "expected application/x-www-form-urlencoded", 415);
      const params = parsed.params;

      const resource = params.get("resource") || "";
      const clientId = params.get("client_id") || "";
      const redirectUri = params.get("redirect_uri") || "";
      const responseType = params.get("response_type") || "";
      const codeChallenge = params.get("code_challenge") || "";
      const codeChallengeMethod = params.get("code_challenge_method") || "";
      const ownerToken = params.get("owner_token") || "";
      const state = params.get("state");
      const rawScope = params.get("scope");

      if (!ownerToken) return oauthError("invalid_request", "missing required parameter", 400);
      const validation = await this.validateOAuthAuthorizeRequest({ resource, clientId, redirectUri, responseType, codeChallenge, codeChallengeMethod, state, rawScope });
      if (validation.error) return oauthError(validation.error, validation.description, 400);

      if (!this.checkResourceOwnerToken(ownerToken)) {
        // Deliberately a JSON error, not a redirect: an owner-auth failure
        // means we don't yet know this request actually came from the
        // resource owner, so bouncing the caller's browser to their
        // caller-supplied redirect_uri on failure isn't safe to do here.
        return oauthError("access_denied", "invalid owner credential", 403);
      }

      const scope = normalizeOAuthScope(rawScope);
      const rawCode = generateHex(32);
      const codeHash = await hashValue(rawCode);
      const now = Date.now();
      sql.exec(
        `INSERT INTO oauth_authorization_codes (code_hash, client_id, redirect_uri, resource, scope, code_challenge, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        codeHash,
        clientId,
        redirectUri,
        resource,
        scope,
        codeChallenge,
        now + OAUTH_CODE_TTL_MS,
        now,
      );

      const redirect = new URL(redirectUri);
      redirect.searchParams.set("code", rawCode);
      if (state !== null) redirect.searchParams.set("state", state);
      // RFC 9207: lets the client confirm which authorization server this
      // redirect actually came from (advertised via AS metadata's
      // authorization_response_iss_parameter_supported).
      redirect.searchParams.set("iss", new URL(request.url).origin);
      return new Response(null, { status: 302, headers: { location: redirect.toString(), "cache-control": "no-store" } });
    },

    /** True only for the one dedicated hub DO instance (see the same disjoint-
     *  secret reasoning as checkResourceOwnerToken): it alone ever gets
     *  hub_gpt_token set, via provisionHub(). */
    isHubInstance() {
      return hasHubOwnerSecret();
    },

    /** Reads a client_id's DCR record straight from this instance's own
     *  oauth_clients table. Only ever populated on the hub DO — see
     *  getOAuthClient for why — but harmless to expose on any instance. */
    getOAuthClientLocal(clientId) {
      const rows = sql.exec(`SELECT * FROM oauth_clients WHERE client_id = ?`, clientId).toArray();
      if (rows.length === 0) return null;
      const row = rows[0];
      let redirectUris;
      try {
        redirectUris = JSON.parse(row.redirect_uris_json);
      } catch {
        redirectUris = [];
      }
      return { clientId: row.client_id, redirectUris, tokenEndpointAuthMethod: row.token_endpoint_auth_method, clientName: row.client_name };
    },

    /** Registered-client metadata from DCR, or null for an unregistered
     *  client_id (Phase 2 compatibility clients). Client registrations are
     *  global — kept only in the hub DO's oauth_clients table (see
     *  handleOAuthRegisterRoute for why: a real DCR request carries no
     *  `resource` to route by) — so a workspace DO asks the hub DO over an
     *  injected cross-DO lookup callback rather than checking its own
     *  (always-empty) copy of the table. `resource` supplies the origin for
     *  that call; it carries no other meaning here. */
    async getOAuthClient(clientId, resource) {
      if (this.isHubInstance()) return this.getOAuthClientLocal(clientId);
      return lookupHubOAuthClient(clientId, resource);
    },

    /** POST /oauth-client-lookup (internal, hub DO only): looks up one
     *  client_id for a resource-owning DO's getOAuthClient() cross-DO call. */
    async handleOAuthClientLookup(request) {
      const parsed = await readJsonWithLimit(request, maxOAuthRequestBytes);
      if (parsed.tooLarge || parsed.parseError || !parsed.value || typeof parsed.value.clientId !== "string") {
        return json({ client: null });
      }
      return json({ client: this.getOAuthClientLocal(parsed.value.clientId) });
    },

    /** POST /oauth-register (internal, reached only via the hub DO — see
     *  handleOAuthRegisterRoute): minimal RFC 7591-style Dynamic Client
     *  Registration. Public clients only (token_endpoint_auth_method=none, no
     *  client secret) — this Worker never authenticates an OAuth client
     *  itself, only the resource owner (see checkResourceOwnerToken). Accepts
     *  (and ignores beyond validating/echoing) the standard optional metadata
     *  fields grant_types/response_types/application_type a real DCR client
     *  such as ChatGPT or the MCP SDK sends, so registration doesn't require
     *  any gpt-worker-specific field. */
    async handleOAuthRegister(request) {
      if (!checkOAuthRegisterRateLimit()) {
        return new Response(null, { status: 429, headers: { "retry-after": "60" } });
      }
      const parsed = await readJsonWithLimit(request, maxOAuthRequestBytes);
      if (parsed.tooLarge) return oauthError("invalid_request", "payload too large", 413);
      if (parsed.parseError || !parsed.value || typeof parsed.value !== "object") {
        return oauthError("invalid_request", "malformed JSON body", 400);
      }
      const body = parsed.value;

      const authMethod = body.token_endpoint_auth_method;
      if (authMethod !== undefined && authMethod !== "none") {
        return oauthError("invalid_client_metadata", "only token_endpoint_auth_method=none is supported", 400);
      }

      // grant_types/response_types/application_type are standard RFC 7591
      // fields a real DCR client commonly sends; validate them against what
      // this server actually supports (see oauthAuthorizationServerMetadata)
      // and echo them back, but don't require them — a minimal request with
      // only redirect_uris is equally valid.
      const grantTypes = body.grant_types;
      if (grantTypes !== undefined) {
        if (!Array.isArray(grantTypes) || grantTypes.length === 0 || !grantTypes.every((g) => g === "authorization_code" || g === "refresh_token")) {
          return oauthError("invalid_client_metadata", 'grant_types must be a subset of ["authorization_code","refresh_token"]', 400);
        }
      }
      const responseTypes = body.response_types;
      if (responseTypes !== undefined) {
        if (!Array.isArray(responseTypes) || responseTypes.length === 0 || !responseTypes.every((r) => r === "code")) {
          return oauthError("invalid_client_metadata", 'response_types must be a subset of ["code"]', 400);
        }
      }
      const applicationType = body.application_type;
      if (applicationType !== undefined && applicationType !== "web" && applicationType !== "native") {
        return oauthError("invalid_client_metadata", 'application_type must be "web" or "native"', 400);
      }

      const redirectUris = body.redirect_uris;
      if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
        return oauthError("invalid_client_metadata", "redirect_uris must be a non-empty array", 400);
      }
      if (redirectUris.length > 10) return oauthError("invalid_client_metadata", "too many redirect_uris", 400);
      if (new Set(redirectUris).size !== redirectUris.length) {
        return oauthError("invalid_client_metadata", "duplicate redirect_uris", 400);
      }
      for (const uri of redirectUris) {
        if (typeof uri !== "string" || byteLength(uri) > OAUTH_REDIRECT_URI_MAX_BYTES || !isValidRedirectUri(uri)) {
          return oauthError("invalid_client_metadata", "malformed redirect_uri", 400);
        }
      }

      let clientName = null;
      if (body.client_name !== undefined) {
        if (typeof body.client_name !== "string" || byteLength(body.client_name) > 200) {
          return oauthError("invalid_client_metadata", "malformed client_name", 400);
        }
        clientName = body.client_name;
      }

      const clientId = generateHex(16);
      const now = Date.now();
      sql.exec(
        `INSERT INTO oauth_clients (client_id, redirect_uris_json, token_endpoint_auth_method, client_name, created_at) VALUES (?, ?, ?, ?, ?)`,
        clientId,
        JSON.stringify(redirectUris),
        "none",
        clientName,
        now,
      );

      const response = {
        client_id: clientId,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: grantTypes ?? ["authorization_code", "refresh_token"],
        response_types: responseTypes ?? ["code"],
        client_name: clientName ?? undefined,
        application_type: applicationType ?? undefined,
      };
      return json(response, 201, { "cache-control": "no-store" });
    },

    /** POST /oauth-token (internal). Dispatches on `grant_type`. */
    async handleOAuthToken(request) {
      const parsed = await parseOAuthForm(request, maxOAuthRequestBytes);
      if (parsed.tooLarge) return oauthError("invalid_request", "payload too large", 413);
      if (parsed.unsupportedMediaType) return oauthError("invalid_request", "expected application/x-www-form-urlencoded", 415);
      const params = parsed.params;
      const grantType = params.get("grant_type") || "";
      if (grantType === "authorization_code") return this.exchangeOAuthAuthorizationCode(params);
      if (grantType === "refresh_token") return this.exchangeOAuthRefreshToken(params);
      return oauthError("unsupported_grant_type", null, 400);
    },

    async exchangeOAuthAuthorizationCode(params) {
      const code = params.get("code") || "";
      const clientId = params.get("client_id") || "";
      const redirectUri = params.get("redirect_uri") || "";
      const resource = params.get("resource") || "";
      const codeVerifier = params.get("code_verifier") || "";
      if (!code || !clientId || !redirectUri || !resource || !codeVerifier) {
        return oauthError("invalid_request", "missing required parameter", 400);
      }
      if (!isValidPkceVerifier(codeVerifier)) return oauthError("invalid_grant", "malformed code_verifier", 400);

      const codeHash = await hashValue(code);
      const rows = sql.exec(`SELECT * FROM oauth_authorization_codes WHERE code_hash = ?`, codeHash).toArray();
      // One-time use: consume the code now regardless of what the rest of this
      // check finds, so a second exchange attempt (racing or replayed) always
      // sees "no such code" rather than being able to retry validation.
      sql.exec(`DELETE FROM oauth_authorization_codes WHERE code_hash = ?`, codeHash);
      if (rows.length === 0) return oauthError("invalid_grant", "unknown or already-used code", 400);
      const row = rows[0];
      if (row.expires_at < Date.now()) return oauthError("invalid_grant", "code expired", 400);
      if (row.client_id !== clientId || row.redirect_uri !== redirectUri || row.resource !== resource) {
        return oauthError("invalid_grant", "client_id/redirect_uri/resource mismatch", 400);
      }
      // Belt-and-suspenders: if client_id is (now) registered, its redirect_uri
      // set is the current authority, so a code issued before a registration
      // change can't redeem against a URI that's since been dropped.
      const client = await this.getOAuthClient(clientId, resource);
      if (client && !client.redirectUris.includes(redirectUri)) {
        return oauthError("invalid_grant", "redirect_uri is not registered for this client", 400);
      }
      const computedChallenge = await pkceChallengeFromVerifier(codeVerifier);
      if (!constantTimeEqual(computedChallenge, row.code_challenge)) {
        return oauthError("invalid_grant", "code_verifier does not match", 400);
      }

      return this.issueOAuthTokenFamily({ clientId, resource: row.resource, scope: row.scope, familyId: generateHex(16) });
    },

    async exchangeOAuthRefreshToken(params) {
      const refreshToken = params.get("refresh_token") || "";
      const clientId = params.get("client_id") || "";
      const resource = params.get("resource") || "";
      if (!refreshToken || !clientId || !resource) return oauthError("invalid_request", "missing required parameter", 400);

      const tokenHash = await hashValue(refreshToken);
      const rows = sql.exec(`SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?`, tokenHash).toArray();
      if (rows.length === 0) return oauthError("invalid_grant", "unknown refresh token", 400);
      const row = rows[0];

      if (row.used_at !== null || row.revoked_at !== null) {
        // Presenting an already-rotated or already-revoked refresh token is
        // treated as a stolen-token signal: revoke the whole token family so a
        // leaked-then-rotated token can't be replayed to keep a session alive.
        this.revokeOAuthFamily(row.family_id);
        return oauthError("invalid_grant", "refresh token reuse detected", 400);
      }
      if (row.expires_at < Date.now()) return oauthError("invalid_grant", "refresh token expired", 400);
      if (row.client_id !== clientId || row.resource !== resource) {
        return oauthError("invalid_grant", "client_id/resource mismatch", 400);
      }

      sql.exec(`UPDATE oauth_refresh_tokens SET used_at = ? WHERE token_hash = ?`, Date.now(), tokenHash);
      return this.issueOAuthTokenFamily({ clientId, resource: row.resource, scope: row.scope, familyId: row.family_id });
    },

    async issueOAuthTokenFamily({ clientId, resource, scope, familyId }) {
      const now = Date.now();
      const rawAccess = generateHex(32);
      const accessHash = await hashValue(rawAccess);
      sql.exec(
        `INSERT INTO oauth_access_tokens (token_hash, client_id, resource, scope, family_id, expires_at, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        accessHash,
        clientId,
        resource,
        scope,
        familyId,
        now + OAUTH_ACCESS_TTL_MS,
        now,
      );
      const rawRefresh = generateHex(32);
      const refreshHash = await hashValue(rawRefresh);
      sql.exec(
        `INSERT INTO oauth_refresh_tokens (token_hash, family_id, client_id, resource, scope, expires_at, created_at, used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        refreshHash,
        familyId,
        clientId,
        resource,
        scope,
        now + OAUTH_REFRESH_TTL_MS,
        now,
      );
      return json(
        {
          access_token: rawAccess,
          token_type: "Bearer",
          expires_in: Math.floor(OAUTH_ACCESS_TTL_MS / 1000),
          refresh_token: rawRefresh,
          scope,
          resource,
        },
        200,
        { "cache-control": "no-store", pragma: "no-cache" },
      );
    },

    revokeOAuthFamily(familyId) {
      const now = Date.now();
      sql.exec(`UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL`, now, familyId);
      sql.exec(`UPDATE oauth_access_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL`, now, familyId);
    },

    /** POST /oauth-validate (internal, JSON body {tokenHash, resource}). Used
     *  only by the top-level validateAccessToken() — never exposed publicly,
     *  so the raw bearer token itself never needs to reach here, only its
     *  hash. */
    async handleOAuthValidate(request) {
      const parsed = await readJsonWithLimit(request, maxOAuthRequestBytes);
      if (parsed.tooLarge || parsed.parseError || !parsed.value) return json({ valid: false });
      const { tokenHash, resource } = parsed.value;
      if (typeof tokenHash !== "string" || typeof resource !== "string") return json({ valid: false });
      const rows = sql.exec(`SELECT * FROM oauth_access_tokens WHERE token_hash = ?`, tokenHash).toArray();
      if (rows.length === 0) return json({ valid: false });
      const row = rows[0];
      if (row.revoked_at !== null || row.expires_at < Date.now() || row.resource !== resource) {
        return json({ valid: false });
      }
      return json({ valid: true, client_id: row.client_id, scope: row.scope });
    },

    // ======================= revocation / lifecycle =======================

    /** Revokes every OAuth authorization code/access token/refresh token this
     *  DO has issued for its own resource — not the DCR client registry
     *  (oauth_clients), which is independent of any owner credential. Called
     *  when gpt_token/hub_gpt_token rotates, since that value doubles as the
     *  OAuth resource-owner credential (see checkResourceOwnerToken): a
     *  deliberate rotation (e.g. because it may have leaked) should also cut
     *  off OAuth grants already issued under the old value, not just block
     *  future /oauth-authorize calls. */
    revokeAllOAuthTokens() {
      sql.exec(`DELETE FROM oauth_authorization_codes`);
      sql.exec(`DELETE FROM oauth_access_tokens`);
      sql.exec(`DELETE FROM oauth_refresh_tokens`);
    },

    /** Wipes all OAuth server state for this DO — every issued authorization
     *  code, access token, refresh token, and (unlike revokeAllOAuthTokens()
     *  above) every registered DCR client too. Used only by admin's
     *  deprovision(), which removes the workspace entirely; a token rotation
     *  must not lose registered clients, so it uses revokeAllOAuthTokens()
     *  instead. */
    clearOAuthState() {
      sql.exec(`DELETE FROM oauth_authorization_codes`);
      sql.exec(`DELETE FROM oauth_access_tokens`);
      sql.exec(`DELETE FROM oauth_refresh_tokens`);
      sql.exec(`DELETE FROM oauth_clients`);
    },

    /** Sweeps expired authorization codes and expired-or-revoked access/
     *  refresh tokens — the OAuth-table portion of BridgeDO.alarm()'s daily
     *  retention pass, moved here so index.js no longer touches these tables
     *  directly. Dashboard session cleanup and msgs/tasks retention are a
     *  different domain's concern and stay in index.js's own alarm(). */
    cleanupExpiredOAuthState(now) {
      sql.exec(`DELETE FROM oauth_authorization_codes WHERE expires_at < ?`, now);
      sql.exec(`DELETE FROM oauth_access_tokens WHERE expires_at < ? OR revoked_at IS NOT NULL`, now);
      sql.exec(`DELETE FROM oauth_refresh_tokens WHERE expires_at < ? OR revoked_at IS NOT NULL`, now);
    },
  };
}

export { createBridgeOAuth };
