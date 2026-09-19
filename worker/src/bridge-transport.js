// Local transport domain (the /link WebSocket, the /local CLI postbox
// dispatch, the pending-RPC table, and rate limiting), extracted verbatim
// from BridgeDO (see worker/src/index.js). Behavior, HTTP status codes,
// response shapes, and WebSocket/RPC semantics are unchanged from the
// pre-extraction implementation — this module only relocates the code. See
// docs/plans/pending/worker-cli-dashboard-modularization-phase0-map.md §13
// for the domain dependency/capability matrix this extraction follows.
//
// Dependency direction: this module imports only pure helpers from
// worker-http.js. It never imports index.js or any sibling bridge-*.js
// domain module (admin/protocol/oauth/dashboard/mcp), and never touches
// `env`/`sql` itself — it reads/writes no `secrets`/`settings`/`tasks`/`msgs`
// table directly. The genuine cross-domain needs are received as narrow
// capability callbacks from createBridgeTransport's caller (BridgeDO's
// constructor) instead:
//  - ctx: the Durable Object's own platform context, taken only for the
//    WebSocket lifecycle it owns here (getWebSockets/acceptWebSocket).
//    Called at use time, never destructured, so a test that swaps a
//    ctx method after construction is still observed.
//  - checkLinkToken(token) / checkCliToken(token): () => boolean — compare
//    a presented /link or /local token against this instance's own stored
//    secret (index.js's checkToken, itself a thin delegate onto
//    bridge-admin.js).
//  - maxRequestBytes(): () => number — this workspace's request-envelope
//    cap (bridge-admin.js), used to size-check a /local body.
//  - localOperations: { <opName>: (body) => result | Promise<result> } — one
//    named callback per /local op, each a thin route onto the protocol
//    (bridge-protocol.js) or admin/settings (bridge-admin.js) operation of
//    the same name. The op names, their dispatch order, and the
//    UNKNOWN_OP fallthrough live here; what each op does stays in its own
//    domain. See LOCAL_OP_NAMES below for the exact set this module
//    expects.
//  - pendingMessageCounts(): () => { pendingToGpt, pendingToLocal } — the
//    protocol domain's un-acked queue counts (bridge-protocol.js), combined
//    with this module's own connection state to answer "status".
//
// Runtime seam: webSocketMessage/webSocketClose/webSocketError are called
// by the Cloudflare Durable Object runtime directly on BridgeDO (WebSocket
// Hibernation API), so BridgeDO keeps same-named methods that only delegate
// here — this module owns the state they act on (`pending`, `rateBuckets`).

import { json, readJsonWithLimit } from "./worker-http.js";

const RPC_TIMEOUT_MS = 20_000; // local WS round-trip budget

// The exact set of /local ops handleLocalRoute dispatches. Documented here
// (rather than derived from whatever object a caller passes) so a missing
// wiring in BridgeDO's constructor fails loudly at construction time.
const LOCAL_OP_NAMES = [
  "enqueue",
  "start_task",
  "report_task",
  "active_task",
  "migrate_legacy_state",
  "settings_get",
  "settings_set",
  "browser_settings_get",
  "browser_settings_set",
  "max_body_bytes_get",
  "max_body_bytes_set",
  "guidance_set",
  "guidance_get",
  "guidance_clear",
  "poll",
  "ack",
  "list",
  "discard_task",
  "discard",
  "complete_task",
  "continue_task",
];

/**
 * Builds the transport domain's operations. `status` is not in
 * LOCAL_OP_NAMES because it is answered by this module itself (from its own
 * connection state plus pendingMessageCounts()).
 *
 * Methods call each other through `this` (e.g. handleLocalRoute calling
 * this.localStatus), which works because every call site invokes them as
 * `this.transport.<method>(...)` from BridgeDO — a plain dot-call binds
 * `this` to the returned object itself, no class/prototype needed.
 */
