// The dashboard's "MCP Access" tab, exercised by running the real browser code
// (common-app.js + workspace-panel.js) against a tiny fake DOM
// (tests/helpers/fake-dom.mjs). The other dashboard tests check these files as
// source text; this one drives them, because the tab has real state to get right:
// paging, filters that must hold across pages, responses that arrive out of
// order, and grouping that must never swallow a denial.
//
// The fake DOM throws on innerHTML/outerHTML, so every test here also proves the
// rendering rule "untrusted text goes through textContent, never as markup".

import { before, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import COMMON_JS from "../worker/src/dashboard/common-app.js";
import PANEL_JS from "../worker/src/dashboard/workspace-panel.js";
import { createFakeDom, descendants, withClass } from "./helpers/fake-dom.mjs";

// The panel imports its helpers from ./common-app.js, which a data: URL cannot
// resolve. Both files are plain ES modules with no other imports, so they are
// joined into one module (the import line dropped) and loaded from a data URL.
const BUNDLE = COMMON_JS + "\n" + PANEL_JS.replace(/^import \{[\s\S]*?\} from "\.\/common-app\.js";\n/, "");
let lib;
before(async () => {
  lib = await import("data:text/javascript;base64," + Buffer.from(BUNDLE).toString("base64"));
});

const OVERVIEW = { connected: true, pendingToGpt: 0, pendingToLocal: 0, activeTask: null, guidanceSet: false, maxBodyBytes: 16384 };
const ok = (body) => ({ ok: true, status: 200, body });
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
};

let seq = 0;
function ev(over = {}) {
  seq += 1;
  return {
    eventId: seq,
    startedAt: 10_000_000 - seq * 60_000, // >30 s apart: never grouped unless a test asks for it
    durationMs: 12,
    toolName: "read_file",
    connector: "dedicated",
    taskId: "0123456789abcdef",
    target: `src/file-${seq}.js`,
    outcome: "success",
    outcomeCode: null,
    details: null,
    ...over,
  };
}

/** Builds a panel over a fake DOM. `mcp(path, searchParams)` answers /mcp-access. */
async function setup(mcp) {
  const dom = createFakeDom();
  globalThis.document = dom.document;
  const calls = [];
  const adapter = { current: null };
  adapter.isCurrent = (target) => adapter.current === target;
  adapter.request = (target, path) => {
    calls.push(path);
    const url = new URL("https://x" + path);
    if (path.startsWith("/snapshot")) return Promise.resolve(ok({ overview: OVERVIEW, tasks: { tasks: [], nextCursor: null }, messages: { messages: [], nextCursor: null } }));
    if (path === "/overview") return Promise.resolve(ok(OVERVIEW));
    if (path === "/guidance") return Promise.resolve(ok({ guidance: "" }));
    if (path === "/limits") return Promise.resolve(ok({ maxBodyBytes: 16384 }));
    if (path === "/browser-settings") return Promise.resolve(ok({}));
    if (path.startsWith("/mcp-access")) return Promise.resolve(mcp(path, url.searchParams));
    return Promise.resolve({ ok: false, status: 404, body: {} });
  };
  const panel = lib.createWorkspacePanel(adapter);
  const target = Object.freeze({ workspaceId: "0123456789abcdef" });
  adapter.current = target;
  await panel.activate(target);
  await flush();
  const node = (id) => dom.document.getElementById(id);
  return {
    dom, panel, adapter, calls, target, node,
    mcpCalls: () => calls.filter((path) => path.startsWith("/mcp-access")),
    openTab: async () => { node("tab-mcp").click(); await flush(); },
    rows: () => node("mcp-list").children.filter((child) => child.tagName === "BUTTON"),
    select: (id, value) => { node(id).value = value; node(id).dispatch("change"); },
  };
}

const page = (events, nextCursor = null) => ok({ events, nextCursor });
const rowText = (row) => row.textContent;

