import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkPid,
  listProvisionedWorkspaces,
  readTokens,
  readWorkerConfig,
  removeWorkspaceStateDir,
  stripLegacyWorkerConfigFields,
  stripLegacyWorkspaceGptToken,
  updateTokensAtomic,
  updateWorkerConfigAtomic,
  workspaceStateDir,
  writeTokensAtomic,
  writeWorkerConfigAtomic,
} from "./state.mjs";
import {
  safeBrowserConfig,
  withChatUrl,
  withoutWorkspaceChatSettings,
} from "./chat-nudge.mjs";
import {
  adminCall,
  checkPrerequisites,
  localCall,
  requireWorkspaceConfig,
  workspaceRoot,
} from "./cli-runtime.mjs";
import { loadChatSettings } from "./cli-browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.join(HERE, "..", "worker");

async function ensureSharedConnector(worker) {
  const result = await adminCall(worker, "provision_hub");
  if (result.error) {
    throw new Error(`Failed to provision shared connector: ${result.error || "invalid response"}`);
  }
  return worker;
}

async function registerSharedWorkspace(worker, tokens, root) {
  const result = await adminCall(worker, "register_workspace", {
    workspace_id: tokens.workspaceId,
    name: path.basename(root),
  });
  if (result.error) {
    throw new Error(`Failed to register workspace with shared connector: ${result.error}`);
  }
}

/** Rotates the resource-owner credential for the shared /mcp OAuth resource.
 *  Every already-authorized client must re-authorize after rotation. Unlike
 *  gpt_token/link_token/cli_token, hub_gpt_token isn't tied to a workspace,
 *  so this doesn't take -w. */
async function cmdRotateHub() {
  const worker = readWorkerConfig();
  if (!worker) {
    console.error("Shared connector is not initialized. Run: gpt-worker init -w <workspace>");
    process.exit(1);
  }
  const result = await adminCall(worker, "rotate_hub");
  if (result.error) {
    console.error(`Rotate failed: ${result.error}`);
    process.exit(1);
  }
  stripLegacyWorkerConfigFields({ stripHubGptToken: true });
  console.log("Rotated hub_gpt_token.");
  console.log(`The connector Server URL remains:\n  ${worker.workerUrl}/mcp`);
  console.log(`New owner token:\n  ${result.value}`);
  console.log("Re-authorize it with the new owner token from: gpt-worker url");
}

export async function cmdRotate(args) {
  if (args.hub) return cmdRotateHub();

  const root = workspaceRoot(args);
  const cfg = requireWorkspaceConfig(root);
  const which = args.gpt ? "gpt_token" : args.link ? "link_token" : args.cli ? "cli_token" : null;
  if (!which) {
    console.error("Usage: gpt-worker rotate --gpt | --link | --cli | --hub [-w <dir>]");
    process.exit(1);
  }
  // Per-workspace tokens live in that workspace's own Durable Object (not a
  // Worker Secret — see worker/src/index.js's `secrets` table), so rotation
  // goes through /admin, not `wrangler secret put`.
  const result = await adminCall({ workerUrl: cfg.workerUrl, adminToken: cfg.adminToken }, "rotate", {
    workspace_id: cfg.workspaceId,
    key: which,
  });
  if (result.error) {
    console.error(`Rotate failed: ${result.error}`);
    process.exit(1);
  }
  if (which === "gpt_token") {
    stripLegacyWorkspaceGptToken(root);
  } else {
    updateTokensAtomic(root, (tokens) => {
      if (!tokens) return tokens;
      const next = { ...tokens };
      if (which === "link_token") next.linkToken = result.value;
      if (which === "cli_token") next.cliToken = result.value;
      return next;
    });
  }
  console.log(`Rotated ${which}.`);
  if (which === "gpt_token") {
    console.log(`The workspace OAuth resource remains:\n  ${cfg.workerUrl}/mcp/${cfg.workspaceId}`);
    console.log(`New owner token:\n  ${result.value}`);
    console.log(`Re-authorize it with the new owner token from: gpt-worker url -w ${root}`);
  }
  if (which === "link_token") {
    console.log(`Restart the bridge so it reconnects with the new link token: gpt-worker stop -w ${root} && gpt-worker start -w ${root}`);
  }
}



