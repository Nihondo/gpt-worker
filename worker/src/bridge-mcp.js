// MCP dispatch + tool invocation domain, extracted verbatim from BridgeDO
// (see worker/src/index.js). Behavior, JSON-RPC/tool response shapes, error
// codes, and connector-variant (dedicated vs. shared) semantics are
// unchanged from the pre-extraction implementation — this module only
// relocates the code. See
// docs/plans/pending/worker-cli-dashboard-modularization-phase0-map.md §13
// for the domain dependency/capability matrix this extraction follows.
//
// Dependency direction: this module imports only pure helpers
// (worker-http.js, the static tools.json/instructions.js Worker-owned
// protocol text). It never imports index.js or any sibling bridge-*.js
// domain module (admin/protocol/oauth/dashboard/transport), and never
// touches `env`/`BRIDGE_DO`/`ctx`/`sql` itself — the genuine cross-domain
// needs are received as narrow, purpose-fixed capability callbacks from
// createBridgeMcp's caller (BridgeDO's constructor) instead:
//  - queueNext(taskId) / queueSubmit(args) / queueSetTitle(args) /
//    taskHistory(args) / activeTask(): protocol/queue domain operations
//    (bridge-protocol.js), reached only through the tools/call dispatch in
//    invokeTool() and isActiveTaskWindow().
//  - workspaceGuidance() / registeredWorkspaces() / maxWorkspaceRequestBytes():
//    admin/settings/registry domain reads (bridge-admin.js). registeredWorkspaces()
//    is also used by the dashboard, which is why it stays a BridgeDO
//    delegate rather than moving here.
//  - relayWorkspaceTool(name, params): transport's callLocal — the one
//    call-through to the local bridge over the WebSocket link, used for the
//    workspace-inspection tools (list_directory, read_file, ...). Not a
//    generic transport handle.
//  - allowOAuthMcpRequest(useHubHandler): the "oauth-mcp"/"oauth-hub-mcp"
//    60/min rate-limit bucket (transport's generic rateLimit, shared with
//    other routes, so only this purpose-fixed check is handed over).
//  - relayHubToolToWorkspace(workspaceId, name, args): the cross-DO binding
//    call the hub makes to a workspace DO's own binding-only /hub route.
//    Resolves to that route's parsed JSON body. This is the only place the
//    MCP hub path touches env.BRIDGE_DO — inside index.js, never here. It
//    forwards only the tool name/arguments, never a hub credential/session.
//  - maxSharedRequestBytes: number — index.js's MAX_REQUEST_BYTES_CEILING,
//    the fixed envelope cap for the hub-level parse that runs before the
//    target workspace's own limit is known (see handleOAuthMcpDispatch).
//
// TOOLS/HUB_TOOLS/PROTOCOL_VERSIONS and the toolOk/toolError/rpcError
// formatters are owned by this module (MCP-only concerns); toolOk/toolError
// are also exported so index.js — the composition root — can hand them to
// bridge-protocol.js as capabilities, keeping protocol from importing this
// module directly.

import TOOLS from "./tools.json" with { type: "json" };
import { operatingInstructions } from "./instructions.js";
import { isValidWorkspaceId, json, readJsonWithLimit } from "./worker-http.js";

// Tools answered locally by the hub (no workspace_id involved) instead of
// being relayed to a workspace's Durable Object. Excluded from the
// workspace_id injection below for that reason.
const HUB_LOCAL_TOOLS = new Set(["operating_instructions"]);

const HUB_TOOLS = [
  {
    name: "list_workspaces",
    title: "List workspaces",
    description: "List every workspace registered with this shared gpt-worker connector. Choose one workspace_id, then pass it to every other gpt-worker tool call.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  ...TOOLS.tools.map((tool) =>
    HUB_LOCAL_TOOLS.has(tool.name)
      ? { ...tool }
      : {
          ...tool,
          description: `${tool.description} In the shared connector, pass workspace_id from list_workspaces for this call.`,
          inputSchema: {
            ...tool.inputSchema,
            properties: {
              ...tool.inputSchema.properties,
              workspace_id: { type: "string", description: "Workspace ID returned by list_workspaces." },
            },
            required: [...new Set([...(tool.inputSchema.required || []), "workspace_id"])],
          },
        }
  ),
];

const PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26"]);
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const ACTIVE_WINDOW_MS = 60 * 60 * 1000;

function checkProtocolVersion(request) {
  const v = request.headers.get("mcp-protocol-version");
  if (!v) return DEFAULT_PROTOCOL_VERSION;
  return PROTOCOL_VERSIONS.has(v) ? v : null;
}