describe("opening the tab", () => {
  test("nothing is read until the tab is opened, then exactly one request loads the newest calls", async () => {
    const t = await setup(() => page([ev()]));
    assert.equal(t.mcpCalls().length, 0, "the Tasks/Messages view never reads MCP history");

    await t.openTab();

    assert.equal(t.mcpCalls().length, 1);
    assert.equal(t.mcpCalls()[0], "/mcp-access?limit=50");
    assert.equal(t.node("tab-mcp").getAttribute("aria-selected"), "true");
    assert.equal(t.node("tab-tasks").getAttribute("aria-selected"), "false");
    assert.equal(t.node("mcp-list-col").hidden, false);
    assert.equal(t.node("mcp-detail").hidden, false);
    assert.equal(t.node("tasks-list-col").hidden, true);
    assert.equal(t.node("messages-list-col").hidden, true);
  });

  test("a row says what happened in words: tool, target, result, time taken and which task", async () => {
    const t = await setup(() => page([ev({ target: "src/app.js", durationMs: 1234, taskId: "abcdef0123456789" })]));
    await t.openTab();

    const text = rowText(t.rows()[0]);
    assert.match(text, /OK/);
    assert.match(text, /Read file/);
    assert.match(text, /src\/app\.js/);
    assert.match(text, /read_file/, "the raw tool name is still shown, as secondary text");
    assert.match(text, /1\.2 s/);
    assert.match(text, /task abcdef01/);
  });

  test("each kind of outcome is a different word, with the reason in plain language", async () => {
    const t = await setup(() =>
      page([
        ev({ outcome: "gate_denied", outcomeCode: "NO_ACTIVE_TASK", target: "a.js" }),
        ev({ outcome: "access_denied", outcomeCode: "ACCESS_DENIED_SENSITIVE_FILE", target: ".env" }),
        ev({ outcome: "error", outcomeCode: "LOCAL_OFFLINE", target: "b.js" }),
        ev({ outcome: "mixed", toolName: "workspace_batch", target: "3 calls" }),
      ])
    );
    await t.openTab();

    const [gate, denied, error, mixed] = t.rows().map(rowText);
    assert.match(gate, /Blocked/);
    assert.match(gate, /No active task — reading stays closed/);
    assert.match(denied, /Denied/);
    assert.match(denied, /Sensitive file — never readable/);
    assert.match(error, /Error/);
    assert.match(error, /The local bridge was not connected/);
    assert.match(mixed, /Mixed/);
    assert.match(mixed, /Batch/);
  });

  test("an empty history says how it fills up, not just 'nothing'", async () => {
    const t = await setup(() => page([]));
    await t.openTab();
    assert.match(t.node("mcp-list").textContent, /No MCP calls recorded yet/);
  });

  test("the outcome badge is a text label carrying its own class — never color alone", async () => {
    const t = await setup(() => page([ev({ outcome: "access_denied", outcomeCode: "OUT_OF_WORKSPACE" })]));
    await t.openTab();
    const [badge] = withClass(t.rows()[0], "mcp-outcome");
    assert.equal(badge.textContent, "Denied");
    assert.ok(badge.hasClass("mcp-outcome-denied"));
  });
});

describe("filters", () => {
  test("a tool filter goes to the API and starts a fresh list", async () => {
    const t = await setup((path, params) => page(params.get("tool") === "git_log" ? [ev({ toolName: "git_log", target: "git history" })] : [ev(), ev()]));
    await t.openTab();
    assert.equal(t.rows().length, 2);

    t.select("mcp-filter-tool", "git_log");
    await flush();

    assert.equal(t.mcpCalls().at(-1), "/mcp-access?limit=50&tool=git_log");
    assert.equal(t.rows().length, 1);
    assert.match(rowText(t.rows()[0]), /Git log/);
  });

  test("tool and result filters combine, and both are URL-encoded", async () => {
    const t = await setup(() => page([]));
    await t.openTab();
    t.select("mcp-filter-tool", "read_file");
    await flush();
    t.select("mcp-filter-outcome", "access_denied");
    await flush();
    assert.equal(t.mcpCalls().at(-1), "/mcp-access?limit=50&tool=read_file&outcome=access_denied");
  });

  test("an empty filtered result says the filters matched nothing", async () => {
    const t = await setup(() => page([]));
    await t.openTab();
    t.select("mcp-filter-outcome", "error");
    await flush();
    assert.match(t.node("mcp-list").textContent, /No MCP calls match these filters/);
  });

  test("filters are cleared for a newly selected workspace, in the state and in the controls", async () => {
    const t = await setup(() => page([ev()]));
    await t.openTab();
    t.select("mcp-filter-tool", "git_diff");
    await flush();

    const other = Object.freeze({ workspaceId: "fedcba9876543210" });
    t.adapter.current = other;
    await t.panel.activate(other);
    await flush();
    await t.openTab();

    assert.equal(t.node("mcp-filter-tool").value, "");
    assert.equal(t.mcpCalls().at(-1), "/mcp-access?limit=50", "the old filter does not leak into the next workspace");
  });

  test("a response that arrives after the filter changed is dropped, not shown", async () => {
    const pending = [];
    const t = await setup((path) => new Promise((resolve) => pending.push({ path, resolve })));
    // Two loads in flight: the unfiltered one started first and will answer LAST.
    t.node("tab-mcp").click();
    await flush();
    t.select("mcp-filter-tool", "git_status");
    await flush();
    assert.equal(pending.length, 2);

    pending[1].resolve(page([ev({ toolName: "git_status", target: "working tree" })]));
    await flush();
    pending[0].resolve(page([ev({ target: "STALE unfiltered result" })]));
    await flush();

    assert.equal(t.rows().length, 1);
    assert.doesNotMatch(t.node("mcp-list").textContent, /STALE/);
    assert.match(t.node("mcp-list").textContent, /working tree/);
  });
});

