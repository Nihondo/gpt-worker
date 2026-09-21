// Contract checks for the MCP Access tab's static pieces: the two dashboard
// shells, the two entry scripts' invalidation routing, and the stylesheet.
// Behavior of the panel itself is in mcp-panel.test.mjs; these pin the wiring
// that a refactor could silently drop (a tab that exists in one shell only, an
// "mcp" event that falls through to a Tasks reload, an outcome class with no style).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import WORKSPACE_APP from "../worker/src/dashboard/workspace-app.js";
import HUB_APP from "../worker/src/dashboard/hub-app.js";
import COMMON_JS from "../worker/src/dashboard/common-app.js";
import CSS from "../worker/src/dashboard/dashboard.css";
import WORKSPACE_SHELL from "../worker/src/dashboard/workspace-shell.html";
import HUB_SHELL from "../worker/src/dashboard/hub-shell.html";
import { MCP_OUTCOMES, MCP_OUTCOME_CODES } from "../worker/src/worker-mcp-access.js";

const SHELLS = { workspace: WORKSPACE_SHELL, hub: HUB_SHELL };
const toolNames = () => JSON.parse(readFileSync(new URL("../worker/src/tools.json", import.meta.url), "utf8")).tools.map((t) => t.name);

function selectValues(html, id) {
  const block = html.match(new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`));
  assert.ok(block, `${id} select exists`);
  return [...block[1].matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
}

describe("both shells carry the MCP Access tab, identically", () => {
  for (const [name, html] of Object.entries(SHELLS)) {
    test(`${name} shell: tab, panes, filters and load-more exist`, () => {
      assert.match(html, /<button[^>]*role="tab"[^>]*id="tab-mcp"[^>]*>MCP Access<\/button>/);
      for (const id of ["mcp-list-col", "mcp-detail", "mcp-list", "mcp-load-more", "mcp-group", "mcp-note"]) {
        assert.ok(html.includes(`id="${id}"`), `${name} shell has #${id}`);
      }
      // The MCP columns start hidden: Tasks stays the landing tab.
      assert.match(html, /id="mcp-list-col" hidden/);
      assert.match(html, /id="mcp-detail" hidden/);
    });

    test(`${name} shell: filters have visible labels, not placeholder-only controls`, () => {
      assert.match(html, /<label for="mcp-filter-tool">Tool<\/label>/);
      assert.match(html, /<label for="mcp-filter-outcome">Result<\/label>/);
    });

    test(`${name} shell: no inline handlers or styles (CSP)`, () => {
      assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
      assert.doesNotMatch(html, /\sstyle\s*=/i);
      assert.doesNotMatch(html, /<style[\s>]/i);
    });
  }

  test("the two shells offer exactly the same filter options", () => {
    for (const id of ["mcp-filter-tool", "mcp-filter-outcome"]) {
      assert.deepEqual(selectValues(HUB_SHELL, id), selectValues(WORKSPACE_SHELL, id), id);
    }
  });

  test("every tool filter value is a real MCP tool, and every tool ChatGPT can call is filterable", () => {
    const options = selectValues(WORKSPACE_SHELL, "mcp-filter-tool").filter(Boolean);
    const tools = toolNames();
    for (const option of options) assert.ok(tools.includes(option), `${option} is in tools.json`);
    // list_workspaces has no workspace of its own to attribute a call to.
    for (const tool of tools.filter((t) => t !== "list_workspaces" && t !== "operating_instructions")) {
      assert.ok(options.includes(tool), `${tool} can be filtered`);
    }
  });

  test("the result filter offers exactly the outcomes the Worker can record", () => {
    assert.deepEqual(selectValues(WORKSPACE_SHELL, "mcp-filter-outcome").filter(Boolean), MCP_OUTCOMES);
  });
});

