import {
  readWorkerConfig,
  updateWorkerConfigAtomic,
  readTokens,
  stripLegacyWorkerConfigFields,
  stripLegacyWorkspaceGptToken,
  listProvisionedWorkspaces,
} from "./state.mjs";
import { chatGptConversationUrl } from "./mac-chrome.mjs";
import {
  effectiveChatUrl,
  isChatGptUrl,
  safeBrowserConfig,
  withChatUrl,
  withoutWorkspaceChatConversation,
  withoutWorkspaceChatSettings,
  withoutWorkspaceChromeTab,
  workspaceChatUrl,
  workspaceConversationUrl,
} from "./chat-nudge.mjs";
import {
  adminCall,
  localCall,
  requireWorkspaceConfig,
  workspaceRoot,
} from "./cli-runtime.mjs";

export async function loadChatSettings(cfg) {
  let worker = readWorkerConfig();
  if (!worker) return null;

  let hubRes = null;
  try {
    hubRes = await adminCall(worker, "hub_browser_settings_get");
  } catch {}

  let wsRes = null;
  if (cfg) {
    try {
      wsRes = await localCall(cfg, "browser_settings_get");
    } catch {}
  }

  let hubAuthorityEstablished = false;
  let hubChatUrl = null;

  // 1. Hub browser migration
  if (hubRes && !hubRes.error) {
    if (hubRes.initialized) {
      hubAuthorityEstablished = true;
      hubChatUrl = hubRes.chatUrl;
      if (worker.chatUrl) {
        worker = stripLegacyWorkerConfigFields({ stripChatUrl: true });
      }
    } else {
      let seedChatUrl = worker.chatUrl || null;
      let legacySettings = null;
      if (!seedChatUrl && cfg) {
        try {
          legacySettings = await localCall(cfg, "settings_get");
          if (legacySettings && !legacySettings.error && legacySettings.chatUrl) {
            seedChatUrl = legacySettings.chatUrl;
          }
        } catch {}
      }
      if (legacySettings && !legacySettings.error && legacySettings.enterDelayMs && worker.enterDelayMs === undefined) {
        worker = updateWorkerConfigAtomic((c) => ({ ...c, enterDelayMs: legacySettings.enterDelayMs }));
      }
      const setPayload = seedChatUrl ? { chatUrl: seedChatUrl } : {};
      try {
        const setRes = await adminCall(worker, "hub_browser_settings_set", setPayload);
        if (setRes && !setRes.error && setRes.initialized) {
          hubAuthorityEstablished = true;
          hubChatUrl = setRes.chatUrl;
          worker = stripLegacyWorkerConfigFields({ stripChatUrl: true });
        }
      } catch {}
    }
  }

  if (!hubAuthorityEstablished) {
    hubChatUrl = worker.chatUrl || null;
  }

  let wsAuthorityEstablished = false;
  let override = null;
  let conversation = null;

  // 2. Workspace browser migration
  if (cfg) {
    const wsId = cfg.workspaceId;
    if (wsRes && !wsRes.error) {
      if (wsRes.initialized) {
        wsAuthorityEstablished = true;
        override = wsRes.chatUrlOverride;
        conversation = wsRes.conversationUrl;
        if (worker.chatUrlsByWorkspace?.[wsId] || worker.conversationUrlsByWorkspace?.[wsId]) {
          worker = stripLegacyWorkerConfigFields({ workspaceIdToStrip: wsId });
        }
      } else {
        const localOverride = worker.chatUrlsByWorkspace?.[wsId] || null;
        const localConv = worker.conversationUrlsByWorkspace?.[wsId] || null;
        const effectiveProj = localOverride || hubChatUrl || null;
        let validConv = null;
        if (localConv && effectiveProj) {
          validConv = chatGptConversationUrl(localConv, effectiveProj);
        }
        try {
          const setRes = await localCall(cfg, "browser_settings_set", {
            chatUrlOverride: localOverride,
            conversationUrl: validConv,
          });
          if (setRes && !setRes.error && setRes.initialized) {
            wsAuthorityEstablished = true;
            override = setRes.chatUrlOverride;
            conversation = setRes.conversationUrl;
            worker = stripLegacyWorkerConfigFields({ workspaceIdToStrip: wsId });
          }
        } catch {}
      }
    }

    if (!wsAuthorityEstablished) {
      override = worker.chatUrlsByWorkspace?.[wsId] || null;
      conversation = worker.conversationUrlsByWorkspace?.[wsId] || null;
    }
  }

  // 3. Owner token migration (hub)
  if (worker.hubGptToken && hubRes && !hubRes.error) {
    try {
      const tokenRes = await adminCall(worker, "hub_owner_token_get");
      if (tokenRes && !tokenRes.error && tokenRes.gptToken) {
        worker = stripLegacyWorkerConfigFields({ stripHubGptToken: true });
      }
    } catch {}
  }

  // 4. Owner token migration (workspace)
  if (cfg && cfg.workspacePath) {
    const tokens = readTokens(cfg.workspacePath);
    if (tokens && tokens.gptToken) {
      try {
        const tokenRes = await adminCall(worker, "owner_token_get", { workspace_id: cfg.workspaceId });
        if (tokenRes && !tokenRes.error && tokenRes.gptToken) {
          stripLegacyWorkspaceGptToken(cfg.workspacePath);
        }
      } catch {}
    }
  }

  const effectiveProj = override || hubChatUrl;
  let validConv = null;
  if (conversation && effectiveProj) {
    validConv = chatGptConversationUrl(conversation, effectiveProj);
  }

  return {
    ...worker,
    chatUrl: hubChatUrl,
    ...(cfg
      ? {
          chatUrlsByWorkspace: {
            ...(worker.chatUrlsByWorkspace || {}),
            [cfg.workspaceId]: override,
          },
          conversationUrlsByWorkspace: {
            ...(worker.conversationUrlsByWorkspace || {}),
            [cfg.workspaceId]: validConv,
          },
        }
      : {}),
  };
}