describe("paging and refreshing", () => {
  test("Load more follows the cursor, merges without duplicates, and hides itself at the end", async () => {
    const first = [ev({ eventId: 100, startedAt: 900_000 }), ev({ eventId: 99, startedAt: 800_000 })];
    const second = [ev({ eventId: 98, startedAt: 700_000 }), ev({ eventId: 99, startedAt: 800_000 })];
    const t = await setup((path, params) => (params.get("cursor") === "next-page" ? page(second) : page(first, "next-page")));
    await t.openTab();
    assert.equal(t.node("mcp-load-more").hidden, false);
    assert.equal(t.rows().length, 2);

    t.node("mcp-load-more").click();
    await flush();

    assert.equal(t.mcpCalls().at(-1), "/mcp-access?limit=50&cursor=next-page");
    assert.equal(t.rows().length, 3, "event 99 arrived twice and is shown once");
    assert.equal(t.node("mcp-load-more").hidden, true);
  });

  test("refreshing while extra pages are loaded keeps them instead of collapsing the list", async () => {
    const newest = ev({ eventId: 100, startedAt: 900_000 });
    const t = await setup((path, params) => {
      if (params.get("cursor")) return page([ev({ eventId: 50, startedAt: 100_000 })]);
      return page([newest, ev({ eventId: 99, startedAt: 800_000 })], "more");
    });
    await t.openTab();
    t.node("mcp-load-more").click();
    await flush();
    assert.equal(t.rows().length, 3);

    await t.panel.pollActivity();
    await flush();

    assert.equal(t.rows().length, 3, "the loaded older page survived the refresh");
  });

  test("a refresh brings in newer calls at the top", async () => {
    let calls = 0;
    const t = await setup(() => page(calls++ === 0 ? [ev({ eventId: 1, target: "first.js", startedAt: 1_000_000 })] : [ev({ eventId: 2, target: "second.js", startedAt: 2_000_000 }), ev({ eventId: 1, target: "first.js", startedAt: 1_000_000 })]));
    await t.openTab();
    assert.equal(t.rows().length, 1);

    await t.panel.pollActivity();
    await flush();

    assert.match(rowText(t.rows()[0]), /second\.js/);
    assert.equal(t.rows().length, 2);
  });
});

