// Secrets/provisioning, hub registry, and per-workspace settings/guidance
// domain, extracted verbatim from BridgeDO (see worker/src/index.js).
// Behavior, response shapes, error codes, and state-transition semantics are
// unchanged from the pre-extraction implementation — this module only
// relocates the code. See
// docs/plans/pending/worker-cli-dashboard-modularization-phase0-map.md §13
// for the domain dependency/capability matrix this extraction follows.
//
// Dependency direction: this module imports only pure helpers from
// worker-http.js. It never imports index.js or any sibling bridge-*.js
// domain module (protocol/oauth/dashboard/mcp/transport) — the genuine
// cross-domain needs (token generation, wiping protocol/OAuth/dashboard
// state on deprovision, and revoking OAuth/dashboard state on a gpt_token or
// hub_gpt_token rotation) are received as narrow capability callbacks from
// createBridgeAdmin's caller (BridgeDO's constructor) instead. OAuth state
// moved to bridge-oauth.js in Phase 2C and dashboard state to
// bridge-dashboard.js in Phase 2E. Either way this
// module never touches their tables directly, only through the injected
// callbacks (revokeOAuthTokens/clearOAuthState below are BridgeDO's own
// same-named methods, themselves thin delegates onto this.oauth — see that
// module's header for why the indirection through BridgeDO stays).

import { constantTimeEqual, isValidWorkspaceId, byteLength, readJsonWithLimit, json } from "./worker-http.js";

// `body`'s default cap. It exists so every message stays a summary — file
// contents, diffs, and command output are never put in it (GPT re-reads the
// workspace itself instead) — not because of any Cloudflare/SQLite ceiling;
// a SQLite-backed DO row can hold up to 2 MiB. A workspace can raise its own
// cap (`gpt-worker limits <bytes>`, stored in `settings.max_body_bytes`) up
// to MAX_BODY_BYTES_CEILING for cases that outgrow it, like a HANDOFF_BRIEF —
// see maxBodyBytes() below. Every ChatGPT round the shared connector's
// conversation carries still grows by roughly this many tokens, so raising it
// trades a longer per-round body for reaching that conversation's context
// ceiling sooner; it is a deliberate per-workspace choice, not a free lunch.
const MAX_BODY_BYTES = 16 * 1024;
const MIN_BODY_BYTES = 4 * 1024; // floor for a configured override — small enough is useless, not unsafe
const MAX_BODY_BYTES_CEILING = 256 * 1024; // well under SQLite's 2 MiB row ceiling, with margin to spare
// Covers the JSON-RPC/CLI fields that wrap `body` (task_id, iteration, kind,
// jsonrpc envelope, ...) — small and fixed regardless of the configured body
// cap, so the request-size ceiling can simply track the body ceiling plus
// this constant rather than needing its own separate override. index.js's
// own MAX_REQUEST_BYTES_CEILING is computed from these two exported values —
// see that file's comment for why it stays defined there.
const REQUEST_ENVELOPE_OVERHEAD_BYTES = 2 * 1024;

const GIZMO_SEGMENT_PATTERN = /^g-p-([0-9a-f]{32})(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/i;

function stableGizmoId(segment) {
  const match = GIZMO_SEGMENT_PATTERN.exec(String(segment ?? ""));
  return match ? match[1].toLowerCase() : null;
}

function parseProjectUrl(rawUrl) {
  if (typeof rawUrl !== "string") return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol !== "https:") return null;
    if (parsed.hostname !== "chatgpt.com") return null;
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const match = pathname.match(/^\/g\/([^/]+)\/project$/);
    if (!match || !match[1]) return null;
    return {
      origin: parsed.origin,
      projectSegment: match[1],
      gizmoId: stableGizmoId(match[1]),
      canonicalUrl: `${parsed.origin}/g/${match[1]}/project${parsed.search}`,
    };
  } catch {
    return null;
  }
}

function parseConversationUrl(rawUrl) {
  if (typeof rawUrl !== "string") return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol !== "https:") return null;
    if (parsed.hostname !== "chatgpt.com") return null;
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const match = pathname.match(/^\/g\/([^/]+)\/c\/([^/]+)$/);
    if (!match || !match[1] || !match[2]) return null;
    return {
      origin: parsed.origin,
      projectSegment: match[1],
      gizmoId: stableGizmoId(match[1]),
      conversationId: match[2],
      canonicalUrl: `${parsed.origin}/g/${match[1]}/c/${match[2]}`,
    };
  } catch {
    return null;
  }
}

