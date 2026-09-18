import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-worker-config-test-"));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-worker-state-test-"));
process.env.GPT_WORKER_CONFIG_DIR = configDir;
process.env.GPT_WORKER_STATE_ROOT = stateDir;
const {
  readWorkerConfig,
  updateWorkerConfigAtomic,
  writeWorkerConfigAtomic,
  stripLegacyWorkerConfigFields,
  readTokens,
  writeTokensAtomic,
  updateTokensAtomic,
  stripLegacyWorkspaceGptToken,
} = await import("../bridge/state.mjs?worker-config-test");
const { loadChatSettings, nudgeChatGpt, cmdChatUrl, ensureRemoteSettingsBeforeKeepRemote } = await import("../bridge/cli.mjs?worker-config-test");

after(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("serialized config updates preserve URL and tab mappings added from stale snapshots", () => {
  const workspaceA = "a1b2c3d4e5f60708";
  const workspaceB = "b1b2c3d4e5f60708";
  writeWorkerConfigAtomic({ chatUrl: "https://chatgpt.com/g/g-p-example/project", chromeTabsByWorkspace: {}, chatUrlsByWorkspace: {}, conversationUrlsByWorkspace: {} });

  // Two CLIs may both have seen this old state before either writes.
  const staleA = readWorkerConfig();
  const staleB = readWorkerConfig();
  assert.deepEqual(staleA, staleB);

  updateWorkerConfigAtomic((current) => ({
    ...current,
    chromeTabsByWorkspace: { ...current.chromeTabsByWorkspace, [workspaceA]: "101" },
    chatUrlsByWorkspace: { ...current.chatUrlsByWorkspace, [workspaceA]: "https://chatgpt.com/g/g-p-a/project" },
    conversationUrlsByWorkspace: { ...current.conversationUrlsByWorkspace, [workspaceA]: "https://chatgpt.com/g/g-p-a/c/a" },
  }));
  updateWorkerConfigAtomic((current) => ({
    ...current,
    chromeTabsByWorkspace: { ...current.chromeTabsByWorkspace, [workspaceB]: "202" },
    chatUrlsByWorkspace: { ...current.chatUrlsByWorkspace, [workspaceB]: "https://chatgpt.com/g/g-p-b/project" },
    conversationUrlsByWorkspace: { ...current.conversationUrlsByWorkspace, [workspaceB]: "https://chatgpt.com/g/g-p-b/c/b" },
  }));

  assert.deepEqual(readWorkerConfig().chromeTabsByWorkspace, { [workspaceA]: "101", [workspaceB]: "202" });
  assert.deepEqual(readWorkerConfig().chatUrlsByWorkspace, {
    [workspaceA]: "https://chatgpt.com/g/g-p-a/project",
    [workspaceB]: "https://chatgpt.com/g/g-p-b/project",
  });
  assert.deepEqual(readWorkerConfig().conversationUrlsByWorkspace, {
    [workspaceA]: "https://chatgpt.com/g/g-p-a/c/a",
    [workspaceB]: "https://chatgpt.com/g/g-p-b/c/b",
  });
});

test("a removal based on an old snapshot retains a later workspace URL and tab mapping", () => {
  const workspaceA = "a1b2c3d4e5f60708";
  const workspaceB = "b1b2c3d4e5f60708";
  writeWorkerConfigAtomic({
    chatUrl: "https://chatgpt.com/g/g-p-example/project",
    chromeTabsByWorkspace: { [workspaceA]: "101" },
    chatUrlsByWorkspace: { [workspaceA]: "https://chatgpt.com/g/g-p-a/project" },
  });

  const staleRemoval = readWorkerConfig();
  updateWorkerConfigAtomic((current) => ({
    ...current,
    chromeTabsByWorkspace: { ...current.chromeTabsByWorkspace, [workspaceB]: "202" },
    chatUrlsByWorkspace: { ...current.chatUrlsByWorkspace, [workspaceB]: "https://chatgpt.com/g/g-p-b/project" },
  }));
  updateWorkerConfigAtomic((current) => {
    const tabs = { ...current.chromeTabsByWorkspace };
    const urls = { ...current.chatUrlsByWorkspace };
    delete tabs[workspaceA];
    delete urls[workspaceA];
    return { ...current, chromeTabsByWorkspace: tabs, chatUrlsByWorkspace: urls };
  });

  assert.equal(staleRemoval.chromeTabsByWorkspace[workspaceA], "101");
  assert.deepEqual(readWorkerConfig().chromeTabsByWorkspace, { [workspaceB]: "202" });
  assert.deepEqual(readWorkerConfig().chatUrlsByWorkspace, { [workspaceB]: "https://chatgpt.com/g/g-p-b/project" });
});

test("stripLegacyWorkerConfigFields removes only targeted fields and cleans empty maps", () => {
  const ws1 = "1111111111111111";
  const ws2 = "2222222222222222";
  writeWorkerConfigAtomic({
    workerUrl: "https://example.workers.dev",
    adminToken: "admintoken",
    hubGptToken: "hubtoken",
    chatUrl: "https://chatgpt.com/g/g-p-default/project",
    enterDelayMs: 300,
    chromeTabsByWorkspace: { [ws1]: "101", [ws2]: "102" },
    chatUrlsByWorkspace: { [ws1]: "https://chatgpt.com/g/g-p-1/project", [ws2]: "https://chatgpt.com/g/g-p-2/project" },
    conversationUrlsByWorkspace: { [ws1]: "https://chatgpt.com/g/g-p-1/c/1" },
  });

  // 1. Strip chatUrl
  stripLegacyWorkerConfigFields({ stripChatUrl: true });
  let cfg = readWorkerConfig();
  assert.equal(cfg.chatUrl, undefined);
  assert.equal(cfg.hubGptToken, "hubtoken");
  assert.equal(cfg.enterDelayMs, 300);

  // 2. Strip hubGptToken
  stripLegacyWorkerConfigFields({ stripHubGptToken: true });
  cfg = readWorkerConfig();
  assert.equal(cfg.hubGptToken, undefined);

  // 3. Strip workspace 1 entries
  stripLegacyWorkerConfigFields({ workspaceIdToStrip: ws1 });
  cfg = readWorkerConfig();
  assert.deepEqual(cfg.chatUrlsByWorkspace, { [ws2]: "https://chatgpt.com/g/g-p-2/project" });
  assert.equal(cfg.conversationUrlsByWorkspace, undefined); // was empty after removing ws1, so deleted
  assert.equal(cfg.chromeTabsByWorkspace[ws1], "101"); // local tab preserved!

  // 4. Strip workspace 2 entries
  stripLegacyWorkerConfigFields({ workspaceIdToStrip: ws2 });
  cfg = readWorkerConfig();
  assert.equal(cfg.chatUrlsByWorkspace, undefined);
  assert.equal(cfg.workerUrl, "https://example.workers.dev");
  assert.equal(cfg.adminToken, "admintoken");
});

test("updateTokensAtomic and stripLegacyWorkspaceGptToken preserve runtime credentials and target token shape", () => {
  const wsRoot = fs.mkdtempSync(path.join(stateDir, "test-ws-root-"));
  writeTokensAtomic(wsRoot, {
    workspaceId: "ws-test",
    workspacePath: wsRoot,
    gptToken: "gpt-secret",
    linkToken: "link-secret",
    cliToken: "cli-secret",
  });

  // Concurrent-safe mutation of linkToken
  updateTokensAtomic(wsRoot, (current) => ({
    ...current,
    linkToken: "link-rotated",
  }));
  let tokens = readTokens(wsRoot);
  assert.equal(tokens.linkToken, "link-rotated");
  assert.equal(tokens.gptToken, "gpt-secret");

  // Strip gptToken
  stripLegacyWorkspaceGptToken(wsRoot);
  tokens = readTokens(wsRoot);
  assert.equal(tokens.gptToken, undefined);
  assert.equal(tokens.linkToken, "link-rotated");
  assert.equal(tokens.cliToken, "cli-secret");
  assert.equal(tokens.workspaceId, "ws-test");
  assert.equal(tokens.workspacePath, wsRoot);
});

test("loadChatSettings preserves local legacy values and falls back when remote SET fails", async () => {
  const wsId = "ws-fallback-test";
  const wsRoot = fs.mkdtempSync(path.join(stateDir, "test-ws-fallback-"));
  writeTokensAtomic(wsRoot, {
    workspaceId: wsId,
    workspacePath: wsRoot,
    cliToken: "cli-token-test",
    linkToken: "link-token-test",
  });

  const legacyDefault = "https://chatgpt.com/g/g-p-11111111111111111111111111111111/project";
  const legacyOverride = "https://chatgpt.com/g/g-p-22222222222222222222222222222222/project";
  const legacyConv = "https://chatgpt.com/g/g-p-22222222222222222222222222222222/c/conv-1";

  writeWorkerConfigAtomic({
    workerUrl: "https://example.workers.dev",
    adminToken: "admin-token-test",
    chatUrl: legacyDefault,
    chatUrlsByWorkspace: { [wsId]: legacyOverride },
    conversationUrlsByWorkspace: { [wsId]: legacyConv },
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    let body = {};
    try {
      body = JSON.parse(opts?.body || "{}");
    } catch {}
    if (body.op === "hub_browser_settings_get") {
      return new Response(JSON.stringify({ ok: true, initialized: false }), { status: 200 });
    }
    if (body.op === "hub_browser_settings_set") {
      return new Response(JSON.stringify({ error: "SIMULATED_HUB_SET_FAILURE" }), { status: 500 });
    }
    if (body.op === "browser_settings_get") {
      return new Response(JSON.stringify({ ok: true, initialized: false }), { status: 200 });
    }
    if (body.op === "browser_settings_set") {
      return new Response(JSON.stringify({ error: "SIMULATED_WS_SET_FAILURE" }), { status: 500 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    const cfg = {
      workerUrl: "https://example.workers.dev",
      workspaceId: wsId,
      workspacePath: wsRoot,
      cliToken: "cli-token-test",
    };
    const settings = await loadChatSettings(cfg);

    // Returned settings must fall back to local legacy values
    assert.equal(settings.chatUrl, legacyDefault);
    assert.equal(settings.chatUrlsByWorkspace[wsId], legacyOverride);
    assert.equal(settings.conversationUrlsByWorkspace[wsId], legacyConv);

    // Local worker.json must NOT have stripped the legacy fields
    const persisted = readWorkerConfig();
    assert.equal(persisted.chatUrl, legacyDefault);
    assert.equal(persisted.chatUrlsByWorkspace[wsId], legacyOverride);
    assert.equal(persisted.conversationUrlsByWorkspace[wsId], legacyConv);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("nudgeChatGpt saves Chrome tab ID locally and routes conversation URL to callback without saving to worker.json", async () => {
  const wsId = "ws-tab-test";
  writeWorkerConfigAtomic({
    workerUrl: "https://example.workers.dev",
    adminToken: "admin-token-test",
  });

  let discoveredUrl = null;
  const mockOpenInChrome = () => {
    return {
      submitted: true,
      reused: false,
      tabId: "54321",
      conversationUrl: "https://chatgpt.com/g/g-p-test-scope/c/new-conv-123",
    };
  };

  await nudgeChatGpt(
    { chatUrl: "https://chatgpt.com/g/g-p-test-scope/project" },
    "task-test-id",
    wsId,
    {
      log: () => {},
      onConversationDiscovered: async (url) => {
        discoveredUrl = url;
      },
      _openInChrome: mockOpenInChrome,
    }
  );

  // Callback must receive the conversation URL
  assert.equal(discoveredUrl, "https://chatgpt.com/g/g-p-test-scope/c/new-conv-123");

  // worker.json must record tabId, but NOT conversationUrl or chatUrl
  const persisted = readWorkerConfig();
  assert.equal(persisted.chromeTabsByWorkspace[wsId], "54321");
  assert.equal(persisted.conversationUrlsByWorkspace, undefined);
  assert.equal(persisted.chatUrl, undefined);
  assert.equal(persisted.chatUrlsByWorkspace, undefined);
});

test("fresh hub + legacy shared URL: seeds uninitialized hub and strips local chatUrl only on success", async () => {
  const legacySharedUrl = "https://chatgpt.com/g/g-p-11111111111111111111111111111111/project";
  writeWorkerConfigAtomic({
    workerUrl: "https://example.workers.dev",
    adminToken: "admin-token-test",
    chatUrl: legacySharedUrl,
  });

  // Hub starts uninitialized
  let hubRemoteUrl = null;
  let hubInitialized = false;

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    let body = {};
    try { body = JSON.parse(opts?.body || "{}"); } catch {}
    if (body.op === "hub_browser_settings_get") {
      return new Response(JSON.stringify({ ok: true, initialized: hubInitialized, chatUrl: hubRemoteUrl }), { status: 200 });
    }
    if (body.op === "hub_browser_settings_set") {
      hubInitialized = true;
      hubRemoteUrl = body.chatUrl || null;
      return new Response(JSON.stringify({ ok: true, initialized: true, chatUrl: hubRemoteUrl }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    const settings = await loadChatSettings(null);
    // Remote became initialized with the seeded URL
    assert.equal(hubInitialized, true);
    assert.equal(hubRemoteUrl, legacySharedUrl);
    assert.equal(settings.chatUrl, legacySharedUrl);

    // Local worker.json has stripped chatUrl after successful migration
    const persisted = readWorkerConfig();
    assert.equal(persisted.chatUrl, undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("explicit remote null beats stale local (hub and workspace)", async () => {
  const wsId = "ws-explicit-null";
  const wsRoot = fs.mkdtempSync(path.join(stateDir, "test-ws-null-"));
  writeTokensAtomic(wsRoot, {
    workspaceId: wsId,
    workspacePath: wsRoot,
    cliToken: "cli-token-test",
    linkToken: "link-token-test",
  });

  writeWorkerConfigAtomic({
    workerUrl: "https://example.workers.dev",
    adminToken: "admin-token-test",
    chatUrl: "https://chatgpt.com/g/g-p-stale-hub/project",
    chatUrlsByWorkspace: { [wsId]: "https://chatgpt.com/g/g-p-stale-override/project" },
    conversationUrlsByWorkspace: { [wsId]: "https://chatgpt.com/g/g-p-stale-override/c/stale-conv" },
  });

  let setCalls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    let body = {};
    try { body = JSON.parse(opts?.body || "{}"); } catch {}
    // Remote is explicitly initialized with null
    if (body.op === "hub_browser_settings_get") {
      return new Response(JSON.stringify({ ok: true, initialized: true, chatUrl: null }), { status: 200 });
    }
    if (body.op === "hub_browser_settings_set") {
      setCalls++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (body.op === "browser_settings_get") {
      return new Response(JSON.stringify({ ok: true, initialized: true, chatUrlOverride: null, conversationUrl: null }), { status: 200 });
    }
    if (body.op === "browser_settings_set") {
      setCalls++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    const cfg = {
      workerUrl: "https://example.workers.dev",
      workspaceId: wsId,
      workspacePath: wsRoot,
      cliToken: "cli-token-test",
    };
    const settings = await loadChatSettings(cfg);

    // Explicit remote null beats stale local values
    assert.equal(settings.chatUrl, null);
    assert.equal(settings.chatUrlsByWorkspace[wsId], null);
    assert.equal(settings.conversationUrlsByWorkspace[wsId], null);

    // Must never have re-seeded the stale local values into remote
    assert.equal(setCalls, 0);

    // Stale local fields must be stripped
    const persisted = readWorkerConfig();
    assert.equal(persisted.chatUrl, undefined);
    assert.equal(persisted.chatUrlsByWorkspace?.[wsId], undefined);
    assert.equal(persisted.conversationUrlsByWorkspace?.[wsId], undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("owner-token getter failure keeps local duplicate until successful retrieval", async () => {
  const wsId = "ws-owner-token";
  const wsRoot = fs.mkdtempSync(path.join(stateDir, "test-ws-owner-"));
  writeTokensAtomic(wsRoot, {
    workspaceId: wsId,
    workspacePath: wsRoot,
    cliToken: "cli-token-test",
    linkToken: "link-token-test",
    gptToken: "local-ws-gpt-token",
  });

  writeWorkerConfigAtomic({
    workerUrl: "https://example.workers.dev",
    adminToken: "admin-token-test",
    hubGptToken: "local-hub-gpt-token",
  });

  let failGetters = true;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    let body = {};
    try { body = JSON.parse(opts?.body || "{}"); } catch {}
    if (body.op === "hub_browser_settings_get") {
      return new Response(JSON.stringify({ ok: true, initialized: true, chatUrl: null }), { status: 200 });
    }
    if (body.op === "browser_settings_get") {
      return new Response(JSON.stringify({ ok: true, initialized: true, chatUrlOverride: null, conversationUrl: null }), { status: 200 });
    }
    if (body.op === "hub_owner_token_get") {
      if (failGetters) return new Response(JSON.stringify({ error: "SIMULATED_FAILURE" }), { status: 500 });
      return new Response(JSON.stringify({ ok: true, gptToken: "remote-hub-gpt-token" }), { status: 200 });
    }
    if (body.op === "owner_token_get") {
      if (failGetters) return new Response(JSON.stringify({ error: "SIMULATED_FAILURE" }), { status: 500 });
      return new Response(JSON.stringify({ ok: true, gptToken: "remote-ws-gpt-token" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    const cfg = {
      workerUrl: "https://example.workers.dev",
      workspaceId: wsId,
      workspacePath: wsRoot,
      cliToken: "cli-token-test",
    };

    // 1. When getters fail, local duplicates are preserved
    await loadChatSettings(cfg);
    assert.equal(readWorkerConfig().hubGptToken, "local-hub-gpt-token");
    assert.equal(readTokens(wsRoot).gptToken, "local-ws-gpt-token");

    // 2. When getters succeed, local duplicates are stripped
    failGetters = false;
    await loadChatSettings(cfg);
    assert.equal(readWorkerConfig().hubGptToken, undefined);
    assert.equal(readTokens(wsRoot).gptToken, undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("cmdChatUrl shared default update invalidates default-using workspaces and preserves override workspaces without re-saving overrides to worker.json", async () => {
  const wsA = "1111111111111111"; // uses default
  const wsB = "2222222222222222"; // has remote override
  const wsARoot = fs.mkdtempSync(path.join(stateDir, "ws-a-"));
  const wsBRoot = fs.mkdtempSync(path.join(stateDir, "ws-b-"));
  writeTokensAtomic(wsARoot, { workspaceId: wsA, workspacePath: wsARoot, cliToken: "cli-a" });
  writeTokensAtomic(wsBRoot, { workspaceId: wsB, workspacePath: wsBRoot, cliToken: "cli-b" });

  writeWorkerConfigAtomic({
    workerUrl: "https://example.workers.dev",
    adminToken: "admin-token-test",
    chromeTabsByWorkspace: { [wsA]: "101", [wsB]: "202" },
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    let body = {};
    try { body = JSON.parse(opts?.body || "{}"); } catch {}
    if (body.op === "hub_browser_settings_get") {
      return new Response(JSON.stringify({ ok: true, initialized: true, chatUrl: "https://chatgpt.com/g/g-p-old/project" }), { status: 200 });
    }
    if (body.op === "hub_browser_settings_set") {
      return new Response(JSON.stringify({ ok: true, initialized: true, chatUrl: body.chatUrl }), { status: 200 });
    }
    if (body.op === "browser_settings_get") {
      // wsB has override, wsA has none
      const isWsB = String(url).includes(wsB) || opts?.headers?.["Authorization"]?.includes("cli-b");
      return new Response(JSON.stringify({
        ok: true,
        initialized: true,
        chatUrlOverride: isWsB ? "https://chatgpt.com/g/g-p-b-override/project" : null,
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    await cmdChatUrl({ _: ["https://chatgpt.com/g/g-p-new-default/project"] });

    const persisted = readWorkerConfig();
    // wsA tab cleared, wsB tab preserved
    assert.equal(persisted.chromeTabsByWorkspace[wsA], undefined);
    assert.equal(persisted.chromeTabsByWorkspace[wsB], "202");

    // chatUrlsByWorkspace must NOT be re-saved into worker.json
    assert.equal(persisted.chatUrlsByWorkspace, undefined);
    assert.equal(persisted.chatUrl, undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("ensureRemoteSettingsBeforeKeepRemote aborts cleanup when migration or read-back cannot be confirmed", async () => {
  const wsId = "ws-keep-remote-test";
  const wsRoot = fs.mkdtempSync(path.join(stateDir, "ws-keep-remote-"));

  const worker = {
    workerUrl: "https://example.workers.dev",
    adminToken: "admin-token-test",
    chatUrlsByWorkspace: { [wsId]: "https://chatgpt.com/g/g-p-override/project" },
  };
  const cfg = {
    workerUrl: "https://example.workers.dev",
    workspaceId: wsId,
    workspacePath: wsRoot,
    cliToken: "cli-token-test",
  };

  const origFetch = globalThis.fetch;
  let readBackSuccess = false;
  globalThis.fetch = async (url, opts) => {
    let body = {};
    try { body = JSON.parse(opts?.body || "{}"); } catch {}
    if (body.op === "browser_settings_get") {
      if (!readBackSuccess) {
        return new Response(JSON.stringify({ ok: true, initialized: false }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, initialized: true, chatUrlOverride: "https://chatgpt.com/g/g-p-override/project" }), { status: 200 });
    }
    if (body.op === "browser_settings_set") {
      return new Response(JSON.stringify({ ok: false, error: "NETWORK_ERROR" }), { status: 500 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    // 1. Migration / read-back failure returns ok: false
    const failureResult = await ensureRemoteSettingsBeforeKeepRemote(worker, cfg);
    assert.equal(failureResult.ok, false);
    assert.match(failureResult.error, /could not migrate workspace browser settings/);

    // 2. Confirmed initialized read-back returns ok: true
    readBackSuccess = true;
    const successResult = await ensureRemoteSettingsBeforeKeepRemote(worker, cfg);
    assert.equal(successResult.ok, true);
  } finally {
    globalThis.fetch = origFetch;
  }
});
