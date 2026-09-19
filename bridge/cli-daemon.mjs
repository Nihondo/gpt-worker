import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  appendLog,
  checkPid,
  removePidFile,
  writePidFile,
} from "./state.mjs";
import { BridgeLink } from "./link.mjs";
import { verifyScanner } from "./scanner.mjs";
import { nudgeChatGpt } from "./chat-nudge.mjs";
import {
  localCall,
  migrateLegacyStateIfNeeded,
  remoteActiveTask,
  requireWorkspaceConfig,
  workspaceRoot,
} from "./cli-runtime.mjs";
import { loadChatSettings } from "./cli-browser.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The daemon side of dashboard task creation (docs/plans/queue-dashboard.md,
 * §"新規タスク投入"): the DO has already created the task by the time this
 * fires (see BridgeDO.dashboardStartTask's callLocal push, ACKed before
 * BridgeLink invokes this — see link.mjs's dashboard_task_created branch),
 * so nothing here can or does roll that back. This only drives the same
 * best-effort browser nudge cmdTask/cmdHandoff use — via the shared
 * chat-nudge.mjs module, so behavior can never drift between the CLI and
 * dashboard paths — except that a detached daemon's stdout is discarded, so
 * `log` routes through appendLog() instead of console.log. */
async function handleDashboardTaskCreated(root, cfg, params) {
  const taskId = params && params.taskId;
  try {
    const settings = await loadChatSettings(cfg);
    await nudgeChatGpt(settings, taskId, cfg.workspaceId, {
      log: (line) => appendLog(root, `dashboard nudge: ${line}`),
      onConversationDiscovered: async (url) => {
        await localCall(cfg, "browser_settings_set", { conversationUrl: url });
      },
    });
  } catch (err) {
    appendLog(root, `dashboard nudge failed: ${String((err && err.message) || err)}`);
  }
}

export async function cmdStart(args) {
  const root = workspaceRoot(args);
  const cfg = requireWorkspaceConfig(root);

  const pidCheck = checkPid(root);
  if (pidCheck.status === "alive") {
    console.log(`Already running (pid ${pidCheck.info.pid}).`);
    return;
  }
  if (pidCheck.status === "reused" || pidCheck.status === "dead") {
    removePidFile(root);
  }

  // Every tool result this bridge sends is sanitized through a required
  // external scanner (bridge/scanner.mjs) before it reaches ChatGPT — see
  // link.mjs's reply(). There is no fallback path, so a broken or missing
  // scanner must block startup rather than surface later as silent
  // sanitize_failed errors on every tool call.
  try {
    verifyScanner();
  } catch (err) {
    console.error(String(err.message || err));
    process.exit(1);
  }

  if (args.__daemon) {
    // Internal: this is the detached process itself.
    writePidFile(root, { workspace: root });
    const link = new BridgeLink({
      workerUrl: cfg.workerUrl,
      workspaceId: cfg.workspaceId,
      linkToken: cfg.linkToken,
      workspaceRoot: root,
      alwaysAllow: !!args["always-allow"],
      onDashboardTaskCreated: (params) => handleDashboardTaskCreated(root, cfg, params),
    });
    link.start();
    process.on("SIGTERM", () => {
      link.stop();
      removePidFile(root);
      process.exit(0);
    });
    appendLog(root, `daemon started (pid ${process.pid})`);
    // Keep the event loop alive regardless of whether the WebSocket client
    // itself holds a ref — reconnects happen on their own schedule either way.
    setInterval(() => {}, 60_000);
    return;
  }

  const nodeArgs = [fileURLToPath(new URL("./cli.mjs", import.meta.url)), "start", "-w", root, "--__daemon"];
  if (args["always-allow"]) nodeArgs.push("--always-allow");
  const child = spawn(process.execPath, nodeArgs, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  console.log(`Starting in background (pid ${child.pid}). Check with: gpt-worker status`);
}

export async function cmdStop(args) {
  const root = workspaceRoot(args);
  const pidCheck = checkPid(root);
  if (pidCheck.status !== "alive") {
    removePidFile(root);
    console.log("Not running.");
    return;
  }
  try {
    process.kill(pidCheck.info.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  await sleep(500);
  removePidFile(root);
  console.log("Stopped.");
}

export async function cmdStatus(args) {
  const root = workspaceRoot(args);
  const cfg = requireWorkspaceConfig(root);
  const pidCheck = checkPid(root);
  console.log(`workspace   : ${root}`);
  console.log(`local process: ${pidCheck.status}${pidCheck.info ? ` (pid ${pidCheck.info.pid})` : ""}`);
  try {
    const scanner = verifyScanner();
    console.log(`secret scan : ${scanner.bin} ${scanner.version}${scanner.ruleCount ? ` (${scanner.ruleCount} rules)` : ""}`);
  } catch (err) {
    console.log(`secret scan : NOT WORKING — ${String(err.message || err).split("\n")[0]}`);
  }
  try {
    await migrateLegacyStateIfNeeded(root, cfg);
    const remote = await localCall(cfg, "status");
    const task = await remoteActiveTask(cfg);
    console.log(`worker link : ${remote.connected ? "connected" : "not connected"}`);
    console.log(`queue       : to_gpt=${remote.pendingToGpt} to_local=${remote.pendingToLocal}`);
    console.log(`task        : ${task ? task.taskId : "(none)"}`);
    if (task) {
      console.log(`iteration   : ${task.iteration}`);
      console.log(`state       : ${task.protocolState}`);
    }
  } catch (err) {
    console.log(`worker link : could not reach Worker (${err.message || err})`);
    console.log("task        : (none)");
  }
}