function areSameProject(projectInfo, conversationInfo) {
  if (!projectInfo || !conversationInfo) return false;
  if (projectInfo.origin !== conversationInfo.origin) return false;
  if (projectInfo.gizmoId && conversationInfo.gizmoId) {
    return projectInfo.gizmoId === conversationInfo.gizmoId;
  }
  return projectInfo.projectSegment === conversationInfo.projectSegment;
}

/**
 * Builds the admin/settings/registry domain's operations against a Durable
 * Object's own SQLite (`sql`) plus a small set of narrow capabilities:
 *  - generateToken(): () => string — produces one fresh random token (the
 *    same `randomHex(32)` used elsewhere in index.js for OAuth codes/tokens,
 *    injected rather than duplicated so this module doesn't need its own
 *    copy of that helper).
 *  - maxAdminRequestBytes: number — the fixed envelope-size cap used only to
 *    parse an incoming /admin request body (index.js's own MAX_REQUEST_BYTES,
 *    unrelated to the per-workspace maxBodyBytes()/maxRequestBytes() below).
 *  - clearProtocolState(): () => void — wipes the protocol/queue domain's
 *    `msgs`/`tasks` rows (bridge-protocol.js's clearProtocolState), used by
 *    deprovision() only. Protocol state is owned by bridge-protocol.js, not
 *    this module, so it is never touched with a direct `sql.exec` here.
 *  - clearMcpAccessState(): () => void — wipes the MCP access history
 *    (bridge-mcp-access.js's clearAll), used by deprovision() only: token
 *    rotation keeps the history, since it says nothing about who holds a
 *    credential. Like protocol state, it is owned by its own domain module and
 *    never touched with a direct `sql.exec` here.
 *  - revokeOAuthTokens(): () => void — revokes every OAuth authorization
 *    code/access/refresh token this DO has issued (BridgeDO's
 *    revokeAllOAuthTokens, a thin delegate onto bridge-oauth.js's own
 *    revokeAllOAuthTokens), used on gpt_token/hub_gpt_token rotation.
 *  - clearOAuthState(): () => void — wipes all OAuth server state including
 *    the DCR client registry (BridgeDO's clearOAuthState, a thin delegate
 *    onto bridge-oauth.js's own clearOAuthState), used by deprovision()
 *    only — rotation must not lose registered clients, so it uses
 *    revokeOAuthTokens() instead.
 *  - revokeDashboardSessions(): () => void — wipes every dashboard session
 *    (BridgeDO's revokeAllDashboardSessions, a thin delegate onto
 *    bridge-dashboard.js's own), used on rotation and deprovision.
 *    Dashboard session state is owned by the dashboard domain, not this
 *    module.
 *
 * Methods call each other through `this` (e.g. handleAdmin calling
 * this.provision), which works because every call site invokes them as
 * `this.admin.<method>(...)` from BridgeDO — a plain dot-call binds `this`
 * to the returned object itself, no class/prototype needed. The pure
 * browser-URL helpers (parseProjectUrl/parseConversationUrl/areSameProject)
 * are exposed on the returned object too, so BridgeDO can hand them to the
 * dashboard domain (bridge-dashboard.js) as narrow injected capabilities,
 * instead of that module importing this one directly.
 */