export async function sharedChatSettings(cfg) {
  return loadChatSettings(cfg);
}

/** Import the pre-Worker-source-of-truth checkpoint once, then remove it.
 * Settings are imported too, so state.json is never repurposed as a local
 * preferences store after this migration. */
export async function cmdChatUrl(args) {
  let worker = readWorkerConfig();
  if (!worker) {
    console.error("Not initialized. Run: gpt-worker init -w <workspace>");
    process.exit(1);
  }
  const workspaceCfg = args.workspace ? requireWorkspaceConfig(workspaceRoot(args)) : null;
  const workspaceId = workspaceCfg?.workspaceId;
  const url = args._[0];
  let flagsChanged = false;

  if (args.clear && !workspaceId) {
    console.error("--clear requires -w <workspace>; the shared chat-url is the default and cannot be cleared this way.");
    process.exit(1);
  }
  if (args.clear && url) {
    console.error("Use either a URL or --clear, not both.");
    process.exit(1);
  }

  if (args["enter-delay"] !== undefined) {
    const nextDelay = Number(args["enter-delay"]);
    worker = updateWorkerConfigAtomic((current) => ({ ...(current || worker), enterDelayMs: nextDelay }));
    flagsChanged = true;
  }

  if (args.clear) {
    const res = await localCall(workspaceCfg, "browser_settings_set", { chatUrlOverride: "" });
    if (res.error) {
      console.error(`Failed to clear workspace override: ${res.error}`);
      process.exit(1);
    }
    updateWorkerConfigAtomic((config) => withoutWorkspaceChromeTab(withoutWorkspaceChatSettings(config || worker, workspaceId), workspaceId));
    const current = await loadChatSettings(workspaceCfg);
    console.log(
      `Cleared this workspace's Project URL override. Effective URL: ${
        effectiveChatUrl(current, workspaceId) || "(none; set the shared default with: gpt-worker chat-url <url>)"
      }`
    );
    if (flagsChanged) console.log(`enterDelayMs=${worker.enterDelayMs} (machine-wide)`);
    return;
  }

  if (!url) {
    if (flagsChanged) {
      console.log(`Saved. enterDelayMs=${worker.enterDelayMs} (machine-wide)`);
      return;
    }
    const current = await loadChatSettings(workspaceCfg);
    if (workspaceId) {
      const override = workspaceChatUrl(current, workspaceId);
      console.log(`workspace override: ${override || "(none; using the shared default)"}`);
      console.log(`shared default    : ${current.chatUrl || "(none)"}`);
      console.log(`effective URL     : ${effectiveChatUrl(current, workspaceId) || "(none)"}`);
      return;
    }
    console.log(current.chatUrl || "(none set for the shared ChatGPT Project)");
    return;
  }

  if (!isChatGptUrl(url)) {
    console.error("Expected an https://chatgpt.com/... Project URL.");
    process.exit(1);
  }
  if (workspaceId) {
    const res = await localCall(workspaceCfg, "browser_settings_set", { chatUrlOverride: url });
    if (res.error) {
      console.error(`Failed to set workspace override: ${res.error}`);
      process.exit(1);
    }
    updateWorkerConfigAtomic((config) => withoutWorkspaceChromeTab(withoutWorkspaceChatSettings(config || worker, workspaceId), workspaceId));
    console.log(
      `Saved this workspace's ChatGPT Project URL override. 'gpt-worker task' / 'gpt-worker report' will use it for this workspace.`
    );
    if (flagsChanged) console.log(`enterDelayMs=${worker.enterDelayMs} (machine-wide)`);
    return;
  }

  let previousChatUrl = worker.chatUrl || null;
  try {
    const currentHub = await adminCall(worker, "hub_browser_settings_get");
    if (currentHub && !currentHub.error && currentHub.chatUrl) {
      previousChatUrl = currentHub.chatUrl;
    }
  } catch {}

  const res = await adminCall(worker, "hub_browser_settings_set", { chatUrl: url });
  if (res.error) {
    console.error(`Failed to set shared default: ${res.error}`);
    process.exit(1);
  }

  const tabs = worker.chromeTabsByWorkspace;
  const overrides = {};
  if (tabs && typeof tabs === "object" && Object.keys(tabs).length > 0) {
    const workspaces = listProvisionedWorkspaces();
    for (const ws of workspaces) {
      if (ws.workspaceId && ws.cliToken && tabs[ws.workspaceId]) {
        try {
          const wsRes = await localCall(
            { workerUrl: worker.workerUrl, workspaceId: ws.workspaceId, cliToken: ws.cliToken },
            "browser_settings_get"
          );
          if (wsRes && !wsRes.error && wsRes.chatUrlOverride) {
            overrides[ws.workspaceId] = wsRes.chatUrlOverride;
          }
        } catch {}
      }
    }
  }

  updateWorkerConfigAtomic((config) => {
    const current = config || worker;
    const settingsWithOverrides = {
      ...current,
      chatUrl: previousChatUrl,
      chatUrlsByWorkspace: {
        ...(current.chatUrlsByWorkspace || {}),
        ...overrides,
      },
    };
    const nextWithChat = withChatUrl(settingsWithOverrides, url);
    const next = { ...current };
    if (nextWithChat.chromeTabsByWorkspace) {
      next.chromeTabsByWorkspace = nextWithChat.chromeTabsByWorkspace;
    } else {
      delete next.chromeTabsByWorkspace;
    }
    if (current.conversationUrlsByWorkspace) {
      if (nextWithChat.conversationUrlsByWorkspace) {
        next.conversationUrlsByWorkspace = nextWithChat.conversationUrlsByWorkspace;
      } else {
        delete next.conversationUrlsByWorkspace;
      }
    }
    delete next.chatUrl;
    return next;
  });
  console.log(`Saved the shared default. Workspaces without an override will use this ChatGPT Project automatically.`);
  if (flagsChanged) console.log(`enterDelayMs=${worker.enterDelayMs} (machine-wide)`);
}