describe("live updates never reload Tasks or Messages", () => {
  test("an MCP invalidation refreshes the history only when that tab is on screen", async () => {
    const t = await setup(() => page([ev()]));

    await t.panel.handleMcpInvalidate();
    await flush();
    assert.equal(t.mcpCalls().length, 0, "the Tasks tab is showing: nothing to refresh");

    await t.openTab();
    const before = t.mcpCalls().length;
    await t.panel.handleMcpInvalidate();
    await flush();
    assert.equal(t.mcpCalls().length, before + 1);
    assert.equal(t.calls.filter((path) => path.startsWith("/snapshot")).length, 1, "no snapshot beyond the initial load");
  });

  test("polling on the MCP tab reads the history and the overview strip, and not the snapshot", async () => {
    const t = await setup(() => page([ev()]));
    await t.openTab();
    t.calls.length = 0;

    await t.panel.pollActivity();
    await flush();

    assert.deepEqual(t.calls.slice().sort(), ["/mcp-access?limit=50", "/overview"]);
  });

  test("polling on the Tasks tab is unchanged: the snapshot, and no MCP request", async () => {
    const t = await setup(() => page([ev()]));
    t.calls.length = 0;

    await t.panel.pollActivity();
    await flush();

    assert.ok(t.calls.every((path) => path.startsWith("/snapshot")));
    assert.equal(t.mcpCalls().length, 0);
  });

  test("a full refresh re-reads the history if — and only if — the MCP tab is showing", async () => {
    const t = await setup(() => page([ev()]));
    await t.panel.refreshAll();
    await flush();
    assert.equal(t.mcpCalls().length, 0);

    await t.openTab();
    const before = t.mcpCalls().length;
    await t.panel.refreshAll();
    await flush();
    assert.equal(t.mcpCalls().length, before + 1);
  });
});

describe("the trailing settling reload (the Worker throttles notifications)", () => {
  // The Worker sends one "mcp" notification per 2 s and the dashboard does not
  // poll while its WebSocket is healthy, so a call made just after a notification
  // is only ever seen if the browser reloads once more after the throttle window.
  const withTimers = async (run) => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try { await run(); } finally { mock.timers.reset(); }
  };

  test("a notification reloads now and once more after the throttle window, picking up the swallowed tail", () =>
    withTimers(async () => {
      let served = [ev({ eventId: 1, target: "first.js" })];
      const t = await setup(() => page(served));
      await t.openTab();
      const before = t.mcpCalls().length;

      await t.panel.handleMcpInvalidate();
      await flush();
      assert.equal(t.mcpCalls().length, before + 1, "immediate reload");

      // Calls made inside the throttle window: the Worker sent no second notification.
      served = [ev({ eventId: 3, target: "tail-2.js", startedAt: 3_000_000 }), ev({ eventId: 2, target: "tail-1.js", startedAt: 2_000_000 }), ev({ eventId: 1, target: "first.js", startedAt: 1_000_000 })];
      mock.timers.tick(2499);
      await flush();
      assert.equal(t.mcpCalls().length, before + 1, "not before the window has closed");

      mock.timers.tick(1);
      await flush();
      assert.equal(t.mcpCalls().length, before + 2, "exactly one trailing reload");
      assert.equal(t.rows().length, 3);
      assert.match(t.node("mcp-list").textContent, /tail-2\.js/);

      mock.timers.tick(60_000);
      await flush();
      assert.equal(t.mcpCalls().length, before + 2, "and it does not repeat");
    }));

  test("a newer notification replaces the pending reload instead of stacking another", () =>
    withTimers(async () => {
      const t = await setup(() => page([ev()]));
      await t.openTab();
      const before = t.mcpCalls().length;

      await t.panel.handleMcpInvalidate();
      mock.timers.tick(2000);
      await t.panel.handleMcpInvalidate();
      await flush();
      assert.equal(t.mcpCalls().length, before + 2);

      mock.timers.tick(2499);
      await flush();
      assert.equal(t.mcpCalls().length, before + 2, "the first timer was cancelled");
      mock.timers.tick(1);
      await flush();
      assert.equal(t.mcpCalls().length, before + 3, "one trailing reload for the last notification");
    }));

  test("leaving the MCP tab cancels it: Tasks/Messages never cause an MCP read", () =>
    withTimers(async () => {
      const t = await setup(() => page([ev()]));
      await t.openTab();
      await t.panel.handleMcpInvalidate();
      await flush();
      const before = t.mcpCalls().length;

      t.node("tab-messages").click();
      await flush();
      mock.timers.tick(10_000);
      await flush();

      assert.equal(t.mcpCalls().length, before);
    }));

  test("leaving the tab and coming straight back does not add a stale trailing reload on top of the tab's own", () =>
    withTimers(async () => {
      const t = await setup(() => page([ev()]));
      await t.openTab();
      await t.panel.handleMcpInvalidate();
      await flush();

      t.node("tab-messages").click();
      await flush();
      const before = t.mcpCalls().length;
      await t.openTab(); // returning loads the list once
      assert.equal(t.mcpCalls().length, before + 1);

      mock.timers.tick(10_000);
      await flush();
      assert.equal(t.mcpCalls().length, before + 1, "the timer from the earlier visit was cancelled");
    }));

  test("switching workspace cancels it, and the old workspace is never fetched again", () =>
    withTimers(async () => {
      const t = await setup(() => page([ev()]));
      await t.openTab();
      await t.panel.handleMcpInvalidate();
      await flush();
      const before = t.mcpCalls().length;

      const other = Object.freeze({ workspaceId: "fedcba9876543210" });
      t.adapter.current = other;
      await t.panel.activate(other);
      await flush();
      const afterSwitch = t.mcpCalls().length; // the new workspace opens on Tasks: no MCP read
      mock.timers.tick(10_000);
      await flush();

      assert.equal(afterSwitch, before);
      assert.equal(t.mcpCalls().length, before, "no stray reload for either workspace");
    }));

  test("a notification while Tasks is showing schedules nothing", () =>
    withTimers(async () => {
      const t = await setup(() => page([ev()]));
      await t.panel.handleMcpInvalidate();
      mock.timers.tick(10_000);
      await flush();
      assert.equal(t.mcpCalls().length, 0);
    }));
});

