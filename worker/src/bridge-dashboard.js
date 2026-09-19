// Web dashboard domain (workspace dashboard, shared hub dashboard, dashboard
// sessions, history/API operations, and the binding-only hub-dashboard relay),
// extracted verbatim from BridgeDO (see worker/src/index.js). Behavior,
// response shapes, error codes, cookie attributes, CSP/headers, and rate-limit
// bucket selection are unchanged from the pre-extraction implementation —
// this module only relocates the code. See
// docs/plans/queue-dashboard.md for the dashboard's design record and
// docs/plans/pending/worker-cli-dashboard-modularization-phase0-map.md §13
// for the domain dependency/capability matrix this extraction follows.
//
// Dependency direction: this module imports only pure helpers
// (worker-http.js, worker-dashboard-http.js) and the dashboard's fixed Text-
// module browser assets (worker/src/dashboard/*). It never imports index.js
// or any sibling bridge-*.js domain module (admin/protocol/oauth/mcp/
// transport), and never touches `env`/`BRIDGE_DO`/`ctx` itself. Its own SQL
// is limited to the `dashboard_sessions` table it owns; `msgs`/`tasks`
// reads it needs for history/ack are protocol-owned read capabilities.
// Everything else is received as a narrow, purpose-fixed capability from
// createBridgeDashboard's caller (BridgeDO's constructor):
//  - sql: this DO's SQLite handle, used only for `dashboard_sessions`.
//  - generateSessionToken() / hashSessionToken(value): session-token
//    generation and hashing (index.js's randomHex(32) / sha256Hex — shared
//    with admin/OAuth/top-level, so not duplicated here).
//  - escapeHtmlValue(value): pure HTML escaper for template markers
//    (index.js's escapeHtml, shared with the OAuth consent page).
//  - checkResourceOwnerToken(token), hasSecrets(), isHubInstance(),
//    workspaceGuidance(), maxBodyBytes(), maxRequestBytes(),
//    localMaxBodyBytesGet/Set, localBrowserSettingsGet/Set,
//    hubBrowserSettingsGet/Set, localGuidanceSet/Clear, parseProjectUrl/
//    parseConversationUrl/areSameProject, registeredWorkspaces():
//    admin/settings/registry/OAuth-owned reads and writes.
//  - activeTask(), taskView(task), getTask(taskId), localAck/localDiscard/
//    localDiscardTask/localStartTask/localCompleteTask/localContinueTask:
//    protocol operations — the very same ones the CLI uses, so the two
//    surfaces can never disagree about what's allowed.
//  - queryDashboardMessages(args) / queryDashboardTasks(args) /
//    messageDirection(messageId): protocol-owned read-only queries backing
//    the history/ack APIs (response shaping and cursor encoding stay here).
//  - localStatus(): transport's connection/queue-count status.
//  - consumeDashboardRateLimit(bucket, maxPerMinute): transport's generic
//    rate limiter. Bucket names are chosen here, never by the caller, and
//    workspace (`dashboard-*`) and hub (`hub-dashboard-*`) buckets stay
//    disjoint (see each handler's own comment).
//  - notifyDashboardTaskCreated(taskId): the best-effort
//    `dashboard_task_created` push to the local bridge (transport's
//    callLocal, not a generic handle).
//  - fetchHubBrowserSettings(): the cross-DO read a workspace DO makes of
//    the hub DO's browser settings. Resolves to the settings object or null.
//  - fetchWorkspaceDashboardRelay(workspaceId, envelope): the binding-only
//    cross-DO call the hub makes to a workspace DO's internal
//    `/hub-dashboard-relay` route. Resolves to that route's raw Response. It
//    forwards only the already-authorized `envelope` (name/method/query/
//    body) — never the hub session cookie or hub_gpt_token. These two
//    callbacks are the only place the dashboard touches env.BRIDGE_DO —
//    inside index.js, never here.
//  - maxFixedRequestBytes / maxSharedRequestBytes: index.js's
//    MAX_REQUEST_BYTES and MAX_REQUEST_BYTES_CEILING (scalars). The latter
//    is the hub->workspace pre-relay envelope gate, used because the hub DO
//    can't know the target workspace's own max_body_bytes; the real,
//    precise limit is enforced by the target's own dashboardApiDispatch.
//  - ackedMessageRetentionMs / terminalTaskRetentionMs: index.js's
//    RETENTION_MS / TASK_RETENTION_MS (scalars, shared with alarm()),
//    reported by dashboardOverview().
//
// The workspace dashboard and the hub dashboard share *mechanism* but never
// *authority*. The mechanism — asset/shell serving, login, logout, and the
// authenticated-API gate — lives once in the lexical helpers serveDashboardAsset/
// serveDashboardShell/loginDashboardSession/logoutDashboardSession/
// gateDashboardApi below, alongside the session table, cookie name and
// dispatcher. The authority provenance stays explicit and separate in the
// handleDashboard* / handleHubDashboard* wrappers, each passing its own literal
// rate-limit bucket names and cookie scope (workspace_id vs "hub") into those
// helpers: separate buckets, separate cookie Paths, separate DO
// instances/dashboard_sessions tables, and the hub reaches a workspace only via
// the binding-only relay after its own session/CSRF/rate-limit/registry-
// membership checks. handleDashboard and handleHubDashboard are deliberately
// two separate routers, not one generic one; helpers never default a bucket or
// cookie scope, so a caller can't silently inherit the wrong authority.
//
// dashboardApiDispatch is the one dispatcher for every per-workspace
// dashboard operation and performs no auth itself — it must only ever be
// reached through handleDashboardApi (public workspace route) or
// handleHubDashboardRelay (binding-only hub relay).