function runWrangler(args, { input, cwd } = {}) {
  return execFileSync("npx", ["--yes", "wrangler", ...args], {
    cwd: cwd || WORKER_DIR,
    input,
    encoding: "utf8",
  });
}

/** Extract the public Worker origin from Wrangler output. Wrangler may print
 * dashboard and documentation links too, so prefer a workers.dev origin and
 * never mistake a Cloudflare dashboard URL for the deployed endpoint. */
export function extractWorkerUrl(deployOutput) {
  const urls = String(deployOutput || "").match(/https:\/\/[^\s)\]}>"']+/g) || [];
  const candidates = [];
  for (const value of urls) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || /(^|\.)dash\.cloudflare\.com$/i.test(url.hostname)) continue;
      candidates.push(url.origin);
    } catch {
      /* not a usable URL */
    }
  }
  return candidates.find((url) => /\.workers\.dev$/i.test(new URL(url).hostname)) || candidates[0] || null;
}

function suppliedWorkerUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname === "/" ? url.origin : null;
  } catch {
    return null;
  }
}

function printPreflight(result) {
  for (const line of result.info) console.log(`  ✓ ${line}`);
  for (const line of result.warnings) console.warn(`  ! ${line}`);
}

export async function cmdInit(args) {
  const root = workspaceRoot(args);
  let worker = readWorkerConfig();
  const existingTokens = readTokens(root);

  if (!args["skip-preflight"]) {
    console.log("Checking local prerequisites...");
    const prerequisites = checkPrerequisites();
    printPreflight(prerequisites);
    if (!prerequisites.ok) {
      for (const line of prerequisites.fatal) console.error(`  ✗ ${line}`);
      console.error("Initialization stopped before contacting Cloudflare. Fix the prerequisites above, or re-run with --skip-preflight if you accept the risk.");
      process.exit(1);
    }
  } else {
    console.warn("Skipping local prerequisite checks (--skip-preflight).");
  }

  if (worker && existingTokens && !args.force) {
    worker = await ensureSharedConnector(worker);
    await registerSharedWorkspace(worker, existingTokens, root);
    await loadChatSettings({ workerUrl: worker.workerUrl, adminToken: worker.adminToken, ...existingTokens, workspacePath: root });
    console.log(`Already provisioned for this workspace.`);
    console.log(`OAuth Server URL: ${worker.workerUrl}/mcp`);
    console.log("(Also available any time via: gpt-worker url -w " + root + ")");
    console.log("This workspace is available through the already registered ChatGPT connector.");
    return;
  }

  if (!worker) {
    // First-ever run on this machine/account: deploy the Worker once and
    // set the one machine-wide ADMIN_TOKEN. Every later `init -w <dir>` for
    // another workspace reuses this — no further `wrangler deploy`.
    const overrideUrl = args["worker-url"] === true ? null : suppliedWorkerUrl(args["worker-url"]);
    if (args["worker-url"] && !overrideUrl) {
      console.error("Invalid --worker-url: provide an HTTPS origin such as https://example.workers.dev");
      process.exit(1);
    }
    let workerUrl = overrideUrl;
    if (!workerUrl) {
      console.log("Checking Cloudflare login...");
      try {
        runWrangler(["whoami"]);
      } catch {
        console.error("Not logged in to Cloudflare. Run this in an interactive terminal first:\n  npx wrangler login\nThen re-run: gpt-worker init");
        process.exit(1);
      }

      console.log("Deploying the relay Worker...");
      let deployOut;
      try {
        deployOut = runWrangler(["deploy"]);
      } catch (err) {
        console.error("Deploy failed:\n" + (err.stdout || err.message || err));
        process.exit(1);
      }
      workerUrl = extractWorkerUrl(deployOut);
      if (!workerUrl) {
        console.error("Could not find the deployed Worker URL in wrangler's output. Re-run with --worker-url https://your-worker.example:\n" + deployOut);
        process.exit(1);
      }
    } else {
      console.log(`Using supplied Worker URL: ${workerUrl}`);
    }
    const adminToken = crypto.randomBytes(32).toString("hex");

    console.log("Setting the admin secret...");
    runWrangler(["secret", "put", "ADMIN_TOKEN"], { input: adminToken });

    worker = { workerUrl, adminToken };
    writeWorkerConfigAtomic(worker);
    console.log(`✓ Deployed: ${workerUrl}`);
  } else {
    console.log(`Using the existing Worker deployment: ${worker.workerUrl}`);
  }

  worker = await ensureSharedConnector(worker);
  if (existingTokens && args.force) {
    const removed = await adminCall(worker, "unregister_workspace", { workspace_id: existingTokens.workspaceId });
    if (removed.error) throw new Error(`Failed to replace existing workspace registration: ${removed.error}`);
  }

  // Provision (or, with --force, re-provision under a fresh id) this workspace.
  const workspaceId = crypto.randomBytes(8).toString("hex");
  console.log(`Provisioning this workspace (${workspaceId})...`);
  const result = await adminCall(worker, "provision", { workspace_id: workspaceId });
  if (result.error) {
    console.error(`Failed to provision workspace: ${result.error}`);
    process.exit(1);
  }
  const tokens = { workspaceId, linkToken: result.linkToken, cliToken: result.cliToken, workspacePath: root };
  writeTokensAtomic(root, tokens);
  await registerSharedWorkspace(worker, tokens, root);

  console.log(`
✓ Workspace provisioned: ${workspaceId}
✓ Tokens saved (mode 600)

This workspace has been added to the shared connector.

If you have not registered it yet, add this single connector in ChatGPT once:
  Name: gpt-worker

  OAuth (no secret embedded in the URL):
    Server URL:     ${worker.workerUrl}/mcp
    Authentication: OAuth
    (ChatGPT will register itself and show a consent page; enter the owner
    token from "gpt-worker url" there — never in the URL. Rotate it
    anytime with "gpt-worker rotate --hub".)

Then use one ChatGPT Project for every workspace. Future gpt-worker init -w
<new-dir> commands only add that directory to this connector; they never
need another ChatGPT URL, connector, or Project.
`);
}

