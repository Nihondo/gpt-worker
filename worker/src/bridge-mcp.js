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
//    invokeTool() and taskWindowState().
//  - workspaceGuidance() / registeredWorkspaces() / maxWorkspaceRequestBytes():
//    admin/settings/registry domain reads (bridge-admin.js). registeredWorkspaces()
//    is also used by the dashboard (bridge-dashboard.js), which is why it
//    stays a BridgeDO delegate rather than moving here.
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
//  - recordMcpAccess(event): stores one row of MCP access-history *metadata*
//    (the dashboard's "MCP Access" tab). Called best-effort, after a workspace
//    tool call has finished, with an event built by worker-mcp-access.js — so
//    it can only ever carry a tool name, a sanitized target, an outcome kind
//    and a duration, never the call's arguments or result. A failure to record
//    must not change what the caller gets back (see invokeTool).
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
import { operatingInstructions, operatingInstructionsVersion } from "./instructions.js";
import { isValidWorkspaceId, json, readJsonWithLimit } from "./worker-http.js";
import { buildMcpAccessEvent } from "./worker-mcp-access.js";

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
// Idle ceiling for the workspace-read window. Anchored on `tasks.updated_at`
// (the timestamp of the last protocol transition), NOT on
// `tasks.task_started_at`: a multi-round task that is still being worked on
// must not lose its read access mid-task, while a task left untouched still
// closes its window this long after the last real activity, so the time
// bound is preserved. `task_started_at` is display-only (taskView ->
// dashboard's "started <time>") and is deliberately never UPDATEd.
//
// ChatGPT cannot extend this window at will: queueSubmit() requires a
// not-yet-acked to_gpt row for the current iteration and moves the task to
// WAITING_LOCAL, so at most one transition per round comes from the GPT
// side, and the next one needs a cliToken-authenticated local ack.
const TASK_WINDOW_IDLE_MS = 60 * 60 * 1000;

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

/** Maps a *failed* relay (transport's callLocal) to a tool error rather than a
 *  successful result. This used to go through toolOk(), which left ChatGPT
 *  unable to distinguish "the local bridge is down" from "the tool
 *  legitimately returned nothing" — a disconnected bridge read as an empty
 *  answer.
 *
 *  Note what is NOT routed here: {"status":"no_active_task"} and
 *  {"status":"task_window_expired"} come back with relay.ok === true, so they
 *  remain documented *successful* shapes (see reference/protocol.md). Only a
 *  transport-level failure, or an ok:false reply from the bridge itself
 *  (dispatch threw, or reply() failed closed on sanitization), lands here. */