describe("grouping repeated reads", () => {
  // Newest first. Three reads in quick succession, a denied read, then reads
  // separated by a long gap.
  const stream = () => [
    ev({ eventId: 60, startedAt: 1_000_000, target: "a.js" }),
    ev({ eventId: 59, startedAt: 990_000, target: "b.js" }),
    ev({ eventId: 58, startedAt: 985_000, target: "c.js" }),
    ev({ eventId: 57, startedAt: 980_000, target: ".env", outcome: "access_denied", outcomeCode: "ACCESS_DENIED_SENSITIVE_FILE" }),
    ev({ eventId: 56, startedAt: 970_000, target: "d.js" }),
    ev({ eventId: 55, startedAt: 900_000, target: "e.js" }),
  ];

  test("consecutive successful reads fold into one row; a denial stands alone and splits the run", async () => {
    const t = await setup(() => page(stream()));
    await t.openTab();

    const texts = t.rows().map(rowText);
    assert.equal(texts.length, 4);
    assert.match(texts[0], /Read file × 3/);
    assert.match(texts[1], /Denied/);
    assert.match(texts[1], /\.env/, "the denied read is visible on its own line");
    assert.doesNotMatch(texts[2], /×/);
    assert.match(texts[2], /d\.js/);
    assert.match(texts[3], /e\.js/, "a gap over 30 seconds starts a new run");
  });

  test("turning grouping off lists every call", async () => {
    const t = await setup(() => page(stream()));
    await t.openTab();
    t.node("mcp-group").checked = false;
    t.node("mcp-group").dispatch("change");
    assert.equal(t.rows().length, 6);
    assert.equal(t.mcpCalls().length, 1, "regrouping is a view change: no new request");
  });

  test("opening a group lists the files, newest first", async () => {
    const t = await setup(() => page(stream()));
    await t.openTab();
    t.rows()[0].click();

    const detail = t.node("mcp-detail").textContent;
    assert.match(detail, /Files read \(newest first\)/);
    assert.ok(detail.indexOf("a.js") < detail.indexOf("b.js") && detail.indexOf("b.js") < detail.indexOf("c.js"));
    assert.equal(t.dom.threePane.hasClass("detail-open"), true, "on a narrow screen the detail replaces the list");
  });

  test("a selected group stays selected when a newer read joins it", async () => {
    let extra = false;
    const t = await setup(() => page(extra ? [ev({ eventId: 61, startedAt: 1_005_000, target: "new.js" }), ...stream()] : stream()));
    await t.openTab();
    t.rows()[0].click();
    assert.equal(t.rows()[0].getAttribute("aria-selected"), "true");

    extra = true;
    await t.panel.pollActivity();
    await flush();

    assert.match(rowText(t.rows()[0]), /Read file × 4/);
    assert.equal(t.rows()[0].getAttribute("aria-selected"), "true", "the group id follows its oldest member, so it does not change");
    assert.match(t.node("mcp-detail").textContent, /new\.js/, "and its detail was refreshed");
  });

  test("the Back button returns focus to the row that was opened", async () => {
    const t = await setup(() => page(stream()));
    await t.openTab();
    t.rows()[1].click();
    const [back] = withClass(t.node("mcp-detail"), "detail-back");
    back.click();

    assert.equal(t.dom.threePane.hasClass("detail-open"), false);
    assert.ok(t.dom.focused(), "something was focused");
    assert.match(rowText(t.dom.focused()), /Denied/);
  });
});