export async function cmdUrl(args) {
  const worker = readWorkerConfig();
  if (!worker) {
    console.error("Shared connector is not initialized. Run: gpt-worker init -w <workspace>");
    process.exit(1);
  }

  // The secret-free OAuth Server URL plus the existing token that
  // doubles as the resource-owner credential you type into the consent page
  // an OAuth client redirects you to (see docs/plans/oauth-mcp-authentication.md).
  // --oauth remains an accepted no-op alias for scripts that adopted the
  // previous OAuth-first interface. No separate OAuth token is minted —
  // gpt_token/hub_gpt_token are reused.
  if (args.workspace) {
    const root = workspaceRoot(args);
    const tokens = readTokens(root);
    if (!tokens) {
      console.error(`This workspace isn't provisioned yet. Run: gpt-worker init -w ${root}`);
      process.exit(1);
    }
    let gptToken = null;
    const res = await adminCall(worker, "owner_token_get", { workspace_id: tokens.workspaceId });
    if (!res.error && res.gptToken) {
      gptToken = res.gptToken;
      stripLegacyWorkspaceGptToken(root);
    } else if (tokens.gptToken) {
      gptToken = tokens.gptToken;
    } else {
      console.error(`Failed to retrieve owner token: ${res.error || "not provisioned"}`);
      process.exit(1);
    }
    console.log(`WebUI URL:         ${worker.workerUrl}/dashboard/${tokens.workspaceId}
OAuth Server URL:  ${worker.workerUrl}/mcp/${tokens.workspaceId}
OAuth owner token: ${gptToken}
Rotate the owner token with: gpt-worker rotate --gpt -w ${root}`);
    return;
  }

  let hubGptToken = null;
  const res = await adminCall(worker, "hub_owner_token_get");
  if (!res.error && res.gptToken) {
    hubGptToken = res.gptToken;
    stripLegacyWorkerConfigFields({ stripHubGptToken: true });
  } else if (worker.hubGptToken) {
    hubGptToken = worker.hubGptToken;
  } else {
    console.error("Shared connector is not initialized. Run: gpt-worker init -w <workspace>");
    process.exit(1);
  }

  console.log(`WebUI URL:         ${worker.workerUrl}/dashboard/hub
OAuth Server URL:  ${worker.workerUrl}/mcp
OAuth owner token: ${hubGptToken}
Rotate the owner token with: gpt-worker rotate --hub`);
}