import WORKSPACE_DASHBOARD_APP_JS from "./dashboard/workspace-app.js";
import HUB_DASHBOARD_APP_JS from "./dashboard/hub-app.js";
import COMMON_DASHBOARD_APP_JS from "./dashboard/common-app.js";
import WORKSPACE_PANEL_JS from "./dashboard/workspace-panel.js";
import DASHBOARD_CSS from "./dashboard/dashboard.css";
import WORKSPACE_DASHBOARD_LOGIN_HTML from "./dashboard/workspace-login.html";
import WORKSPACE_DASHBOARD_SHELL_HTML from "./dashboard/workspace-shell.html";
import HUB_DASHBOARD_LOGIN_HTML from "./dashboard/hub-login.html";
import HUB_DASHBOARD_SHELL_HTML from "./dashboard/hub-shell.html";
import { isValidWorkspaceId, json, byteLength, readJsonWithLimit } from "./worker-http.js";
import {
  checkDashboardOrigin,
  readDashboardSessionCookie,
  dashboardSessionCookie,
  methodNotAllowed,
  rateLimitedResponse,
  dashboardHtmlHeaders,
  dashboardJsHeaders,
  dashboardCssHeaders,
  dashboardApiHeaders,
  encodeDashboardCursor,
  decodeDashboardCursor,
  fillDashboardTemplate,
} from "./worker-dashboard-http.js";

// docs/plans/queue-dashboard.md: workspace-owner-only Web dashboard.
// Session lifecycle (§"dashboard session のライフサイクル"): 24h TTL, hashed
// storage (never the raw token), swept by alarm(), revoked wholesale on
// gpt_token rotation and on deprovision. Cookie is Path-scoped per workspace
// (see dashboardSessionCookie) so two workspaces' dashboards never collide in
// the same browser even though they share this one cookie name.
const DASHBOARD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DASHBOARD_HISTORY_DEFAULT_LIMIT = 50;
const DASHBOARD_HISTORY_MAX_LIMIT = 100;

/**
 * Builds the dashboard domain's operations against the narrow capabilities
 * documented in the header above.
 *
 * Methods call each other through `this` (e.g. handleDashboardApi calling
 * this.dashboardApiDispatch), which works because every call site invokes
 * them as `this.dashboard.<method>(...)` from BridgeDO — a plain dot-call
 * binds `this` to the returned object itself, no class/prototype needed.
 */