export async function cmdChat(args) {
  const root = workspaceRoot(args);
  const cfg = requireWorkspaceConfig(root);
  const worker = readWorkerConfig();
  const action = args._[0];
  if (!worker) {
    console.error("Not initialized. Run: gpt-worker init -w <workspace>");
    process.exit(1);
  }
  if (!action || !["new", "attach", "status"].includes(action)) {
    console.error("Usage: gpt-worker chat <new|attach|status> [conversation-url] -w <workspace>");
    process.exit(1);
  }
  const chatSettings = await loadChatSettings(cfg);
  const projectUrl = effectiveChatUrl(chatSettings, cfg.workspaceId);
  if (!projectUrl) {
    console.error("No ChatGPT Project URL is configured. Set one with: gpt-worker chat-url <project-url>");
    process.exit(1);
  }
  if (action === "status") {
    console.log(`project      : ${projectUrl}`);
    console.log(
      `conversation : ${
        workspaceConversationUrl(chatSettings, cfg.workspaceId, projectUrl) || "(none; the next handoff starts a new chat)"
      }`
    );
    return;
  }
  if (action === "new") {
    if (args._[1]) {
      console.error("Usage: gpt-worker chat new -w <workspace>");
      process.exit(1);
    }
    const res = await localCall(cfg, "browser_settings_set", { conversationUrl: "" });
    if (res.error) {
      console.error(`Failed to start fresh conversation: ${res.error}`);
      process.exit(1);
    }
    updateWorkerConfigAtomic((current) =>
      withoutWorkspaceChromeTab(withoutWorkspaceChatConversation(current || worker, cfg.workspaceId), cfg.workspaceId)
    );
    console.log(
      "Started a fresh ChatGPT conversation for this workspace. The next task or report will not reuse the previous conversation."
    );
    return;
  }
  const conversationUrl = chatGptConversationUrl(args._[1], projectUrl);
  if (!conversationUrl) {
    console.error("Expected a same-Project ChatGPT conversation URL (https://chatgpt.com/g/.../c/...).");
    process.exit(1);
  }
  const res = await localCall(cfg, "browser_settings_set", { conversationUrl });
  if (res.error) {
    console.error(`Failed to attach conversation: ${res.error}`);
    process.exit(1);
  }
  updateWorkerConfigAtomic((current) =>
    withoutWorkspaceChromeTab(withoutWorkspaceChatConversation(current || worker, cfg.workspaceId), cfg.workspaceId)
  );
  console.log("Attached this workspace to the ChatGPT conversation. Its tab will be rediscovered by URL when possible.");
}