function createBridgeTransport({ ctx, checkLinkToken, checkCliToken, maxRequestBytes, localOperations, pendingMessageCounts }) {
  for (const op of LOCAL_OP_NAMES) {
    if (typeof localOperations[op] !== "function") throw new Error(`bridge-transport: missing local operation "${op}"`);
  }
  const pending = new Map(); // rid -> { resolve, timer }
  const rateBuckets = new Map(); // key -> number[] (best-effort; resets on hibernation restart)

  return {
    // ---- rate limiting (sliding window, best-effort across hibernation) ----

    rateLimit(key, maxPerMinute) {
      const now = Date.now();
      const windowStart = now - 60_000;
      const arr = (rateBuckets.get(key) || []).filter((t) => t > windowStart);
      if (arr.length >= maxPerMinute) {
        rateBuckets.set(key, arr);
        return false;
      }
      arr.push(now);
      rateBuckets.set(key, arr);
      return true;
    },

    // ======================= /link : local bridge WebSocket =======================

    async handleLink(request, token) {
      if (!checkLinkToken(token)) return new Response("not found", { status: 404 });
      if (request.headers.get("upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      if (!this.rateLimit("link", 10)) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": "60" } });
      }

      // Single-connection constraint: the newest connection wins. Closing the old
      // one lets a local bridge restart (crash, reboot, network blip) reconnect
      // without any manual cleanup.
      for (const ws of ctx.getWebSockets("local")) {
        try {
          ws.close(1008, "superseded by new connection");
        } catch {
          /* already closing */
        }
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      ctx.acceptWebSocket(server, ["local"]);
      server.serializeAttachment({ connected_at: Date.now() });

      return new Response(null, { status: 101, webSocket: client });
    },

    webSocketMessage(_ws, message) {
      let msg;
      try {
        msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
      } catch {
        return;
      }
      const entry = pending.get(msg.rid);
      if (!entry) return; // stale or unsolicited; ignore
      clearTimeout(entry.timer);
      pending.delete(msg.rid);
      entry.resolve(msg);
    },

    webSocketClose() {
      this.failAllPending();
    },

    webSocketError() {
      this.failAllPending();
    },

    failAllPending() {
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, error: { status: "local_disconnected" } });
      }
      pending.clear();
    },

    /** Send a request to the local bridge over the WS link and await its reply.
     *  Uses our own `rid`, never the MCP request `id` (which ChatGPT may reuse
     *  across concurrent tool calls). */
    async callLocal(method, params) {
      const sockets = ctx.getWebSockets("local");
      if (sockets.length === 0) return { ok: false, error: { status: "local_offline" } };
      const rid = crypto.randomUUID();
      const ws = sockets[0];
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(rid);
          resolve({ ok: false, error: { status: "timeout" } });
        }, RPC_TIMEOUT_MS);
        pending.set(rid, { resolve, timer });
        try {
          ws.send(JSON.stringify({ rid, method, params }));
        } catch {
          clearTimeout(timer);
          pending.delete(rid);
          resolve({ ok: false, error: { status: "local_offline" } });
        }
      });
    },

    // ======================= /local : CLI-facing HTTP =======================

    async handleLocalRoute(request, token) {
      if (!checkCliToken(token)) return new Response("not found", { status: 404 });
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
      if (!this.rateLimit("local", 120)) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": "60" } });
      }
      const parsed = await readJsonWithLimit(request, maxRequestBytes());
      if (parsed.tooLarge) return new Response("payload too large", { status: 413 });
      if (parsed.parseError) return json({ error: "PARSE_ERROR" }, 400);
      const body = parsed.value;
      const op = body && body.op;
      if (op === "status") return json(this.localStatus());
      if (LOCAL_OP_NAMES.includes(op)) return json(await localOperations[op](body));
      return json({ error: "UNKNOWN_OP" }, 400);
    },

    localStatus() {
      const connected = ctx.getWebSockets("local").length > 0;
      const { pendingToGpt, pendingToLocal } = pendingMessageCounts();
      return { connected, pendingToGpt, pendingToLocal };
    },
  };
}

export { createBridgeTransport };
