// The pure half of the MCP access history: what a call is summarized as, how its
// result is classified, and — above all — what may NOT end up in a row. This file
// imports worker/src/worker-mcp-access.js directly (it is a stateless helper
// layer, like worker-http.js: no SQL, no env). The stored-row behavior is tested
// through BridgeDO in queue.test.mjs and dashboard.test.mjs.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_DETAILS_BYTES,
  MCP_BATCH_TOOL_NAMES,
  MCP_OUTCOME_CODES,
  MCP_TOOL_NAMES,
  MAX_TARGET_CHARS,
  buildMcpAccessEvent,
  classifyResult,
  safeWorkspacePath,
  serializeDetails,
  summarizeTarget,
} from "../worker/src/worker-mcp-access.js";

const ok = (structuredContent) => ({ content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent });
const toolError = (code, message) => ({
  content: [{ type: "text", text: JSON.stringify({ error: code, message }) }],
  structuredContent: { error: code, message },
  isError: true,
});

describe("safeWorkspacePath", () => {
  test("keeps a workspace-relative path, normalizing separators and dot segments", () => {
    assert.equal(safeWorkspacePath("src/app.js"), "src/app.js");
    assert.equal(safeWorkspacePath("./src//app.js"), "src/app.js");
    assert.equal(safeWorkspacePath("src\\lib\\x.js"), "src/lib/x.js");
    assert.equal(safeWorkspacePath("."), "");
    assert.equal(safeWorkspacePath(""), "");
  });

  test("refuses anything that is absolute, escapes the workspace, or is not a plain path", () => {
    for (const bad of [
      "/etc/passwd",
      "/Users/someone/project/secret.txt",
      "\\\\server\\share\\x",
      "C:\\Users\\x\\y.txt",
      "c:/x",
      "../outside.txt",
      "a/../../b",
      "https://example.com/x",
      "file:///etc/passwd",
      "bad\u0000name",
      "line\nbreak",
      "tab\there",
      42,
      null,
      undefined,
      { path: "x" },
    ]) {
      assert.equal(safeWorkspacePath(bad), null, JSON.stringify(bad));
    }
  });

  test("caps the length in code points, without splitting a surrogate pair", () => {
    const long = "😀".repeat(MAX_TARGET_CHARS + 50);
    const safe = safeWorkspacePath(long);
    assert.equal(Array.from(safe).length, MAX_TARGET_CHARS);
    assert.ok(safe.endsWith("…"));
    assert.doesNotMatch(safe, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, "no lone high surrogate");
  });
});

describe("summarizeTarget", () => {
  test("describes path tools by their sanitized path", () => {
    assert.equal(summarizeTarget("read_file", { path: "src/app.js" }), "src/app.js");
    assert.equal(summarizeTarget("read_file", { path: "src/app.js", offset: 200 }), "src/app.js (from line 201)");
    assert.equal(summarizeTarget("list_directory", { path: "src" }), "src");
    assert.equal(summarizeTarget("list_directory", {}), "workspace root");
    assert.equal(summarizeTarget("list_directory", { path: "." }), "workspace root");
  });

  test("a path that cannot be made safe is replaced by a fixed label, never shown", () => {
    for (const path of ["/etc/passwd", "../x", "C:\\x", "https://x/y", "a\u0000b", 5]) {
      assert.equal(summarizeTarget("read_file", { path }), "invalid/outside workspace path", String(path));
    }
  });

  test("never includes a search query or glob, whatever they contain", () => {
    const summary = summarizeTarget("search_workspace", { query: "password=hunter2 AKIA0123456789ABCDEF", glob: "**/.env*" });
    assert.equal(summary, "workspace search");
    assert.doesNotMatch(summary, /hunter2|AKIA|\.env/);
  });

  test("never includes a message body or title", () => {
    const summary = summarizeTarget("submit_plan", { task_id: "t", iteration: 2, state: "PLAN", title: "SECRET TITLE", body: "SECRET BODY" });
    assert.equal(summary, "PLAN · iteration 2");
    assert.doesNotMatch(summary, /SECRET/);
    assert.equal(summarizeTarget("set_title", { title: "SECRET TITLE" }), "set task title");
  });

  test("a submit_plan state outside the protocol's three is not echoed", () => {
    assert.equal(summarizeTarget("submit_plan", { state: "rm -rf /" }), "reply");
  });

  test("git tools, execution_output and batch use a fixed vocabulary", () => {
    assert.equal(summarizeTarget("git_status", {}), "working tree");
    assert.equal(summarizeTarget("git_diff", {}), "working tree diff");
    assert.equal(summarizeTarget("git_diff", { staged: true, path: "src/a.js" }), "staged diff · src/a.js");
    assert.equal(summarizeTarget("git_log", { path: "docs" }), "git history · docs");
    assert.equal(summarizeTarget("git_log", { path: "/abs/path" }), "git history · invalid/outside workspace path");
    assert.equal(summarizeTarget("execution_output", { task_id: "0123456789abcdef", iteration: 3 }), "task 01234567 · iteration 3");
    assert.equal(summarizeTarget("execution_output", { task_id: "not a task id!!" }), "task output");
    assert.equal(summarizeTarget("workspace_batch", { calls: [{}, {}, {}] }), "3 calls");
    assert.equal(summarizeTarget("workspace_batch", { calls: [{}] }), "1 call");
  });

  test("an unknown tool, or non-object arguments, yield no target rather than a guess", () => {
    assert.equal(summarizeTarget("some_new_tool", { path: "x" }), null);
    assert.equal(summarizeTarget("read_file", "not an object"), "workspace root");
    assert.equal(summarizeTarget("read_file", null), "workspace root");
  });
});