export async function cmdWorkspaces() {
  const list = listProvisionedWorkspaces();
  if (list.length === 0) {
    console.log("No workspaces provisioned yet. Run: gpt-worker init -w <dir>");
    return;
  }
  for (const w of list) {
    let pidStatus = "unknown";
    try {
      pidStatus = checkPid(w.workspacePath || w.stateDir).status;
    } catch {
      pidStatus = "path missing";
    }
    console.log(`${w.workspacePath || "(path unknown — pre-dates workspacePath tracking)"}`);
    console.log(`  workspace_id=${w.workspaceId}  bridge=${pidStatus}`);
  }
}

function formatConfigUrl(url) {
  return url || "(none)";
}

function printBrowserConfig(config) {
  console.log(`shared default : ${formatConfigUrl(config.sharedChatUrl)}`);
  console.log(`enter delay    : ${config.enterDelayMs ?? "(default)"}`);
  if (config.workspaces.length === 0) {
    console.log("workspaces     : (none provisioned)");
    return;
  }
  console.log("workspaces:");
  for (const workspace of config.workspaces) {
    console.log(`  ${workspace.workspacePath || "(path unknown)"}`);
    console.log(`    workspace_id : ${workspace.workspaceId}`);
    console.log(`    override     : ${formatConfigUrl(workspace.chatUrlOverride)}`);
    console.log(`    effective    : ${formatConfigUrl(workspace.effectiveChatUrl)}`);
    console.log(`    conversation : ${formatConfigUrl(workspace.conversationUrl)}`);
  }
}

export async function cmdShowConfig(args) {
  const worker = readWorkerConfig();
  if (!worker) {
    console.error("Not initialized. Run: gpt-worker init -w <workspace>");
    process.exit(1);
  }
  let workspaceId = null;
  let workspaces = listProvisionedWorkspaces();
  let targetCfg = null;
  if (args.workspace) {
    const root = workspaceRoot(args);
    targetCfg = requireWorkspaceConfig(root);
    workspaceId = targetCfg.workspaceId;
    if (!workspaces.some((workspace) => workspace.workspaceId === workspaceId)) {
      workspaces = [...workspaces, { workspaceId, workspacePath: root }];
    }
  }
  let chatSettings = await loadChatSettings(targetCfg);
  for (const ws of workspaces) {
    if (
      ws.workspaceId &&
      (!chatSettings.chatUrlsByWorkspace?.[ws.workspaceId] || !chatSettings.conversationUrlsByWorkspace?.[ws.workspaceId])
    ) {
      if (ws.workspacePath) {
        const tokens = readTokens(ws.workspacePath);
        if (tokens?.cliToken) {
          try {
            const wsRes = await localCall(
              { workerUrl: worker.workerUrl, workspaceId: ws.workspaceId, cliToken: tokens.cliToken },
              "browser_settings_get"
            );
            if (wsRes && !wsRes.error) {
              if (wsRes.chatUrlOverride) {
                chatSettings.chatUrlsByWorkspace = {
                  ...chatSettings.chatUrlsByWorkspace,
                  [ws.workspaceId]: wsRes.chatUrlOverride,
                };
              }
              if (wsRes.conversationUrl) {
                chatSettings.conversationUrlsByWorkspace = {
                  ...chatSettings.conversationUrlsByWorkspace,
                  [ws.workspaceId]: wsRes.conversationUrl,
                };
              }
            }
          } catch {}
        }
      }
    }
  }
  printBrowserConfig(safeBrowserConfig(chatSettings, workspaces, workspaceId));
}