describe("the detail pane", () => {
  test("a single call lists when, how long, target, result, task and connector", async () => {
    const t = await setup(() => page([ev({ connector: "shared", target: "docs/plan.md", durationMs: 850, outcome: "access_denied", outcomeCode: "ACCESS_DENIED_GITIGNORED_FILE", taskId: "fedcba9876543210" })]));
    await t.openTab();
    t.rows()[0].click();

    const facts = withClass(t.node("mcp-detail"), "mcp-facts")[0].textContent;
    for (const expected of ["When", "Duration", "850 ms", "Target", "docs/plan.md", "Result", "Denied — Git-ignored file", "Task", "fedcba9876543210", "Connector", "Shared connector"]) {
      assert.ok(facts.includes(expected), `detail should include "${expected}": ${facts}`);
    }
  });

  test("a call made with no active task says so instead of showing an empty id", async () => {
    const t = await setup(() => page([ev({ taskId: null, outcome: "gate_denied", outcomeCode: "NO_ACTIVE_TASK" })]));
    await t.openTab();
    t.rows()[0].click();
    assert.match(t.node("mcp-detail").textContent, /none was active/);
  });

  test("a batch shows each of its calls with its own result", async () => {
    const t = await setup(() =>
      page([
        ev({
          toolName: "workspace_batch",
          target: "3 calls",
          outcome: "mixed",
          details: {
            calls: [
              { tool: "read_file", target: "a.js", outcome: "success", code: null },
              { tool: "read_file", target: ".env", outcome: "access_denied", code: "ACCESS_DENIED_SENSITIVE_FILE" },
              { tool: "search_workspace", target: "workspace search", outcome: "error", code: "SEARCH_TIMEOUT" },
            ],
          },
        }),
      ])
    );
    await t.openTab();
    t.rows()[0].click();

    const calls = withClass(t.node("mcp-detail"), "mcp-call-row").map((row) => row.textContent);
    assert.equal(calls.length, 3);
    assert.match(calls[0], /OK.*Read file.*a\.js/);
    assert.match(calls[1], /Denied.*Read file.*\.env.*Sensitive file/);
    assert.match(calls[2], /Error.*Search.*workspace search.*took too long/);
    assert.match(t.node("mcp-detail").textContent, /Calls in this batch/);
  });
});

describe("untrusted text is only ever text", () => {
  test("markup in a target, an unknown code and an unknown tool render literally — nothing is interpreted", async () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const t = await setup(() =>
      page([
        ev({ target: hostile, toolName: "weird_tool", outcome: "error", outcomeCode: "WEIRD_CODE" }),
        ev({ toolName: "workspace_batch", outcome: "mixed", details: { calls: [{ tool: "read_file", target: hostile, outcome: "success", code: null }] } }),
      ])
    );
    await t.openTab();
    t.rows()[0].click();
    t.rows()[1].click();

    // (The fake DOM throws on any innerHTML/outerHTML/insertAdjacentHTML use.)
    assert.match(t.node("mcp-list").textContent, /<img src=x onerror="alert\(1\)"><script>/);
    assert.match(t.node("mcp-list").textContent, /weird_tool/);
    assert.match(t.node("mcp-list").textContent, /WEIRD_CODE/);
    assert.ok(descendants(t.node("mcp-detail")).every((node) => node.tagName !== "IMG" && node.tagName !== "SCRIPT"));
    assert.ok(descendants(t.node("mcp-list")).every((node) => node.tagName !== "IMG" && node.tagName !== "SCRIPT"));
  });

  test("a response for a workspace that is no longer selected is ignored", async () => {
    let release;
    const t = await setup(() => new Promise((resolve) => { release = () => resolve(page([ev({ target: "belongs-to-the-old-workspace.js" })])); }));
    t.node("tab-mcp").click();
    await flush();
    t.adapter.current = Object.freeze({ workspaceId: "fedcba9876543210" });

    release();
    await flush();

    assert.doesNotMatch(t.node("mcp-list").textContent, /belongs-to-the-old-workspace/);
  });
});