function relayFailureToolError(error) {
  const status = error && error.status;
  if (status === "local_offline") {
    return toolError(
      "LOCAL_OFFLINE",
      "The local bridge is not connected to this workspace. Ask the operator to run: gpt-worker start"
    );
  }
  if (status === "local_disconnected") {
    return toolError(
      "LOCAL_DISCONNECTED",
      "The local bridge disconnected while this call was in flight. Report it and stop; do not retry in a loop. The operator can check the bridge with: gpt-worker status"
    );
  }
  if (status === "timeout") {
    return toolError("LOCAL_TIMEOUT", "The local bridge did not answer within the relay budget.");
  }
  return toolError("LOCAL_TOOL_ERROR", String((error && error.message) || status || "unknown local error"));
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
  recordMcpAccess = () => {},
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
        return json({
          jsonrpc: "2.0",
          id,
          result: toolOk({
            instructions: operatingInstructions("shared"),
            operating_instructions_version: operatingInstructionsVersion("shared"),
          }),
        });
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

    /** Runs a tool call and records it in the MCP access history.
     *
     *  Every MCP tool call — dedicated or shared (the hub forwards a shared call
     *  to the workspace's own DO, which lands here too) — passes through this
     *  method, which makes it the one place a call can be observed with its final
     *  outcome: success, a gate refusal, an access denial, or a bridge failure
     *  all come back as the response this returns. An unknown tool and
     *  `operating_instructions` (protocol text, not workspace access) are not
     *  recorded. */
    async invokeTool(name, args = {}, options = {}) {
      const tool = TOOLS.tools.find((t) => t.name === name);
      if (!tool || tool.location === "instructions") return this.dispatchTool(name, args, options);

      // Snapshot before running: the task that was active when the call began,
      // as the DO itself knows it — never anything the caller supplied — and the
      // start time. (The task can change during the call; the row should say
      // what it was doing when it was asked.)
      const startedAt = Date.now();
      let taskId = null;
      try {
        const task = activeTask();
        taskId = task ? task.task_id : null;
      } catch {
        /* history is best-effort; never let it break a call */
      }

      const result = await this.dispatchTool(name, args, options);

      try {
        recordMcpAccess(
          buildMcpAccessEvent({
            tool: name,
            connector: options && options.connector,
            args,
            result,
            startedAt,
            finishedAt: Date.now(),
            taskId,
          })
        );
      } catch {
        /* A failure to record must not change what the caller gets back. */
      }
      return result;
    },

    async dispatchTool(name, args = {}, { connector = "dedicated" } = {}) {
      const tool = TOOLS.tools.find((t) => t.name === name);
      if (!tool) return toolError("UNKNOWN_TOOL", `No such tool: ${name}`);
      try {
        if (tool.location === "instructions") {
          return toolOk({
            instructions: operatingInstructions(connector),
            operating_instructions_version: operatingInstructionsVersion(connector),
          });
        }
        if (tool.location === "queue_next") {
          const next = queueNext(args && args.task_id);
          if (next.empty) return toolOk(next);
          const version = operatingInstructionsVersion(connector);
          const matches =
            args &&
            typeof args.known_instructions_version === "string" &&
            args.known_instructions_version === version;
          if (matches) {
            return toolOk({ ...next, operating_instructions_version: version });
          }
          return toolOk({
            operating_instructions: operatingInstructions(connector),
            operating_instructions_version: version,
            ...next,
          });
        }
        if (tool.location === "queue_submit") return queueSubmit(args);
        if (tool.location === "queue_set_title") return queueSetTitle(args);
        if (tool.location === "queue_history") return toolOk(taskHistory(args));
        if (tool.location === "workspace_guidance") return toolOk(workspaceGuidance());
        const windowState = this.taskWindowState();
        const relay = await relayWorkspaceTool(name, {
          ...args,
          // The bridge treats these as Worker-authenticated control metadata,
          // never as values supplied by ChatGPT. They keep workspace reads
          // gated by the Worker-owned task state without persisting a local
          // copy of the active task ID.
          //
          // __gptWorkerActiveTask MUST remain a boolean. bridge/link.mjs reads
          // it as `!!(params && params.__gptWorkerActiveTask)`, so stringifying
          // it here would make an older bridge treat a *closed* window
          // ("expired") as truthy and allow the read — a fail-open. The
          // three-valued state therefore travels in its own key, which an
          // older bridge simply ignores while still refusing correctly.
          __gptWorkerActiveTask: windowState === "active",
          __gptWorkerTaskWindow: windowState,
        });
        if (!relay.ok) return relayFailureToolError(relay.error);
        return toolOk(relay.result);
      } catch (err) {
        return toolError("INTERNAL_ERROR", String((err && err.message) || err));
      }
    },

    /** Three-valued view of the read window: "none" (no non-terminal task at
     *  all), "expired" (a task exists but its last protocol transition is
     *  older than TASK_WINDOW_IDLE_MS) or "active". Split out from
     *  isActiveTaskWindow() so the bridge can tell ChatGPT *why* a gated tool
     *  refused: "no task" and "window closed" need different recoveries from
     *  the operator, and retrying fixes neither. */
    taskWindowState() {
      const task = activeTask();
      if (!task) return "none";
      return Date.now() - task.updated_at < TASK_WINDOW_IDLE_MS ? "active" : "expired";
    },

    /** Boolean form, kept with its original name and shape: BridgeDO delegates
     *  it (see index.js) and invokeTool stamps it onto every relay for older
     *  bridges. */
    isActiveTaskWindow() {
      return this.taskWindowState() === "active";
    },

    /** The window as data, for the CLI's `status` output. The idle ceiling is
     *  Worker-side truth, so it is reported from here rather than duplicated
     *  as a constant in bridge/: the CLI must never hold a second copy of a
     *  value that decides access. `expiresAt` is null when there is no task. */
    taskWindowInfo() {
      const task = activeTask();
      const state = this.taskWindowState();
      return {
        state,
        idleMs: TASK_WINDOW_IDLE_MS,
        expiresAt: task ? task.updated_at + TASK_WINDOW_IDLE_MS : null,
      };
    },
  };
}

export { createBridgeMcp, toolOk, toolError };