describe("entry scripts route the 'mcp' scope to the MCP list only", () => {
  test("workspace-app: 'mcp' calls handleMcpInvalidate, never pollActivity/refreshAll", () => {
    const branch = WORKSPACE_APP.match(/scope === "mcp"\) \{([\s\S]*?)\} else \{/);
    assert.ok(branch, "mcp branch exists");
    const code = branch[1].replace(/\/\/.*$/gm, ""); // comments may name what is avoided
    assert.match(code, /panel\.handleMcpInvalidate\(\)/);
    assert.doesNotMatch(code, /pollActivity|refreshAll/);
  });

  test("workspace-app: a queued 'mcp' event stays 'mcp' unless something stronger arrived", () => {
    const merge = new Function(`${WORKSPACE_APP.match(/function mergeScope\(prev, next\) \{[\s\S]*?\n    \}/)[0]}; return mergeScope;`)();
    assert.equal(merge("mcp", "mcp"), "mcp");
    assert.equal(merge(undefined, "mcp"), "mcp");
    assert.equal(merge("mcp", "activity"), "activity");
    assert.equal(merge("activity", "mcp"), "activity");
    assert.equal(merge("mcp", "settings"), "settings");
    assert.equal(merge("registry", "mcp"), "registry");
  });

  test("hub-app: 'mcp' refreshes only the selected workspace and never a status read", () => {
    const branch = HUB_APP.match(/scope === "mcp"\) \{([\s\S]*?)\} else \{/);
    assert.ok(branch, "mcp branch exists");
    const code = branch[1].replace(/\/\/.*$/gm, "");
    assert.match(code, /state\.workspaceId === workspaceId\) panel\.handleMcpInvalidate\(\)/);
    assert.doesNotMatch(code, /pollActivity|refreshSingleWorkspaceStatus|refreshAll/);
  });

  test("hub-app: a queued 'mcp' event is never promoted to an activity reload by itself", () => {
    const merge = new Function(`${HUB_APP.match(/function mergeWorkspaceScope\(prev, next\) \{[\s\S]*?\n    \}/)[0]}; return mergeWorkspaceScope;`)();
    assert.equal(merge(undefined, "mcp"), "mcp");
    assert.equal(merge("mcp", "mcp"), "mcp");
    assert.equal(merge("mcp", "activity"), "activity");
    assert.equal(merge("activity", "mcp"), "activity");
    assert.equal(merge("mcp", "settings"), "settings");
    assert.equal(merge("settings", "mcp"), "settings");
  });
});

describe("reason codes", () => {
  test("every stored denial / gate / local-bridge code has a sentence in the UI, so none is shown raw", () => {
    const table = COMMON_JS.match(/var MCP_CODE_TEXT = \{([\s\S]*?)\n\};/);
    assert.ok(table, "MCP_CODE_TEXT exists");
    const described = new Set([...table[1].matchAll(/^\s{2}([A-Z_]+):/gm)].map((m) => m[1]));
    const mustDescribe = MCP_OUTCOME_CODES.filter((code) => /^(ACCESS_DENIED|LOCAL_|NO_ACTIVE_TASK|TASK_WINDOW_EXPIRED|OUT_OF_WORKSPACE)/.test(code));
    assert.ok(mustDescribe.length >= 8);
    for (const code of mustDescribe) assert.ok(described.has(code), `${code} needs a MCP_CODE_TEXT entry`);
  });
});

describe("stylesheet", () => {
  test("every outcome class the script can emit has a light and a dark rule", () => {
    const classes = [...new Set([...COMMON_JS.matchAll(/mcp-outcome-[a-z]+/g)].map((m) => m[0]))];
    assert.ok(classes.length >= 5, `found ${classes.join(", ")}`);
    const darkStart = CSS.indexOf("@media (prefers-color-scheme: dark)");
    assert.ok(darkStart > 0);
    const light = CSS.slice(0, darkStart);
    const dark = CSS.slice(darkStart);
    for (const cls of classes) {
      assert.ok(light.includes(`.${cls} {`), `${cls} light rule`);
      assert.ok(dark.includes(`.${cls} {`), `${cls} dark rule`);
    }
  });

  test("outcome badges never rely on color alone: the label text is rendered and the base rule sets contrast text", () => {
    assert.match(CSS, /\.mcp-outcome \{ color: #fff; \}/);
    assert.match(CSS, /\.mcp-outcome \{ color: #10111c; \}/);
    assert.match(COMMON_JS, /label: "Denied"/);
    assert.match(COMMON_JS, /label: "Blocked"/);
  });

  test("no external resources", () => {
    assert.doesNotMatch(CSS, /@import|url\(\s*["']?https?:/i);
  });
});