function createBridgeDashboard({
  sql,
  generateSessionToken,
  hashSessionToken,
  escapeHtmlValue,
  checkResourceOwnerToken,
  hasSecrets,
  isHubInstance,
  workspaceGuidance,
  maxBodyBytes,
  maxRequestBytes,
  localMaxBodyBytesGet,
  localMaxBodyBytesSet,
  localBrowserSettingsGet,
  localBrowserSettingsSet,
  hubBrowserSettingsGet,
  hubBrowserSettingsSet,
  localGuidanceSet,
  localGuidanceClear,
  parseProjectUrl,
  parseConversationUrl,
  areSameProject,
  registeredWorkspaces,
  activeTask,
  taskView,
  getTask,
  localAck,
  localDiscard,
  localDiscardTask,
  localStartTask,
  localCompleteTask,
  localContinueTask,
  queryDashboardMessages,
  queryDashboardTasks,
  messageDirection,
  localStatus,
  consumeDashboardRateLimit,
  notifyDashboardTaskCreated,
  fetchHubBrowserSettings,
  fetchWorkspaceDashboardRelay,
  maxFixedRequestBytes,
  maxSharedRequestBytes,
  ackedMessageRetentionMs,
  terminalTaskRetentionMs,
}) {
  // -------------------------------------------------------------------------
  // Dashboard HTML shell + same-origin browser assets (docs/plans/queue-dashboard.md).
  // Shares the OAuth consent page's plain, dependency-free look; unlike that
  // page this one needs browser assets (polling plus styles), so its CSP allows
  // same-origin script/style modules, served separately rather than inlined.
  // -------------------------------------------------------------------------

  function renderDashboardLoginHtml(workspaceId) {
    return fillDashboardTemplate(WORKSPACE_DASHBOARD_LOGIN_HTML, {
      WORKSPACE_ID: escapeHtmlValue(workspaceId),
      APP_JS_URL: `/dashboard/${encodeURIComponent(workspaceId)}/app.js`,
      APP_CSS_URL: `/dashboard/${encodeURIComponent(workspaceId)}/app.css`,
    });
  }

  function renderDashboardShellHtml(workspaceId) {
    return fillDashboardTemplate(WORKSPACE_DASHBOARD_SHELL_HTML, {
      WORKSPACE_ID: escapeHtmlValue(workspaceId),
      APP_JS_URL: `/dashboard/${encodeURIComponent(workspaceId)}/app.js`,
      APP_CSS_URL: `/dashboard/${encodeURIComponent(workspaceId)}/app.css`,
    });
  }

  // -------------------------------------------------------------------------
  // Shared hub dashboard HTML shell + script: same look/CSP/no-inline-HTML
  // rules as the per-workspace dashboard above, but scoped to "/dashboard/hub"
  // and driven by the hub DO's own registeredWorkspaces() rather than a single
  // workspace_id. See handleHubDashboard for the server-side routes and the
  // "hub authority propagation" design note on handleHubDashboardRelay for why
  // this never forwards the hub session/token into a workspace DO.
  // -------------------------------------------------------------------------

  function renderHubDashboardLoginHtml() {
    return fillDashboardTemplate(HUB_DASHBOARD_LOGIN_HTML, { APP_CSS_URL: "/dashboard/hub/app.css" });
  }

  function renderHubDashboardShellHtml() {
    return fillDashboardTemplate(HUB_DASHBOARD_SHELL_HTML, { APP_CSS_URL: "/dashboard/hub/app.css" });
  }

  // Dashboard sessions: lexical so the mechanism helpers below and the returned
  // object's public methods (BridgeDO's delegates) share one implementation with
  // no `this` dependency. Each DO (workspace or hub) has its own
  // dashboard_sessions table; the same code in two DOs never shares state.

  async function createSession() {
    const raw = generateSessionToken();
    const hash = await hashSessionToken(raw);
    const now = Date.now();
    sql.exec(`INSERT INTO dashboard_sessions (session_hash, expires_at, created_at) VALUES (?, ?, ?)`, hash, now + DASHBOARD_SESSION_TTL_MS, now);
    return { raw, expiresAt: now + DASHBOARD_SESSION_TTL_MS };
  }

  /** Also opportunistically deletes an already-expired row it happens to hit,
   *  rather than waiting for the next alarm() sweep — cheap, and keeps a
   *  just-expired session from working until the next 24h alarm cycle runs. */
  async function verifySession(raw) {
    if (typeof raw !== "string" || !raw) return false;
    const hash = await hashSessionToken(raw);
    const rows = sql.exec(`SELECT expires_at FROM dashboard_sessions WHERE session_hash = ?`, hash).toArray();
    if (rows.length === 0) return false;
    if (rows[0].expires_at < Date.now()) {
      sql.exec(`DELETE FROM dashboard_sessions WHERE session_hash = ?`, hash);
      return false;
    }
    return true;
  }

  async function revokeSession(raw) {
    if (typeof raw !== "string" || !raw) return;
    const hash = await hashSessionToken(raw);
    sql.exec(`DELETE FROM dashboard_sessions WHERE session_hash = ?`, hash);
  }

  // Shared dashboard *mechanism* (workspace and hub). Bucket names and cookie
  // scope are required arguments, never defaults, so each wrapper's authority
  // choice stays visible at its call site. Rate limiting has **no bucket in
  // common** between an unauthenticated and an authenticated path (workspace_id
  // is a routing key, not a secret, so an uncredentialed flood must never 429
  // the owner's own calls): public shell/assets/logout use `*-public`, login
  // its own tight `*-login`, and the API gate picks `*-api-unauth` vs `*-api`
  // strictly by that call's own session-verification outcome. Check order in
  // each helper is a behavior contract: method -> Origin (POST) -> rate limit.

  const DASHBOARD_PUBLIC_RATE_LIMIT = 120;
  const DASHBOARD_LOGIN_RATE_LIMIT = 10;
  const DASHBOARD_API_RATE_LIMIT = 120;

  /** Fixed same-origin browser asset (app.js / app.css): GET-only, public bucket. */
  async function serveDashboardAsset(request, { bucket, body, makeHeaders }) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    if (!consumeDashboardRateLimit(bucket, DASHBOARD_PUBLIC_RATE_LIMIT)) return rateLimitedResponse();
    return new Response(body, { status: 200, headers: makeHeaders() });
  }

  /** Root HTML: the shell for a valid session, the login page otherwise. */
  async function serveDashboardShell(request, { bucket, renderLogin, renderShell }) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    if (!consumeDashboardRateLimit(bucket, DASHBOARD_PUBLIC_RATE_LIMIT)) return rateLimitedResponse();
    const authed = await verifySession(readDashboardSessionCookie(request));
    return new Response(authed ? renderShell() : renderLogin(), { status: 200, headers: dashboardHtmlHeaders() });
  }

  /** Exchanges this DO's owner token (checkResourceOwnerToken: gpt_token on a
   *  workspace DO, hub_gpt_token on the hub DO) for a session cookie scoped to
   *  `cookieScope` (workspace_id, or "hub"). */
  async function loginDashboardSession(request, { bucket, cookieScope }) {
    if (request.method !== "POST") return methodNotAllowed("POST");
    if (!checkDashboardOrigin(request)) return json({ error: "FORBIDDEN_ORIGIN" }, 403, dashboardApiHeaders());
    // Credential-guessing surface: its own tight bucket, far below polling caps.
    if (!consumeDashboardRateLimit(bucket, DASHBOARD_LOGIN_RATE_LIMIT)) return rateLimitedResponse();
    const parsed = await readJsonWithLimit(request, maxFixedRequestBytes);
    if (parsed.tooLarge) return json({ error: "PAYLOAD_TOO_LARGE" }, 413, dashboardApiHeaders());
    if (parsed.parseError || !parsed.value || typeof parsed.value.ownerToken !== "string" || !parsed.value.ownerToken) {
      return json({ error: "INVALID_ARGS" }, 400, dashboardApiHeaders());
    }
    if (!checkResourceOwnerToken(parsed.value.ownerToken)) {
      return json({ error: "INVALID_CREDENTIAL" }, 403, dashboardApiHeaders());
    }
    const session = await createSession();
    return json({ ok: true }, 200, {
      ...dashboardApiHeaders(),
      "set-cookie": dashboardSessionCookie(cookieScope, session.raw, Math.floor(DASHBOARD_SESSION_TTL_MS / 1000)),
    });
  }

  async function logoutDashboardSession(request, { bucket, cookieScope }) {
    if (request.method !== "POST") return methodNotAllowed("POST");
    if (!checkDashboardOrigin(request)) return json({ error: "FORBIDDEN_ORIGIN" }, 403, dashboardApiHeaders());
    if (!consumeDashboardRateLimit(bucket, DASHBOARD_PUBLIC_RATE_LIMIT)) return rateLimitedResponse();
    await revokeSession(readDashboardSessionCookie(request));
    return json({ ok: true }, 200, { ...dashboardApiHeaders(), "set-cookie": dashboardSessionCookie(cookieScope, "", 0) });
  }

  /** Every /api/* route requires a valid session; every POST also requires a
   *  strict same-origin Origin (checkDashboardOrigin; `SameSite=Strict` alone
   *  is not sufficient CSRF protection, §"状態変更 API の CSRF 対策"). Returns
   *  a denial Response, or null once authenticated, rate-limited under
   *  `authBucket` and origin-checked; it never dispatches. `unauthBucket` only
   *  ever accounts for a request that just failed verification, `authBucket`
   *  only one whose session just verified. */
  async function gateDashboardApi(request, { unauthBucket, authBucket }) {
    const authed = await verifySession(readDashboardSessionCookie(request));
    if (!authed) {
      if (!consumeDashboardRateLimit(unauthBucket, DASHBOARD_API_RATE_LIMIT)) return rateLimitedResponse();
      return json({ error: "UNAUTHENTICATED" }, 401, dashboardApiHeaders());
    }
    if (!consumeDashboardRateLimit(authBucket, DASHBOARD_API_RATE_LIMIT)) return rateLimitedResponse();
    if (request.method === "POST" && !checkDashboardOrigin(request)) {
      return json({ error: "FORBIDDEN_ORIGIN" }, 403, dashboardApiHeaders());
    }
    return null;
  }

  return {
    // ======================= /dashboard : Web dashboard =======================
    // docs/plans/queue-dashboard.md. Workspace-owner-only: login exchanges the
    // workspace's own gpt_token (never hub_gpt_token — see
    // checkResourceOwnerToken's doc comment: a workspace DO never has
    // hub_gpt_token set, so only gpt_token can ever succeed here) for a
    // short-lived hashed session (see the dashboard_sessions table comment in
    // the constructor). Every mutation reuses the same local* methods the CLI
    // uses, so the two surfaces can never disagree about what's allowed.

    createDashboardSession: createSession,
    verifyDashboardSession: verifySession,
    revokeDashboardSession: revokeSession,

    /** Called from rotateSecret("gpt_token") and deprovision() — see their own
     *  comments for why a leaked-token rotation must also cut off sessions
     *  already issued under the old value. */
    revokeAllDashboardSessions() {
      sql.exec(`DELETE FROM dashboard_sessions`);
    },

    /** Sweeps already-expired rows — called from BridgeDO.alarm()'s normal
     *  24h cycle (alongside OAuth code/token cleanup), which remains index.js's
     *  lifecycle orchestrator; only the dashboard_sessions DELETE lives here. */
    cleanupExpiredDashboardSessions(now) {
      sql.exec(`DELETE FROM dashboard_sessions WHERE expires_at < ?`, now);
    },

    async handleDashboard(request, workspaceId, subParts) {
      // No shared pre-auth rate-limit bucket here on purpose: an earlier
      // version gated every dashboard request (public shell, login, and
      // authenticated API alike) through one "dashboard" bucket before
      // dispatch, which let an unauthenticated caller — workspace_id is a
      // routing key, not a secret, so this needs no credential at all —
      // exhaust the same bucket the legitimate owner's authenticated
      // polling/mutations depend on. Each route below owns its own bucket
      // instead (see handleDashboardShell/handleDashboardAppJs/handleDashboardAppCss/
      // handleDashboardLogin/handleDashboardLogout/handleDashboardApi), sized
      // for what it actually guards.
      if (subParts.length === 0) return this.handleDashboardShell(request, workspaceId);
      if (subParts.length === 1 && subParts[0] === "app.js") return this.handleDashboardAppJs(request);
      if (subParts.length === 1 && subParts[0] === "common-app.js") return serveDashboardAsset(request, { bucket: "dashboard-public", body: COMMON_DASHBOARD_APP_JS, makeHeaders: dashboardJsHeaders });
      if (subParts.length === 1 && subParts[0] === "workspace-panel.js") return serveDashboardAsset(request, { bucket: "dashboard-public", body: WORKSPACE_PANEL_JS, makeHeaders: dashboardJsHeaders });
      if (subParts.length === 1 && subParts[0] === "app.css") return this.handleDashboardAppCss(request);
      if (subParts.length === 1 && subParts[0] === "login") return this.handleDashboardLogin(request, workspaceId);
      if (subParts.length === 1 && subParts[0] === "logout") return this.handleDashboardLogout(request, workspaceId);
      if (subParts[0] === "api") return this.handleDashboardApi(request, subParts.slice(1));
      return new Response("not found", { status: 404 });
    },

    async handleDashboardShell(request, workspaceId) {
      return serveDashboardShell(request, {
        bucket: "dashboard-public",
        renderLogin: () => renderDashboardLoginHtml(workspaceId),
        renderShell: () => renderDashboardShellHtml(workspaceId),
      });
    },

    async handleDashboardAppJs(request) {
      return serveDashboardAsset(request, { bucket: "dashboard-public", body: WORKSPACE_DASHBOARD_APP_JS, makeHeaders: dashboardJsHeaders });
    },

    async handleDashboardAppCss(request) {
      return serveDashboardAsset(request, { bucket: "dashboard-public", body: DASHBOARD_CSS, makeHeaders: dashboardCssHeaders });
    },

    async handleDashboardLogin(request, workspaceId) {
      return loginDashboardSession(request, { bucket: "dashboard-login", cookieScope: workspaceId });
    },

    async handleDashboardLogout(request, workspaceId) {
      return logoutDashboardSession(request, { bucket: "dashboard-public", cookieScope: workspaceId });
    },

    /** Workspace authority: `dashboard-api-unauth` / `dashboard-api` buckets
     *  (see gateDashboardApi). Past the gate, everything goes through
     *  dashboardApiDispatch. */
    async handleDashboardApi(request, subParts) {
      const denied = await gateDashboardApi(request, { unauthBucket: "dashboard-api-unauth", authBucket: "dashboard-api" });
      if (denied) return denied;

      const name = subParts.join("/");
      const url = new URL(request.url);
      return this.dashboardApiDispatch(name, request.method, request, url);
    },

    /** The actual per-workspace dashboard operations, factored out of
     *  handleDashboardApi so the exact same dispatch — with identical
     *  validation/state semantics — serves two different auth paths without
     *  duplicating any of it (§"hub authority propagation" design note on
     *  handleHubDashboardRelay):
     *   (A) the public per-workspace dashboard, gated by handleDashboardApi's
     *       own session/CSRF/rate-limit checks above;
     *   (B) the binding-only hub relay (handleHubDashboardRelay), gated
     *       instead by the *hub* DO's session/CSRF/rate-limit checks and
     *       registry-membership check before the call ever reaches this
     *       workspace's DO.
     *  This method itself performs no auth — it must only ever be reached
     *  through one of those two already-gated callers. */
    async dashboardApiDispatch(name, method, request, url) {
      if (name === "overview" && method === "GET") return json(this.dashboardOverview(), 200, dashboardApiHeaders());
      if (name === "messages" && method === "GET") return json(this.dashboardMessages(url.searchParams), 200, dashboardApiHeaders());
      if (name === "tasks" && method === "GET") return json(this.dashboardTasks(url.searchParams), 200, dashboardApiHeaders());
      if (name === "guidance" && method === "GET") return json(workspaceGuidance(), 200, dashboardApiHeaders());
      if (name === "guidance" && method === "POST") return json(await this.dashboardSetGuidance(request), 200, dashboardApiHeaders());
      if (name === "limits" && method === "GET") return json(localMaxBodyBytesGet(), 200, dashboardApiHeaders());
      if (name === "limits" && method === "POST") return json(await this.dashboardSetLimits(request), 200, dashboardApiHeaders());
      if (name === "browser-settings" && method === "GET") {
        const local = localBrowserSettingsGet();
        const hubSettings = await this.getHubBrowserSettings();
        const sharedChatUrl = (hubSettings && hubSettings.chatUrl) || null;
        const effectiveProjectUrl = local.chatUrlOverride || sharedChatUrl || null;
        return json({
          ...local,
          sharedChatUrl,
          effectiveProjectUrl,
        }, 200, dashboardApiHeaders());
      }
      if (name === "browser-settings" && method === "POST") return json(await this.dashboardSetBrowserSettings(request), 200, dashboardApiHeaders());
      if (name === "ack" && method === "POST") return json(await this.dashboardAck(request), 200, dashboardApiHeaders());
      if (name === "complete-task" && method === "POST") return json(await this.dashboardCompleteTask(request), 200, dashboardApiHeaders());
      if (name === "continue-task" && method === "POST") return json(await this.dashboardContinueTask(request), 200, dashboardApiHeaders());
      if (name === "discard" && method === "POST") return json(await this.dashboardDiscard(request), 200, dashboardApiHeaders());
      if (name === "discard-task" && method === "POST") return json(await this.dashboardDiscardTask(request), 200, dashboardApiHeaders());
      if (name === "start-task" && method === "POST") return json(await this.dashboardStartTask(request), 200, dashboardApiHeaders());
      return json({ error: "UNKNOWN_ROUTE" }, 404, dashboardApiHeaders());
    },

    dashboardOverview() {
      const status = localStatus();
      return {
        connected: status.connected,
        pendingToGpt: status.pendingToGpt,
        pendingToLocal: status.pendingToLocal,
        activeTask: taskView(activeTask()),
        guidanceSet: workspaceGuidance().set,
        maxBodyBytes: localMaxBodyBytesGet().maxBodyBytes,
        retention: { ackedMessagesMs: ackedMessageRetentionMs, terminalTasksMs: terminalTaskRetentionMs },
      };
    },

    /** Retention-bounded (§"retention 境界"), acked-included message history —
     *  unlike localList() (unacked only, debug-oriented). Keyset-paginated
     *  (created_at DESC, message_id DESC) per the U4 API contract. */
    dashboardMessages(params) {
      const limit = Math.min(Math.max(Number(params.get("limit")) || DASHBOARD_HISTORY_DEFAULT_LIMIT, 1), DASHBOARD_HISTORY_MAX_LIMIT);
      const taskId = params.get("task_id") || null;
      // The task-detail exchange history needs only transport metadata. Keep
      // the default dashboard API response backward-compatible, but allow that
      // view to opt out of selecting/serializing message bodies entirely.
      const includeBody = params.get("include_body") !== "0";
      const cursor = decodeDashboardCursor(params.get("cursor"));
      const rows = queryDashboardMessages({ taskId, cursor, includeBody, limit });
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const now = Date.now();
      return {
        messages: page.map((r) => {
          const message = {
            messageId: r.message_id,
            dir: r.dir,
            taskId: r.task_id,
            iteration: r.iteration,
            kind: r.kind,
            title: r.title || null,
            // Same leased-but-expired normalization as localList() — see there.
            state: r.state === "leased" && r.lease_until && r.lease_until < now ? "pending" : r.state,
            createdAt: r.created_at,
          };
          if (includeBody) message.body = r.body;
          return message;
        }),
        nextCursor: hasMore ? encodeDashboardCursor(page[page.length - 1].created_at, page[page.length - 1].message_id) : null,
      };
    },

    /** Full task history (not just terminal, unlike taskHistory()), keyset-
     *  paginated (updated_at DESC, task_id DESC). Uses the correctly-named
     *  `updatedAt` field rather than repeating taskHistory()'s misnamed
     *  `created_at` (see docs/plans/queue-dashboard.md's "既存 getter の注意
     *  点"). */
    dashboardTasks(params) {
      const limit = Math.min(Math.max(Number(params.get("limit")) || DASHBOARD_HISTORY_DEFAULT_LIMIT, 1), DASHBOARD_HISTORY_MAX_LIMIT);
      const cursor = decodeDashboardCursor(params.get("cursor"));
      const rows = queryDashboardTasks({ cursor, limit });
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return {
        tasks: page.map((r) => ({
          taskId: r.task_id,
          goal: r.goal,
          title: r.title || null,
          iteration: r.iteration,
          protocolState: r.protocol_state,
          waitingFor: r.waiting_for,
          taskStartedAt: r.task_started_at,
          updatedAt: r.updated_at,
          terminalSummary: r.terminal_summary || null,
        })),
        nextCursor: hasMore ? encodeDashboardCursor(page[page.length - 1].updated_at, page[page.length - 1].task_id) : null,
      };
    },

    async dashboardSetGuidance(request) {
      const parsed = await readJsonWithLimit(request, maxRequestBytes());
      if (parsed.tooLarge) return { error: "PAYLOAD_TOO_LARGE" };
      if (parsed.parseError || !parsed.value) return { error: "INVALID_ARGS" };
      if (parsed.value.clear) return localGuidanceClear();
      if (typeof parsed.value.text !== "string") return { error: "INVALID_ARGS" };
      return localGuidanceSet({ text: parsed.value.text });
    },

    async dashboardSetLimits(request) {
      const parsed = await readJsonWithLimit(request, maxFixedRequestBytes);
      if (parsed.tooLarge) return { error: "PAYLOAD_TOO_LARGE" };
      if (parsed.parseError || !parsed.value) return { error: "INVALID_ARGS" };
      const maxBodyBytes = parsed.value.maxBodyBytes === undefined ? null : parsed.value.maxBodyBytes;
      return localMaxBodyBytesSet({ maxBodyBytes });
    },

    async getHubBrowserSettings() {
      if (isHubInstance()) return hubBrowserSettingsGet();
      return fetchHubBrowserSettings();
    },

    async dashboardSetBrowserSettings(request) {
      const parsed = await readJsonWithLimit(request, maxFixedRequestBytes);
      if (parsed.tooLarge) return { error: "PAYLOAD_TOO_LARGE" };
      if (parsed.parseError || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
        return { error: "INVALID_ARGS" };
      }
      const { chatUrlOverride, conversationUrl } = parsed.value;
      if (chatUrlOverride === undefined && conversationUrl === undefined) {
        return { error: "INVALID_ARGS" };
      }

      if (conversationUrl !== undefined && conversationUrl !== null && conversationUrl !== "") {
        const current = localBrowserSettingsGet();
        let targetProject = null;
        if (chatUrlOverride !== undefined) {
          if (chatUrlOverride !== null && chatUrlOverride !== "") {
            targetProject = parseProjectUrl(chatUrlOverride);
            if (!targetProject) return { error: "INVALID_ARGS", message: "invalid project url" };
          }
        } else if (current.chatUrlOverride) {
          targetProject = parseProjectUrl(current.chatUrlOverride);
        }

        if (!targetProject) {
          const hubSettings = await this.getHubBrowserSettings();
          const sharedChatUrl = hubSettings && hubSettings.chatUrl;
          if (sharedChatUrl) {
            targetProject = parseProjectUrl(sharedChatUrl);
          }
        }

        if (!targetProject) {
          return { error: "INVALID_ARGS", message: "cannot set conversation url without an effective project url" };
        }

        const parsedConv = parseConversationUrl(conversationUrl);
        if (!parsedConv) return { error: "INVALID_ARGS", message: "invalid conversation url" };
        if (!areSameProject(targetProject, parsedConv)) {
          return { error: "INVALID_ARGS", message: "conversation does not match effective project url" };
        }
      }

      return localBrowserSettingsSet(parsed.value);
    },

    /** Only `dir='to_local'` messages, same as localAck() itself — matches
     *  §"詳細救済操作" table: ack has no defined meaning for a to_gpt row. */
    async dashboardAck(request) {
      const parsed = await readJsonWithLimit(request, maxFixedRequestBytes);
      if (parsed.tooLarge) return { error: "PAYLOAD_TOO_LARGE" };
      if (parsed.parseError || !parsed.value || typeof parsed.value.messageId !== "string") return { error: "INVALID_ARGS" };
      const dir = messageDirection(parsed.value.messageId);
      if (dir === null) return { error: "NOT_FOUND" };
      if (dir !== "to_local") return { error: "ACK_NOT_ALLOWED", message: "Only to_local messages can be acked." };
      return localAck({ message_id: parsed.value.messageId });
    },

    /** Refuses a single-message discard of an active (non-terminal) task's
     *  to_gpt row — the plan's §"UI 制約" constraint: doing so would leave
     *  `tasks.protocol_state` stuck (activeTask() keeps returning it) with no
     *  way to recover (localEnqueue's idempotency check would keep finding the
     *  discarded, acked row instead of inserting a fresh INIT). Callers must
     *  use discard-task instead, which clears both sides consistently. */
    async dashboardDiscard(request) {
      const parsed = await readJsonWithLimit(request, maxFixedRequestBytes);
      if (parsed.tooLarge) return { error: "PAYLOAD_TOO_LARGE" };
      if (parsed.parseError || !parsed.value || typeof parsed.value.messageId !== "string") return { error: "INVALID_ARGS" };
      return localDiscard({ message_id: parsed.value.messageId });
    },

    async dashboardDiscardTask(request) {
      const parsed = await readJsonWithLimit(request, maxFixedRequestBytes);
      if (parsed.tooLarge) return { error: "PAYLOAD_TOO_LARGE" };
      if (parsed.parseError || !parsed.value || typeof parsed.value.taskId !== "string") return { error: "INVALID_ARGS" };
      const task = getTask(parsed.value.taskId);
      if (!task) return { error: "NOT_FOUND" };
      if (["DONE", "BLOCKED"].includes(task.protocol_state)) return { error: "ALREADY_TERMINAL" };
      return localDiscardTask({ task_id: parsed.value.taskId });
    },

    async dashboardCompleteTask(request) {
      const parsed = await readJsonWithLimit(request, maxFixedRequestBytes);
      if (parsed.tooLarge) return { error: "PAYLOAD_TOO_LARGE" };
      if (parsed.parseError || !parsed.value || typeof parsed.value.taskId !== "string") return { error: "INVALID_ARGS" };
      return localCompleteTask({ task_id: parsed.value.taskId });
    },

    async dashboardContinueTask(request) {
      const parsed = await readJsonWithLimit(request, maxFixedRequestBytes);
      if (parsed.tooLarge) return { error: "PAYLOAD_TOO_LARGE" };
      if (parsed.parseError || !parsed.value || typeof parsed.value.taskId !== "string") return { error: "INVALID_ARGS" };
      return localContinueTask({ task_id: parsed.value.taskId });
    },

    /** The one path that creates a task from the dashboard — always through
     *  localStartTask() (§"新規タスク投入"), never a second ad hoc INSERT.
     *  task_id is generated server-side (crypto.randomUUID(), same as the
     *  CLI) and the INIT body uses the identical "GOAL:\n<goal>" contract.
     *  Task creation is authoritative regardless of what the best-effort
     *  browser nudge below does — see docs/plans/queue-dashboard.md's
     *  "ブラウザ通知は best-effort". */
    async dashboardStartTask(request) {
      const parsed = await readJsonWithLimit(request, maxRequestBytes());
      if (parsed.tooLarge) return { error: "PAYLOAD_TOO_LARGE" };
      if (parsed.parseError || !parsed.value || typeof parsed.value.goal !== "string" || !parsed.value.goal.trim()) {
        return { error: "INVALID_ARGS" };
      }
      const goal = parsed.value.goal;
      const force = !!parsed.value.force;
      const text = `GOAL:\n${goal}`;
      if (byteLength(text) > maxBodyBytes()) {
        return { error: "BODY_TOO_LARGE", message: `goal exceeds ${maxBodyBytes()} bytes (raise it with: gpt-worker limits <bytes>)` };
      }
      const taskId = crypto.randomUUID();
      const started = localStartTask({ task_id: taskId, goal, text, force });
      if (started.error) return started;
      // Best-effort push to the local bridge daemon (see bridge/link.mjs's
      // dashboard_task_created handler): ACKed before browser automation runs,
      // so a slow/failed nudge never looks like a failed task creation here.
      const nudge = await notifyDashboardTaskCreated(taskId);
      return { ...started, nudge: { status: nudge.ok ? "dispatched" : (nudge.error && nudge.error.status) || "unknown" } };
    },

    /** Internal, binding-only entry point analogous to handleHubRelay (the
     *  existing MCP tool relay) but for the browser dashboard's authenticated
     *  operations instead of ChatGPT's read-only tools. Reachable only from
     *  hubDashboardRelay/hubDashboardWorkspaces (this file) via a BRIDGE_DO
     *  binding call — never routed from a public URL (see the top-level
     *  Worker's fetch: no path shape maps to "/hub-dashboard-relay").
     *
     *  Authority propagation: the hub DO has already verified its own
     *  dashboard session, CSRF origin, rate limit, and registry membership
     *  for the target workspace_id *before* this is ever called — this
     *  workspace DO does not (and structurally cannot) re-derive who the
     *  hub-side browser caller was; the binding call itself, exactly like
     *  handleHubRelay, is the authority. The hub's session cookie/token is
     *  never forwarded here — only the already-authorized operation name,
     *  method, query, and body. This preserves "token validation stays
     *  inside the DO" (CLAUDE.md): hub_gpt_token is validated only in the hub
     *  DO, never copied to or re-checked by a workspace DO. */
    async handleHubDashboardRelay(request) {
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
      // A workspace_registry entry (hub DO) can outlive this workspace's own
      // deprovision() — they are two separate admin calls (see CLAUDE.md's
      // "stale registered but deprovisioned target" note) — so refuse rather
      // than silently recreate task/settings state for a workspace that no
      // longer has tokens.
      if (!hasSecrets()) return json({ error: "NOT_PROVISIONED" }, 404, dashboardApiHeaders());
      // Its own bucket, shared by every hub-driven call into this workspace —
      // deliberately never the same bucket as this workspace's own
      // dashboard-public/dashboard-login/dashboard-api/dashboard-api-unauth
      // (owner-driven traffic), so hub management activity can never
      // rate-limit this workspace's own dashboard, or vice versa.
      if (!consumeDashboardRateLimit("hub-dashboard-internal", 240)) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": "60" } });
      }
      const parsed = await readJsonWithLimit(request, maxRequestBytes());
      if (parsed.tooLarge) return json({ error: "PAYLOAD_TOO_LARGE" }, 413, dashboardApiHeaders());
      const envelope = parsed.value || {};
      if (parsed.parseError || typeof envelope.name !== "string" || typeof envelope.method !== "string") {
        return json({ error: "INVALID_ARGS" }, 400, dashboardApiHeaders());
      }
      const innerUrl = new URL("https://gpt-worker.internal/");
      for (const [k, v] of Object.entries(envelope.query || {})) innerUrl.searchParams.set(k, String(v));
      // Preserve the exact parsed JSON value the hub received, including a
      // literal `null` body — do not coalesce a missing/null body to `{}`.
      // dashboardSetLimits/dashboardSetGuidance/etc. treat "body parsed to a
      // falsy value" as INVALID_ARGS; silently upgrading a browser-submitted
      // `null` into `{}` here would let a malformed hub request succeed (and
      // mutate state) in a case the identical direct workspace-dashboard
      // request would reject, breaking the "same dispatcher / identical
      // validation semantics" guarantee dashboardApiDispatch exists for.
      const hasBody = Object.prototype.hasOwnProperty.call(envelope, "body");
      const innerRequest = new Request(innerUrl, {
        method: envelope.method,
        headers: { "content-type": "application/json" },
        body: envelope.method === "GET" || envelope.method === "HEAD" ? undefined : JSON.stringify(hasBody ? envelope.body : null),
      });
      // Same dispatcher handleDashboardApi uses (dashboardApiDispatch) — an
      // unrecognized name/method pair still falls through to its own
      // UNKNOWN_ROUTE, so this internal route can never expose an operation
      // the public per-workspace dashboard doesn't already have.
      return this.dashboardApiDispatch(envelope.name, envelope.method, innerRequest, innerUrl);
    },

    // ======================= /dashboard/hub : shared hub dashboard =======================
    // Owner-control-plane extension of the per-workspace dashboard above:
    // logging in with the shared hub_gpt_token (never a workspace's own
    // gpt_token — same disjoint-secret guarantee checkResourceOwnerToken's own
    // doc comment relies on) opens a session scoped to Path=/dashboard/hub
    // (see dashboardSessionCookie("hub", ...)) on *this* hub DO's own
    // dashboard_sessions table — entirely separate from any workspace DO's
    // table of the same name. Every operation against a specific workspace is
    // relayed through hubDashboardRelay -> handleHubDashboardRelay, never by
    // routing the browser directly to that workspace's DO.
    //
    // Workspace isolation restated for this feature (CLAUDE.md "Workspace
    // isolation between DOs"): this is the owner's own control plane across
    // workspaces they already registered here themselves — not a new way for
    // one workspace to reach another, and not a way for anyone without the
    // hub token to reach any workspace. A hub session cannot authenticate a
    // workspace's own "/dashboard/<id>/api/*" (different DO, different
    // dashboard_sessions table, different cookie Path), a workspace session
    // cannot authenticate the hub API, and the hub can only ever reach a
    // workspace_id present in its own registeredWorkspaces() — never an
    // arbitrary valid-looking 16-hex id.

    async handleHubDashboard(request, subParts) {
      // Same reasoning as handleDashboard: no shared pre-auth bucket across
      // shell/app.js/app.css/login/logout/api — see handleHubDashboardShell etc.
      if (subParts.length === 0) return this.handleHubDashboardShell(request);
      if (subParts.length === 1 && subParts[0] === "app.js") return this.handleHubDashboardAppJs(request);
      if (subParts.length === 1 && subParts[0] === "common-app.js") return serveDashboardAsset(request, { bucket: "hub-dashboard-public", body: COMMON_DASHBOARD_APP_JS, makeHeaders: dashboardJsHeaders });
      if (subParts.length === 1 && subParts[0] === "workspace-panel.js") return serveDashboardAsset(request, { bucket: "hub-dashboard-public", body: WORKSPACE_PANEL_JS, makeHeaders: dashboardJsHeaders });
      if (subParts.length === 1 && subParts[0] === "app.css") return this.handleHubDashboardAppCss(request);
      if (subParts.length === 1 && subParts[0] === "login") return this.handleHubDashboardLogin(request);
      if (subParts.length === 1 && subParts[0] === "logout") return this.handleHubDashboardLogout(request);
      if (subParts[0] === "api") return this.handleHubDashboardApi(request, subParts.slice(1));
      return new Response("not found", { status: 404 });
    },

    async handleHubDashboardShell(request) {
      return serveDashboardShell(request, {
        bucket: "hub-dashboard-public",
        renderLogin: renderHubDashboardLoginHtml,
        renderShell: renderHubDashboardShellHtml,
      });
    },

    async handleHubDashboardAppJs(request) {
      return serveDashboardAsset(request, { bucket: "hub-dashboard-public", body: HUB_DASHBOARD_APP_JS, makeHeaders: dashboardJsHeaders });
    },

    async handleHubDashboardAppCss(request) {
      return serveDashboardAsset(request, { bucket: "hub-dashboard-public", body: DASHBOARD_CSS, makeHeaders: dashboardCssHeaders });
    },

    // The hub DO never holds a gpt_token (only a workspace DO does — see
    // checkResourceOwnerToken's own doc comment), so the shared login mechanism's
    // checkResourceOwnerToken call is equivalent to checking hub_gpt_token
    // alone here; cookie scope is the literal "hub" (Path=/dashboard/hub).
    async handleHubDashboardLogin(request) {
      return loginDashboardSession(request, { bucket: "hub-dashboard-login", cookieScope: "hub" });
    },

    async handleHubDashboardLogout(request) {
      return logoutDashboardSession(request, { bucket: "hub-dashboard-public", cookieScope: "hub" });
    },

    /** Hub authority: its own `hub-dashboard-api-unauth` / `hub-dashboard-api`
     *  buckets, never shared with any workspace's dashboard (see gateDashboardApi). */
    async handleHubDashboardApi(request, subParts) {
      const denied = await gateDashboardApi(request, { unauthBucket: "hub-dashboard-api-unauth", authBucket: "hub-dashboard-api" });
      if (denied) return denied;

      if (subParts.length === 1 && subParts[0] === "workspaces" && request.method === "GET") {
        return json(await this.hubDashboardWorkspaces(), 200, dashboardApiHeaders());
      }
      if (subParts.length === 1 && subParts[0] === "browser-settings") {
        if (request.method === "GET") return json(hubBrowserSettingsGet(), 200, dashboardApiHeaders());
        if (request.method === "POST") return json(await this.dashboardSetHubBrowserSettings(request), 200, dashboardApiHeaders());
      }
      if (subParts.length >= 3 && subParts[0] === "workspaces" && subParts[1]) {
        return this.hubDashboardRelay(subParts[1], subParts.slice(2).join("/"), request);
      }
      return json({ error: "UNKNOWN_ROUTE" }, 404, dashboardApiHeaders());
    },

    async dashboardSetHubBrowserSettings(request) {
      const parsed = await readJsonWithLimit(request, maxFixedRequestBytes);
      if (parsed.tooLarge) return { error: "PAYLOAD_TOO_LARGE" };
      if (parsed.parseError || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
        return { error: "INVALID_ARGS" };
      }
      const { chatUrl } = parsed.value;
      if (chatUrl === undefined) {
        return { error: "INVALID_ARGS" };
      }
      return hubBrowserSettingsSet(parsed.value);
    },

    /** Aggregates every registered workspace's dashboardOverview() for the hub
     *  dashboard's landing list. One workspace's DO being unreachable or
     *  unprovisioned (e.g. a stale registry entry — see
     *  handleHubDashboardRelay's own comment) never fails the whole listing;
     *  it just reports that one entry as unavailable. */
    async hubDashboardWorkspaces() {
      const registered = registeredWorkspaces();
      const workspaces = await Promise.all(
        registered.map(async (w) => {
          try {
            const res = await fetchWorkspaceDashboardRelay(w.workspace_id, { name: "overview", method: "GET" });
            const data = await res.json().catch(() => ({}));
            return {
              workspaceId: w.workspace_id,
              name: w.name,
              registeredAt: w.registered_at,
              overview: res.ok ? data : null,
              error: res.ok ? null : (data && data.error) || `HTTP_${res.status}`,
            };
          } catch (err) {
            return { workspaceId: w.workspace_id, name: w.name, registeredAt: w.registered_at, overview: null, error: String((err && err.message) || err) };
          }
        })
      );
      return { workspaces };
    },

    /** Relays one authenticated hub-dashboard operation to the target
     *  workspace's own DO, over a binding call only (handleHubDashboardRelay)
     *  — never forwarding this hub session's cookie/token itself. `workspaceId`
     *  must both look valid and already be a member of registeredWorkspaces():
     *  an authenticated hub session must never reach an arbitrary 16-hex DO
     *  instance the owner hasn't explicitly registered here, same membership
     *  check handleHubToolCall already applies to the MCP tool relay. */
    async hubDashboardRelay(workspaceId, opName, request) {
      if (!isValidWorkspaceId(workspaceId) || !registeredWorkspaces().some((w) => w.workspace_id === workspaceId)) {
        return json({ error: "UNKNOWN_WORKSPACE" }, 404, dashboardApiHeaders());
      }
      let bodyPayload = null;
      if (request.method !== "GET") {
        // The hub DO doesn't own the target workspace's own max_body_bytes
        // setting (per-workspace DO state) and can't know it without an extra
        // round trip, so this envelope gate uses the same fixed ceiling
        // handleOAuthMcpDispatch's hub-level branch uses for the identical
        // reason (see its own comment) — the real, precise limit is enforced
        // once the call reaches the target DO's own dashboardApiDispatch.
        const parsed = await readJsonWithLimit(request, maxSharedRequestBytes);
        if (parsed.tooLarge) return json({ error: "PAYLOAD_TOO_LARGE" }, 413, dashboardApiHeaders());
        if (parsed.parseError) return json({ error: "INVALID_ARGS" }, 400, dashboardApiHeaders());
        bodyPayload = parsed.value;
      }
      const query = {};
      if (request.method === "GET") {
        for (const [k, v] of new URL(request.url).searchParams.entries()) query[k] = v;
      }
      try {
        const res = await fetchWorkspaceDashboardRelay(workspaceId, { name: opName, method: request.method, query, body: bodyPayload });
        const text = await res.text();
        return new Response(text, { status: res.status, headers: dashboardApiHeaders() });
      } catch (err) {
        return json({ error: "WORKSPACE_UNAVAILABLE", message: String((err && err.message) || err) }, 502, dashboardApiHeaders());
      }
    },
  };
}

export { createBridgeDashboard };