export async function ensureRemoteSettingsBeforeKeepRemote(worker, cfg) {
  if (worker.chatUrlsByWorkspace?.[cfg.workspaceId] || worker.conversationUrlsByWorkspace?.[cfg.workspaceId]) {
    await loadChatSettings(cfg);
    const wsCheck = await localCall(cfg, "browser_settings_get").catch(() => null);
    if (!wsCheck || wsCheck.error || !wsCheck.initialized) {
      return { ok: false, error: "could not migrate workspace browser settings to Cloudflare before --keep-remote removal" };
    }
  }
  return { ok: true };
}

/** Deregisters a workspace. Destructive and, on the remote side, permanent
 *  (see BridgeDO.deprovision) — requires --yes; without it, only previews
 *  what would happen. Default wipes both sides; --keep-remote leaves the
 *  Worker's tokens/queue for this workspace_id untouched (its Server URL
 *  keeps working) and only forgets the local registration. */
export async function cmdRemove(args) {
  const root = workspaceRoot(args);
  const worker = readWorkerConfig();
  const tokens = readTokens(root);
  const stateDir = workspaceStateDir(root);

  if (!tokens) {
    console.log("Not provisioned — nothing to remove.");
    return;
  }

  if (!args.yes) {
    console.log("This would:");
    console.log("  - stop the local bridge for this workspace, if running");
    if (!args["keep-remote"]) {
      console.log(
        `  - permanently wipe workspace_id=${tokens.workspaceId} on the Worker (tokens + queue) — its Server URL 404s immediately, and this cannot be undone`
      );
    } else {
      console.log(`  - leave workspace_id=${tokens.workspaceId} untouched on the Worker (--keep-remote)`);
    }
    console.log(`  - delete local state: ${stateDir}`);
    console.log("Re-run with --yes to actually do this.");
    return;
  }

  const pidCheck = checkPid(root);
  if (pidCheck.status === "alive") {
    try {
      process.kill(pidCheck.info.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }

  if (!args["keep-remote"]) {
    if (!worker) {
      console.error("No worker.json found — cannot reach the Worker to deprovision. Removing local state only.");
    } else {
      const result = await adminCall(worker, "deprovision", { workspace_id: tokens.workspaceId });
      if (result.error) {
        console.error(`Warning: remote deprovision failed (${result.error}). Removing local state anyway.`);
      } else {
        console.log(`Wiped workspace_id=${tokens.workspaceId} on the Worker.`);
      }
    }
  } else if (worker) {
    const check = await ensureRemoteSettingsBeforeKeepRemote(worker, {
      workerUrl: worker.workerUrl,
      adminToken: worker.adminToken,
      ...tokens,
      workspacePath: root,
    });
    if (!check.ok) {
      console.error(`Error: ${check.error}. Aborting.`);
      process.exit(1);
    }
  }
  if (worker) {
    const unregistered = await adminCall(worker, "unregister_workspace", { workspace_id: tokens.workspaceId });
    if (unregistered.error) console.error(`Warning: shared connector cleanup failed (${unregistered.error}).`);
  }

  if (worker) {
    updateWorkerConfigAtomic((current) => withoutWorkspaceChatSettings(current, tokens.workspaceId));
  }
  removeWorkspaceStateDir(root);
  console.log("Removed.");
}