function createBridgeAdmin({ sql, generateToken, maxAdminRequestBytes, clearProtocolState, clearMcpAccessState = () => {}, revokeOAuthTokens, clearOAuthState, revokeDashboardSessions }) {
  return {
    parseProjectUrl,
    parseConversationUrl,
    areSameProject,

    // ======================= secrets (per-workspace tokens) =======================

    getSecret(key) {
      const rows = sql.exec(`SELECT v FROM secrets WHERE k = ?`, key).toArray();
      return rows.length ? rows[0].v : null;
    },

    setSecret(key, value) {
      sql.exec(`INSERT OR REPLACE INTO secrets (k, v) VALUES (?, ?)`, key, value);
    },

    hasSecrets() {
      return sql.exec(`SELECT COUNT(*) AS n FROM secrets`).toArray()[0].n > 0;
    },

    checkToken(secretKey, token) {
      const stored = this.getSecret(secretKey);
      return !!stored && constantTimeEqual(token, stored);
    },

    // ======================= /admin : provisioning (this workspace's own DO) =======================

    async handleAdmin(request) {
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
      const parsed = await readJsonWithLimit(request, maxAdminRequestBytes);
      if (parsed.tooLarge) return new Response("payload too large", { status: 413 });
      if (parsed.parseError) return json({ error: "PARSE_ERROR" }, 400);
      const body = parsed.value || {};
      if (body.op === "provision_hub") return json(this.provisionHub());
      if (body.op === "hub_browser_settings_get") return json(this.hubBrowserSettingsGet());
      if (body.op === "hub_browser_settings_set") return json(this.hubBrowserSettingsSet(body));
      if (body.op === "hub_owner_token_get") return json(this.hubOwnerTokenGet());
      if (body.op === "owner_token_get") return json(this.ownerTokenGet());
      if (body.op === "register_workspace") return json(this.registerWorkspace(body));
      if (body.op === "unregister_workspace") return json(this.unregisterWorkspace(body));
      if (body.op === "rotate_hub") return json(this.rotateHubToken());
      if (body.op === "provision") return json(this.provision());
      if (body.op === "migrate_default") return json(this.migrateDefault(body));
      if (body.op === "rotate") return json(this.rotateSecret(body.key));
      if (body.op === "deprovision") return json(this.deprovision());
      return json({ error: "UNKNOWN_OP" }, 400);
    },

    hubBrowserSettingsGet() {
      if (!this.getSecret("hub_gpt_token")) return { error: "NOT_PROVISIONED" };
      const rows = sql
        .exec(
          `SELECT k, v FROM settings WHERE k IN ('browser_chat_url_default', 'browser_chat_url_default_initialized')`
        )
        .toArray();
      const values = Object.fromEntries(rows.map((r) => [r.k, r.v]));
      return {
        initialized: values.browser_chat_url_default_initialized === "1",
        chatUrl: values.browser_chat_url_default ? values.browser_chat_url_default : null,
      };
    },

    hubBrowserSettingsSet(body) {
      if (!this.getSecret("hub_gpt_token")) return { error: "NOT_PROVISIONED" };
      const { chatUrl } = body || {};
      if (chatUrl !== undefined) {
        if (chatUrl === null || chatUrl === "") {
          this.setSetting("browser_chat_url_default", "");
        } else {
          const parsed = parseProjectUrl(chatUrl);
          if (!parsed) {
            return { error: "INVALID_ARGS", message: "invalid project url" };
          }
          this.setSetting("browser_chat_url_default", parsed.canonicalUrl);
        }
      }
      this.setSetting("browser_chat_url_default_initialized", "1");
      return this.hubBrowserSettingsGet();
    },

    hubOwnerTokenGet() {
      const token = this.getSecret("hub_gpt_token");
      if (!token) return { error: "NOT_PROVISIONED" };
      return { gptToken: token };
    },

    ownerTokenGet() {
      if (!this.hasSecrets()) return { error: "NOT_PROVISIONED" };
      const token = this.getSecret("gpt_token");
      return { gptToken: token };
    },

    /** Irreversibly wipes this workspace's tokens, queue, task state and settings — its Server URL
     *  and CLI/link tokens 404 immediately afterward, same as if it had never
     *  been provisioned. Used by `gpt-worker remove`. There is no "undo": a
     *  workspace_id can be re-provisioned later, but that starts a fresh
     *  queue with fresh tokens, not a restore of what was here. */
    deprovision() {
      sql.exec(`DELETE FROM secrets`);
      clearProtocolState();
      clearMcpAccessState();
      sql.exec(`DELETE FROM settings`);
      clearOAuthState();
      revokeDashboardSessions();
      return { ok: true };
    },

    /** Replaces one of this workspace's 3 tokens with a fresh random value.
     *  Only the named key changes; the other two (and every queued message)
     *  are untouched. Requires the workspace to already be provisioned. */
    rotateSecret(key) {
      if (!["gpt_token", "link_token", "cli_token"].includes(key)) {
        return { error: "INVALID_ARGS", message: "key must be gpt_token, link_token, or cli_token" };
      }
      if (!this.hasSecrets()) return { error: "NOT_PROVISIONED" };
      const value = generateToken();
      this.setSecret(key, value);
      if (key === "gpt_token") {
        revokeOAuthTokens();
        // gpt_token doubles as the dashboard login credential (see
        // checkResourceOwnerToken) — a deliberate rotation must also revoke
        // sessions already issued under the old value, same reasoning as the
        // OAuth grants above (docs/plans/queue-dashboard.md's "owner token
        // rotation" row).
        revokeDashboardSessions();
      }
      return { value };
    },

    /** Fresh workspace: generates all 3 tokens. Refuses if this workspace_id
     *  was already provisioned, so a routing collision (or a retried admin
     *  call) can never silently overwrite an existing workspace's tokens. */
    provision() {
      if (this.hasSecrets()) return { error: "ALREADY_PROVISIONED" };
      const gptToken = generateToken();
      const linkToken = generateToken();
      const cliToken = generateToken();
      this.setSecret("gpt_token", gptToken);
      this.setSecret("link_token", linkToken);
      this.setSecret("cli_token", cliToken);
      this.setSetting("browser_settings_initialized", "1");
      return { gptToken, linkToken, cliToken };
    },

    /** Creates the one token embedded in the single ChatGPT connector URL. */
    provisionHub() {
      const existing = this.getSecret("hub_gpt_token");
      if (existing) return { gptToken: existing, alreadyProvisioned: true };
      const gptToken = generateToken();
      this.setSecret("hub_gpt_token", gptToken);
      return { gptToken };
    },

    rotateHubToken() {
      if (!this.getSecret("hub_gpt_token")) return { error: "NOT_PROVISIONED" };
      const value = generateToken();
      this.setSecret("hub_gpt_token", value);
      revokeOAuthTokens();
      // hub_gpt_token doubles as the shared hub dashboard's login credential
      // (see checkResourceOwnerToken and handleHubDashboardLogin) — same
      // reasoning as rotateSecret("gpt_token") revoking that workspace's own
      // dashboard sessions: a deliberate rotation must also cut off hub
      // dashboard sessions already issued under the old value.
      revokeDashboardSessions();
      return { value };
    },

    registerWorkspace({ workspace_id: workspaceId, name } = {}) {
      if (!isValidWorkspaceId(workspaceId) || typeof name !== "string" || !name.trim()) {
        return { error: "INVALID_ARGS" };
      }
      sql.exec(
        `INSERT OR REPLACE INTO workspace_registry (workspace_id, name, registered_at) VALUES (?, ?, ?)`,
        workspaceId,
        name.slice(0, 200),
        Date.now()
      );
      return { ok: true };
    },

    unregisterWorkspace({ workspace_id: workspaceId } = {}) {
      if (!isValidWorkspaceId(workspaceId)) return { error: "INVALID_ARGS" };
      sql.exec(`DELETE FROM workspace_registry WHERE workspace_id = ?`, workspaceId);
      return { ok: true };
    },

    registeredWorkspaces() {
      return sql.exec(`SELECT workspace_id, name, registered_at FROM workspace_registry ORDER BY name COLLATE NOCASE`).toArray();
    },

    /** Adopts the exact token values from the pre-multi-tenant single-DO
     *  deployment (workspace_id "default") — never generates new ones, so
     *  the already-registered ChatGPT connector's tokens keep working once
     *  its Server URL gains the /default/ segment. */
    migrateDefault({ gptToken, linkToken, cliToken } = {}) {
      if (this.hasSecrets()) return { error: "ALREADY_PROVISIONED" };
      if (typeof gptToken !== "string" || typeof linkToken !== "string" || typeof cliToken !== "string") {
        return { error: "INVALID_ARGS" };
      }
      this.setSecret("gpt_token", gptToken);
      this.setSecret("link_token", linkToken);
      this.setSecret("cli_token", cliToken);
      return { ok: true };
    },

    // ======================= settings / guidance =======================

    workspaceGuidance() {
      const rows = sql.exec(`SELECT v FROM settings WHERE k = 'guidance'`).toArray();
      const guidance = rows.length ? rows[0].v : "";
      return guidance ? { set: true, guidance } : { set: false };
    },

    localSettingsGet() {
      const rows = sql.exec(`SELECT k, v FROM settings WHERE k IN ('chat_url', 'enter_delay_ms')`).toArray();
      const values = Object.fromEntries(rows.map((r) => [r.k, r.v]));
      return {
        chatUrl: values.chat_url || null,
        enterDelayMs: values.enter_delay_ms ? Number(values.enter_delay_ms) : null,
      };
    },

    localSettingsSet(body) {
      const { chatUrl, enterDelayMs } = body || {};
      if (chatUrl !== undefined) this.setSetting("chat_url", chatUrl || "");
      if (enterDelayMs !== undefined) this.setSetting("enter_delay_ms", enterDelayMs === null ? "" : String(enterDelayMs));
      return this.localSettingsGet();
    },

    localBrowserSettingsGet() {
      if (!this.hasSecrets()) return { error: "NOT_PROVISIONED" };
      const rows = sql
        .exec(
          `SELECT k, v FROM settings WHERE k IN ('browser_chat_url_override', 'browser_conversation_url', 'browser_settings_initialized')`
        )
        .toArray();
      const values = Object.fromEntries(rows.map((r) => [r.k, r.v]));
      return {
        initialized: values.browser_settings_initialized === "1",
        chatUrlOverride: values.browser_chat_url_override ? values.browser_chat_url_override : null,
        conversationUrl: values.browser_conversation_url ? values.browser_conversation_url : null,
      };
    },

    localBrowserSettingsSet(body) {
      if (!this.hasSecrets()) return { error: "NOT_PROVISIONED" };
      const current = this.localBrowserSettingsGet();
      const { chatUrlOverride, conversationUrl } = body || {};

      let nextOverride = current.chatUrlOverride;
      let overrideChanged = false;

      if (chatUrlOverride !== undefined) {
        if (chatUrlOverride === null || chatUrlOverride === "") {
          if (current.chatUrlOverride !== null) {
            nextOverride = null;
            overrideChanged = true;
          }
        } else {
          const parsed = parseProjectUrl(chatUrlOverride);
          if (!parsed) return { error: "INVALID_ARGS", message: "invalid project url" };
          if (current.chatUrlOverride !== parsed.canonicalUrl) {
            nextOverride = parsed.canonicalUrl;
            overrideChanged = true;
          }
        }
      }

      let nextConversation = current.conversationUrl;
      if (conversationUrl !== undefined) {
        if (conversationUrl === null || conversationUrl === "") {
          nextConversation = null;
        } else {
          const parsedConv = parseConversationUrl(conversationUrl);
          if (!parsedConv) return { error: "INVALID_ARGS", message: "invalid conversation url" };
          if (nextOverride) {
            const parsedProject = parseProjectUrl(nextOverride);
            if (!areSameProject(parsedProject, parsedConv)) {
              return { error: "INVALID_ARGS", message: "conversation does not match project override" };
            }
          }
          nextConversation = parsedConv.canonicalUrl;
        }
      } else if (overrideChanged) {
        nextConversation = null;
      }

      this.setSetting("browser_chat_url_override", nextOverride || "");
      this.setSetting("browser_conversation_url", nextConversation || "");
      this.setSetting("browser_settings_initialized", "1");
      return this.localBrowserSettingsGet();
    },

    localGuidanceSet(body) {
      if (!body || typeof body.text !== "string") return { error: "INVALID_ARGS" };
      if (byteLength(body.text) > 8 * 1024) return { error: "BODY_TOO_LARGE" };
      this.setSetting("guidance", body.text);
      return { ok: true };
    },

    localGuidanceClear() {
      this.setSetting("guidance", "");
      return { ok: true };
    },

    setSetting(key, value) {
      sql.exec(`INSERT OR REPLACE INTO settings (k, v) VALUES (?, ?)`, key, value);
    },

    /** This workspace's configured `body` size cap, or MAX_BODY_BYTES if unset
     *  or the stored value is no longer a valid integer in range (covers a
     *  never-configured workspace and a stale value from a lowered ceiling). */
    maxBodyBytes() {
      const rows = sql.exec(`SELECT v FROM settings WHERE k = 'max_body_bytes'`).toArray();
      const raw = rows.length ? rows[0].v : "";
      const n = raw ? Number(raw) : NaN;
      return Number.isInteger(n) && n >= MIN_BODY_BYTES && n <= MAX_BODY_BYTES_CEILING ? n : MAX_BODY_BYTES;
    },

    /** The envelope around `maxBodyBytes()` — used wherever a request carrying
     *  a message body is size-checked before that body is parsed out and
     *  checked on its own. */
    maxRequestBytes() {
      return this.maxBodyBytes() + REQUEST_ENVELOPE_OVERHEAD_BYTES;
    },

    localMaxBodyBytesGet() {
      return { maxBodyBytes: this.maxBodyBytes(), default: MAX_BODY_BYTES, floor: MIN_BODY_BYTES, ceiling: MAX_BODY_BYTES_CEILING };
    },

    localMaxBodyBytesSet(body) {
      const { maxBodyBytes } = body || {};
      if (maxBodyBytes === null || maxBodyBytes === undefined) {
        this.setSetting("max_body_bytes", "");
        return this.localMaxBodyBytesGet();
      }
      const n = Number(maxBodyBytes);
      if (!Number.isInteger(n) || n < MIN_BODY_BYTES || n > MAX_BODY_BYTES_CEILING) {
        return { error: "INVALID_ARGS", message: `maxBodyBytes must be an integer between ${MIN_BODY_BYTES} and ${MAX_BODY_BYTES_CEILING}` };
      }
      this.setSetting("max_body_bytes", String(n));
      return this.localMaxBodyBytesGet();
    },
  };
}

export { createBridgeAdmin, MAX_BODY_BYTES, MIN_BODY_BYTES, MAX_BODY_BYTES_CEILING, REQUEST_ENVELOPE_OVERHEAD_BYTES };