describe("classifyResult", () => {
  test("a normal result is a success", () => {
    assert.deepEqual(classifyResult("read_file", ok({ path: "a.js", text: "secret contents" })), { outcome: "success", code: null, details: null });
  });

  test("the gate's refusals are gate_denied, although they arrive in a success-shaped response", () => {
    assert.deepEqual(classifyResult("read_file", ok({ status: "no_active_task" })), { outcome: "gate_denied", code: "NO_ACTIVE_TASK", details: null });
    assert.deepEqual(
      classifyResult("git_diff", ok({ status: "task_window_expired", message: "text that must not be stored" })),
      { outcome: "gate_denied", code: "TASK_WINDOW_EXPIRED", details: null }
    );
  });

  test("access denials are their own outcome", () => {
    for (const code of ["ACCESS_DENIED_SENSITIVE_FILE", "ACCESS_DENIED_GITIGNORED_FILE", "OUT_OF_WORKSPACE"]) {
      assert.deepEqual(classifyResult("read_file", ok({ error: code, path: ".env" })), { outcome: "access_denied", code, details: null }, code);
    }
  });

  test("local failures and tool errors are errors, carrying only their code", () => {
    for (const code of ["LOCAL_OFFLINE", "LOCAL_DISCONNECTED", "LOCAL_TIMEOUT", "LOCAL_TOOL_ERROR", "INTERNAL_ERROR", "NO_MATCHING_TASK"]) {
      assert.deepEqual(classifyResult("read_file", toolError(code, "message text")), { outcome: "error", code, details: null }, code);
    }
    for (const code of ["SEARCH_TIMEOUT", "SEARCH_FAILED", "GIT_TIMEOUT", "NOT_FOUND", "BINARY_FILE"]) {
      assert.equal(classifyResult("read_file", ok({ error: code })).outcome, "error", code);
    }
    assert.deepEqual(classifyResult("x", ok({ status: "error", message: "boom" })), { outcome: "error", code: "ERROR", details: null });
    assert.deepEqual(classifyResult("x", ok({ status: "unknown_method" })), { outcome: "error", code: "UNKNOWN_METHOD", details: null });
  });

  test("a partial result is a success flagged PARTIAL", () => {
    assert.deepEqual(classifyResult("search_workspace", ok({ hits: [], partial: true, warning: "text" })), { outcome: "success", code: "PARTIAL", details: null });
  });

  test("a code that is not a plain identifier is replaced, so free text cannot be smuggled through it", () => {
    for (const bad of ["lowercase", "HAS SPACE", "WITH-DASH", "X".repeat(65), "", "<script>"]) {
      assert.equal(classifyResult("x", ok({ error: bad })).code, "UNKNOWN", JSON.stringify(bad));
    }
  });

  test("the message text of a result never reaches the classification", () => {
    const verdict = classifyResult("read_file", toolError("LOCAL_OFFLINE", "SECRET MESSAGE"));
    assert.doesNotMatch(JSON.stringify(verdict), /SECRET/);
  });

  describe("workspace_batch", () => {
    const item = (name, result, extra = {}) => ({ id: "call-id-not-stored", name, ok: true, result, ...extra });
    const failed = (name, error) => ({ id: "call-id-not-stored", name, ok: false, error });
    const args = { calls: [{ id: "a", name: "read_file", arguments: { path: "a.js" } }, { id: "b", name: "read_file", arguments: { path: ".env" } }, { id: "c", name: "search_workspace", arguments: { query: "SECRET QUERY" } }] };

    test("all sub-calls succeeding is a success with per-call details", () => {
      const verdict = classifyResult("workspace_batch", ok({ results: [item("read_file", { text: "x" }), item("read_file", { text: "y" })] }), args);
      assert.equal(verdict.outcome, "success");
      assert.equal(verdict.code, null);
      assert.deepEqual(verdict.details.calls.map((c) => [c.tool, c.target, c.outcome]), [
        ["read_file", "a.js", "success"],
        ["read_file", ".env", "success"],
      ]);
    });

    test("all sub-calls failing the same way takes that outcome", () => {
      const verdict = classifyResult(
        "workspace_batch",
        ok({ results: [failed("read_file", { error: "ACCESS_DENIED_SENSITIVE_FILE" }), failed("read_file", { error: "ACCESS_DENIED_GITIGNORED_FILE" })] }),
        args
      );
      assert.equal(verdict.outcome, "access_denied");
      assert.equal(verdict.code, "ACCESS_DENIED_SENSITIVE_FILE", "the first sub-call's code");
    });

    test("a mix of outcomes is 'mixed', and the details say which call did what", () => {
      const verdict = classifyResult(
        "workspace_batch",
        ok({ results: [item("read_file", { text: "x" }), failed("read_file", { error: "ACCESS_DENIED_SENSITIVE_FILE" }), item("search_workspace", { hits: [] })] }),
        args
      );
      assert.equal(verdict.outcome, "mixed");
      assert.equal(verdict.code, null);
      assert.deepEqual(verdict.details.calls.map((c) => [c.target, c.outcome, c.code]), [
        ["a.js", "success", null],
        [".env", "access_denied", "ACCESS_DENIED_SENSITIVE_FILE"],
        ["workspace search", "success", null],
      ]);
    });

    test("details hold only tool, target, outcome and code — never a query, an id or a result", () => {
      const verdict = classifyResult("workspace_batch", ok({ results: [item("search_workspace", { hits: [{ text: "SECRET HIT" }] })] }), args);
      const serialized = JSON.stringify(verdict.details);
      assert.doesNotMatch(serialized, /SECRET|call-id-not-stored/);
      for (const call of verdict.details.calls) assert.deepEqual(Object.keys(call).sort(), ["code", "outcome", "target", "tool"]);
    });

    test("a gated batch is a gate_denied, not a batch verdict", () => {
      assert.deepEqual(classifyResult("workspace_batch", ok({ status: "no_active_task" }), args), { outcome: "gate_denied", code: "NO_ACTIVE_TASK", details: null });
    });

    test("only the first 8 sub-calls are described", () => {
      const results = Array.from({ length: 12 }, () => item("read_file", { text: "x" }));
      assert.equal(classifyResult("workspace_batch", ok({ results }), { calls: [] }).details.calls.length, 8);
    });
  });
});