describe("presentation helpers (common-app.js)", () => {
  test("groupMcpEvents: a group needs two reads of one task within 30s; the id follows the oldest member", () => {
    const events = [
      ev({ eventId: 4, startedAt: 40_000, taskId: "task-A-1234" }),
      ev({ eventId: 3, startedAt: 30_000, taskId: "task-A-1234" }),
      ev({ eventId: 2, startedAt: 25_000, taskId: "task-B-5678" }),
      ev({ eventId: 1, startedAt: 20_000, taskId: "task-B-5678" }),
    ];
    const items = lib.groupMcpEvents(events);
    assert.deepEqual(items.map((i) => [i.type, i.id, i.count || 1]), [["group", "group-3", 2], ["group", "group-1", 2]]);
  });

  test("groupMcpEvents never folds a non-read or a non-success in, and a lone read stays a plain event", () => {
    const items = lib.groupMcpEvents([
      ev({ eventId: 5, toolName: "list_directory" }),
      ev({ eventId: 4, toolName: "list_directory" }),
      ev({ eventId: 3, outcome: "error", outcomeCode: "LOCAL_TIMEOUT" }),
      ev({ eventId: 2 }),
    ]);
    assert.deepEqual(items.map((i) => i.type), ["event", "event", "event", "event"]);
  });

  test("groupMcpEvents does not fold reads made through different connectors", () => {
    const items = lib.groupMcpEvents([
      ev({ eventId: 4, startedAt: 40_000, connector: "shared" }),
      ev({ eventId: 3, startedAt: 35_000, connector: "shared" }),
      ev({ eventId: 2, startedAt: 30_000, connector: "dedicated" }),
      ev({ eventId: 1, startedAt: 25_000, connector: "dedicated" }),
    ]);
    assert.deepEqual(items.map((i) => [i.type, i.count, i.newest ? i.newest.connector : i.event.connector]), [["group", 2, "shared"], ["group", 2, "dedicated"]]);
  });

  test("every code the Worker can store as a denial has a plain-language sentence", () => {
    for (const code of ["ACCESS_DENIED", "ACCESS_DENIED_SENSITIVE_FILE", "ACCESS_DENIED_GITIGNORED_FILE", "ACCESS_DENIED_EXPLICIT_READ", "OUT_OF_WORKSPACE"]) {
      assert.notEqual(lib.mcpCodeText(code), code, `${code} is not shown raw`);
    }
  });

  test("labels, durations and codes have safe fallbacks", () => {
    assert.equal(lib.mcpToolLabel("read_file"), "Read file");
    assert.equal(lib.mcpToolLabel("brand_new_tool"), "brand_new_tool");
    assert.equal(lib.mcpToolLabel(undefined), "Unknown tool");
    assert.deepEqual(lib.mcpOutcomeInfo("access_denied"), { label: "Denied", className: "mcp-outcome-denied" });
    assert.equal(lib.mcpOutcomeInfo("something_new").label, "something_new");
    assert.equal(lib.mcpCodeText("NO_ACTIVE_TASK").startsWith("No active task"), true);
    assert.equal(lib.mcpCodeText("SOME_NEW_CODE"), "SOME_NEW_CODE");
    assert.equal(lib.mcpCodeText(null), null);
    assert.equal(lib.formatDuration(12), "12 ms");
    assert.equal(lib.formatDuration(1234), "1.2 s");
    assert.equal(lib.formatDuration(15000), "15 s");
    assert.equal(lib.formatDuration(-1), "");
    assert.equal(lib.formatDuration("soon"), "");
    assert.equal(lib.mcpTaskLabel(null), "no active task");
  });

  test("mcpComparator orders newest first, breaking ties by event id", () => {
    const sorted = [ev({ eventId: 1, startedAt: 5 }), ev({ eventId: 3, startedAt: 9 }), ev({ eventId: 2, startedAt: 9 })].sort(lib.mcpComparator);
    assert.deepEqual(sorted.map((e) => e.eventId), [3, 2, 1]);
  });
});