function rpcError(id, code, message) {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function toolOk(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function toolError(code, message) {
  const data = { error: code, message };
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: true };
}

/**
 * Builds the MCP domain's operations against the narrow capabilities
 * documented in the header above.
 *
 * Methods call each other through `this` (e.g. handleOAuthMcpDispatch
 * calling this.handleMcpRequest), which works because every call site
 * invokes them as `this.mcp.<method>(...)` from BridgeDO — a plain
 * dot-call binds `this` to the returned object itself, no class/prototype
 * needed.
 */
function createBridgeMcp({
  queueNext,
  queueSubmit,
  queueSetTitle,
  taskHistory,
  activeTask,
  workspaceGuidance,
  registeredWorkspaces,
  maxWorkspaceRequestBytes,
  relayWorkspaceTool,
  allowOAuthMcpRequest,
  relayHubToolToWorkspace,
  maxSharedRequestBytes,
}) {
  return {
    /** POST /oauth-mcp or /oauth-hub-mcp (internal). Reached only after
     *  handleOAuthMcpResource has Bearer-authenticated the caller; this parses
     *  the JSON-RPC envelope and dispatches into the resource's handler. */
    async handleOAuthMcpDispatch(request, useHubHandler) {
      if (!allowOAuthMcpRequest(useHubHandler)) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": "60" } });
      }
      const contentType = request.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        return new Response("unsupported media type", { status: 415 });
      }
      if (checkProtocolVersion(request) === null) {
        return new Response("unsupported MCP-Protocol-Version", { status: 400 });
      }

      // The hub-level dispatch (useHubHandler) runs on the shared hub DO, which
      // doesn't own any workspace's `max_body_bytes` setting and can't yet know
      // which workspace this call names — that isn't resolved until
      // handleHubToolCall parses `arguments.workspace_id` below. So this first
      // gate is generously fixed at the global ceiling; the real, per-workspace
      // limit is enforced once the call reaches that workspace's own DO (see
      // handleHubRelay). The dedicated per-workspace dispatch runs on that
      // workspace's own DO already, so it can size-check precisely up front.
      const requestLimit = useHubHandler ? maxSharedRequestBytes : maxWorkspaceRequestBytes();
      const parsed = await readJsonWithLimit(request, requestLimit);
      if (parsed.tooLarge) return new Response("payload too large", { status: 413 });
      if (parsed.parseError) return rpcError(null, -32700, "Parse error");
      const payload = parsed.value;

      if (Array.isArray(payload)) return new Response("JSON-RPC batching is not supported", { status: 400 });
      if (!payload || typeof payload !== "object" || payload.jsonrpc !== "2.0") {
        return rpcError(payload && payload.id, -32600, "Invalid Request");
      }
      if (!("method" in payload) || !("id" in payload)) return new Response(null, { status: 202 });

      return useHubHandler ? this.handleHubMcpRequest(payload) : this.handleMcpRequest(payload);
    },

    async handleHubMcpRequest({ id, method, params }) {
      switch (method) {
        case "ping":
          return json({ jsonrpc: "2.0", id, result: {} });
        case "initialize": {
          const clientVersion = params && params.protocolVersion;
          const version = PROTOCOL_VERSIONS.has(clientVersion) ? clientVersion : "2025-06-18";
          return json({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: version,
              capabilities: { tools: {} },
              serverInfo: { name: "gpt-worker", version: "1.2.0" },
              instructions: operatingInstructions("shared"),
            },
          });
        }
        case "tools/list":
          return json({ jsonrpc: "2.0", id, result: { tools: HUB_TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) } });
        case "tools/call":
          return this.handleHubToolCall(id, params);
        default:
          return rpcError(id, -32601, `Method not found: ${method}`);
      }
    },

    async handleHubToolCall(id, params) {
      if (!params || typeof params.name !== "string") return rpcError(id, -32602, "Invalid params: missing tool name");
      const { name, arguments: args = {} } = params;
      if (name === "list_workspaces") return json({ jsonrpc: "2.0", id, result: toolOk({ workspaces: registeredWorkspaces() }) });
      if (name === "operating_instructions") {
        return json({ jsonrpc: "2.0", id, result: toolOk({ instructions: operatingInstructions("shared") }) });
      }
      if (!HUB_TOOLS.some((tool) => tool.name === name)) {
        return json({ jsonrpc: "2.0", id, result: toolError("UNKNOWN_TOOL", `No such tool: ${name}`) });
      }
      const workspaceId = args && args.workspace_id;
      if (!isValidWorkspaceId(workspaceId) || !registeredWorkspaces().some((w) => w.workspace_id === workspaceId)) {
        return json({ jsonrpc: "2.0", id, result: toolError("UNKNOWN_WORKSPACE", "Call list_workspaces and pass one returned workspace_id.") });
      }
      const forwardedArgs = { ...args };
      delete forwardedArgs.workspace_id;
      try {
        const result = await relayHubToolToWorkspace(workspaceId, name, forwardedArgs);
        return json({ jsonrpc: "2.0", id, result });
      } catch (err) {
        return json({ jsonrpc: "2.0", id, result: toolError("WORKSPACE_UNAVAILABLE", String((err && err.message) || err)) });
      }
    },

    /** Internal, binding-only entry point used by the hub to preserve the
     * existing workspace task queues and read gating. Reachable only from
     * handleHubToolCall (via the hub's relayHubToolToWorkspace), so reaching
     * here always means the shared connector. */
    async handleHubRelay(request) {
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
      // Reached only after handleHubToolCall has already resolved which
      // workspace this call is for and forwarded it to that workspace's own
      // DO — `this` here is that DO, so its configured limit applies.
      const parsed = await readJsonWithLimit(request, maxWorkspaceRequestBytes());
      if (parsed.tooLarge) return json(toolError("PAYLOAD_TOO_LARGE", "request exceeds size limit"), 413);
      const body = parsed.value || {};
      if (parsed.parseError || typeof body.name !== "string") return json(toolError("INVALID_ARGS", "tool name is required"), 400);
      return json(await this.invokeTool(body.name, body.arguments || {}, { connector: "shared" }));
    },

    async handleMcpRequest({ id, method, params }) {
      switch (method) {
        case "ping":
          return json({ jsonrpc: "2.0", id, result: {} });

        case "initialize": {
          const clientVersion = params && params.protocolVersion;
          const version = PROTOCOL_VERSIONS.has(clientVersion) ? clientVersion : "2025-06-18";
          return json({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: version,
              capabilities: { tools: {} },
              serverInfo: { name: "gpt-worker", version: "1.1.0" },
              instructions: operatingInstructions("dedicated"),
            },
          });
        }

        case "tools/list": {
          const tools = TOOLS.tools.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: t.annotations,
          }));
          return json({ jsonrpc: "2.0", id, result: { tools } });
        }

        case "tools/call":
          return this.handleToolCall(id, params);

        default:
          return rpcError(id, -32601, `Method not found: ${method}`);
      }
    },

    async handleToolCall(id, params) {
      if (!params || typeof params.name !== "string") {
        return rpcError(id, -32602, "Invalid params: missing tool name");
      }
      const { name, arguments: args = {} } = params;
      return json({ jsonrpc: "2.0", id, result: await this.invokeTool(name, args) });
    },

    async invokeTool(name, args = {}, { connector = "dedicated" } = {}) {
      const tool = TOOLS.tools.find((t) => t.name === name);
      if (!tool) return toolError("UNKNOWN_TOOL", `No such tool: ${name}`);
      try {
        if (tool.location === "instructions") return toolOk({ instructions: operatingInstructions(connector) });
        if (tool.location === "queue_next") {
          const next = queueNext(args && args.task_id);
          // Worker-owned static protocol text, not queue data (see
          // instructions.js). next_task is the one call guaranteed to happen
          // at the start of a round, so it is the reliable delivery point if
          // the connector drops InitializeResult.instructions.
          return toolOk(next.empty ? next : { operating_instructions: operatingInstructions(connector), ...next });
        }
        if (tool.location === "queue_submit") return queueSubmit(args);
        if (tool.location === "queue_set_title") return queueSetTitle(args);
        if (tool.location === "queue_history") return toolOk(taskHistory(args));
        if (tool.location === "workspace_guidance") return toolOk(workspaceGuidance());
        const relay = await relayWorkspaceTool(name, {
          ...args,
          // The bridge treats this as Worker-authenticated control metadata,
          // never as a value supplied by ChatGPT. It keeps workspace reads
          // gated by the Worker-owned task state without persisting a local
          // copy of the active task ID.
          __gptWorkerActiveTask: this.isActiveTaskWindow(),
        });
        if (!relay.ok) return toolOk(relay.error);
        return toolOk(relay.result);
      } catch (err) {
        return toolError("INTERNAL_ERROR", String((err && err.message) || err));
      }
    },

    isActiveTaskWindow() {
      const task = activeTask();
      return !!task && Date.now() - task.task_started_at < ACTIVE_WINDOW_MS;
    },
  };
}

export { createBridgeMcp, toolOk, toolError };