describe("closed vocabularies: a value that only LOOKS like an identifier is not stored", () => {
  test("an unknown outcome code — even a well-formed one — is stored as UNKNOWN, in every place a code can come from", () => {
    const secret = "SECRET_TOKEN";
    // Structured result, error response, batch sub-result (both shapes), status:error payload.
    const verdicts = [
      classifyResult("read_file", ok({ error: secret })),
      classifyResult("read_file", toolError(secret, "text")),
      classifyResult("x", ok({ status: "error", code: secret })),
      classifyResult(
        "workspace_batch",
        ok({ results: [{ name: "read_file", ok: false, error: { error: secret } }] }),
        { calls: [{ name: "read_file", arguments: { path: "a.js" } }] }
      ),
    ];
    for (const verdict of verdicts) {
      assert.equal(verdict.outcome, "error");
      assert.equal(verdict.code, "UNKNOWN");
      assert.doesNotMatch(JSON.stringify(verdict), /SECRET/);
    }
  });

  test("an unknown ACCESS_DENIED_* code is still a denial, but is stored as the generic code", () => {
    const verdict = classifyResult("read_file", ok({ error: "ACCESS_DENIED_SECRET_PROJECT_NAME" }));
    assert.deepEqual(verdict, { outcome: "access_denied", code: "ACCESS_DENIED", details: null });
  });

  test("every known code round-trips unchanged, and the list holds only identifiers", () => {
    for (const code of MCP_OUTCOME_CODES) {
      assert.match(code, /^[A-Z][A-Z0-9_]{0,63}$/);
      assert.equal(classifyResult("x", ok({ error: code })).code, code);
    }
  });

  test("a batch sub-call's tool comes from the input call and must be a batch tool; the result's name is ignored", () => {
    const verdict = classifyResult(
      "workspace_batch",
      ok({
        results: [
          { name: "secret_tool", ok: true, result: { text: "x" } },
          { name: "read_file", ok: true, result: { text: "x" } },
          { name: "read_file", ok: true, result: { text: "x" } },
        ],
      }),
      { calls: [{ name: "read_file", arguments: { path: "a.js" } }, { name: "totally_secret", arguments: {} }, { name: "workspace_batch", arguments: {} }] }
    );
    assert.deepEqual(verdict.details.calls.map((c) => c.tool), ["read_file", "unknown", "unknown"], "result names never used; non-batch tools are unknown");
    assert.doesNotMatch(JSON.stringify(verdict), /secret/i);
  });

  test("an unknown top-level tool name is stored as 'unknown'", () => {
    const event = buildMcpAccessEvent({ tool: "secret_tool", connector: "dedicated", args: {}, result: ok({}), startedAt: 1, finishedAt: 2 });
    assert.equal(event.toolName, "unknown");
    assert.doesNotMatch(JSON.stringify(event), /secret/);
  });

  test("the tool list equals tools.json plus list_workspaces, and batch tools match bridge/link.mjs's whitelist", () => {
    const declared = JSON.parse(readFileSync(new URL("../worker/src/tools.json", import.meta.url), "utf8")).tools.map((t) => t.name);
    assert.deepEqual([...MCP_TOOL_NAMES].sort(), [...declared, "list_workspaces"].sort());
    const link = readFileSync(new URL("../bridge/link.mjs", import.meta.url), "utf8");
    const whitelist = [...link.match(/const BATCH_WHITELIST = new Set\(\[([\s\S]*?)\]\)/)[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...MCP_BATCH_TOOL_NAMES].sort(), whitelist.sort());
  });
});

describe("serializeDetails", () => {
  test("the cap is in UTF-8 bytes, not characters", () => {
    // 8 calls x 240 four-byte characters: far over 4096 bytes although well under 4096 characters.
    const emoji = "😀".repeat(200);
    const calls = Array.from({ length: 8 }, () => ({ tool: "read_file", target: emoji, outcome: "success", code: null }));
    assert.ok(JSON.stringify({ calls }).length < MAX_DETAILS_BYTES * 2);
    const text = serializeDetails({ calls });
    assert.ok(text === null || new TextEncoder().encode(text).length <= MAX_DETAILS_BYTES);
    assert.notEqual(text, JSON.stringify({ calls }), "the oversized version was not stored as is");
    // Targets dropped but the calls kept, when that fits.
    assert.equal(JSON.parse(text).calls.length, 8);
    assert.ok(JSON.parse(text).calls.every((c) => c.target === null));
  });

  test("a value that is short in characters but over the byte cap is dropped entirely when even targetless calls do not fit", () => {
    const calls = Array.from({ length: 100 }, () => ({ tool: "read_file", target: null, outcome: "success", code: null }));
    assert.equal(serializeDetails({ calls }), null);
  });

  test("stays within the size cap, dropping targets before dropping calls", () => {
    const calls = Array.from({ length: 8 }, () => ({ tool: "read_file", target: "x".repeat(MAX_TARGET_CHARS), outcome: "success", code: null }));
    const text = serializeDetails({ calls });
    assert.ok(text.length <= MAX_DETAILS_BYTES);
    assert.equal(JSON.parse(text).calls.length, 8);
  });

  test("null in, null out", () => {
    assert.equal(serializeDetails(null), null);
  });
});

describe("buildMcpAccessEvent", () => {
  const base = { tool: "read_file", connector: "dedicated", args: { path: "src/a.js" }, result: ok({ text: "FILE CONTENTS" }), startedAt: 1_000, finishedAt: 1_250, taskId: "0123456789abcdef" };

  test("builds a row from a finished call", () => {
    assert.deepEqual(buildMcpAccessEvent(base), {
      startedAt: 1_000,
      durationMs: 250,
      toolName: "read_file",
      connector: "dedicated",
      taskId: "0123456789abcdef",
      target: "src/a.js",
      outcome: "success",
      outcomeCode: null,
      detailsJson: null,
    });
  });

  test("nothing from the call's payload survives except what the vocabulary allows", () => {
    const event = buildMcpAccessEvent({
      ...base,
      tool: "search_workspace",
      args: { query: "SECRET QUERY", glob: "SECRET GLOB" },
      result: ok({ hits: [{ path: "a", line: 1, text: "SECRET HIT" }], warning: "SECRET WARNING" }),
    });
    assert.doesNotMatch(JSON.stringify(event), /SECRET/);
  });

  test("a task id, connector or tool name outside the expected shape is replaced, not stored", () => {
    const event = buildMcpAccessEvent({ ...base, tool: "Not A Tool!", connector: "evil", taskId: "'; DROP TABLE tasks;--" });
    assert.equal(event.toolName, "unknown");
    assert.equal(event.connector, "dedicated");
    assert.equal(event.taskId, null);
  });

  test("a negative or absurd duration is clamped", () => {
    assert.equal(buildMcpAccessEvent({ ...base, startedAt: 5_000, finishedAt: 4_000 }).durationMs, 0);
    assert.equal(buildMcpAccessEvent({ ...base, startedAt: 0, finishedAt: 10 ** 12 }).durationMs, 3_600_000);
  });
});
