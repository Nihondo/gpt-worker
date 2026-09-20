import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  appendLog,
  checkPid,
  listProvisionedWorkspaces,
  logFilePaths,
  readLogTail,
  removePidFile,
  writePidFile,
} from "./state.mjs";
import { BridgeLink } from "./link.mjs";
import { verifyScanner } from "./scanner.mjs";
import { nudgeChatGpt } from "./chat-nudge.mjs";
import {
  WorkerCallError,
  WorkerUnreachableError,
  localCall,
  migrateLegacyStateIfNeeded,
  remoteActiveState,
  requireWorkspaceConfig,
  workspaceRoot,
} from "./cli-runtime.mjs";
import { loadChatSettings } from "./cli-browser.mjs";
import { effectiveChatUrl, workspaceConversationUrl } from "./chat-nudge.mjs";

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
    appendLog(root, `daemon start refused: secret scanner check failed: ${String(err.message || err).split("\n")[0]}`);
    console.error(String(err.message || err));
    process.exit(1);
  }

  if (args.__daemon) {
    // Internal: this is the detached process itself.
    writePidFile(root, { workspace: root, alwaysAllow: !!args["always-allow"] });
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
      appendLog(root, `daemon stopping on SIGTERM (pid ${process.pid})`);
      link.stop();
      removePidFile(root);
      process.exit(0);
    });
    process.on("uncaughtException", (err) => {
      // Do not put arbitrary exception messages in the log: a thrown error
      // can carry a tool response, and logs deliberately never retain bodies.
      appendLog(root, `daemon uncaughtException: ${err?.name || "Error"}`);
      link.stop();
      removePidFile(root);
      process.exit(1);
    });
    process.on("unhandledRejection", (reason) => {
      appendLog(root, `daemon unhandledRejection: ${reason?.name || "Error"}`);
      link.stop();
      removePidFile(root);
      process.exit(1);
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
  child.once("error", (err) => appendLog(root, `daemon spawn failed: ${String(err.message || err)}`));
  child.unref();
  appendLog(root, `daemon spawn requested (pid ${child.pid ?? "unknown"}, always_allow=${!!args["always-allow"]})`);
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
    appendLog(root, `stop requested for daemon pid ${pidCheck.info.pid}`);
    process.kill(pidCheck.info.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  await sleep(500);
  removePidFile(root);
  console.log("Stopped.");
}

function formatTimestamp(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : "(unknown)";
}

function formatWindow(taskWindow) {
  if (!taskWindow) return "window info unavailable (older Worker)";
  if (taskWindow.state === "none") return "no active read window";
  if (!Number.isFinite(taskWindow.expiresAt)) return `${taskWindow.state} (expiry unavailable)`;
  const remainingMs = taskWindow.expiresAt - Date.now();
  const remaining = remainingMs <= 0 ? "expired" : `${Math.ceil(remainingMs / 1000)}s remaining`;
  return `${taskWindow.state}; expires ${formatTimestamp(taskWindow.expiresAt)} (${remaining})`;
}

function readGateStatus(pidCheck) {
  if (pidCheck.status !== "alive") return "unknown (bridge not running)";
  if (pidCheck.info?.alwaysAllow === true) return "DISABLED (--always-allow)";
  if (pidCheck.info && !Object.hasOwn(pidCheck.info, "alwaysAllow")) return "unknown (older bridge pid file)";
  return "ENABLED";
}

function printChatStatus(settings, workspaceId) {
  const project = effectiveChatUrl(settings, workspaceId);
  const conversation = workspaceConversationUrl(settings, workspaceId, project);
  if (!project) {
    console.log("chat        : unbound");
    return;
  }
  console.log(`chat        : bound\n  project     : ${project}\n  conversation: ${conversation || "(none)"}`);
}

/** Show local bridge diagnostics without requiring the Worker to be online. */
export async function cmdLogs(args) {
  const lines = args.n === undefined ? 50 : Number.parseInt(args.n, 10);
  if (!Number.isInteger(lines) || lines < 1 || lines > 10_000) {
    console.error("Invalid -n: use an integer between 1 and 10000.");
    process.exit(1);
  }
  const roots = args.all
    ? listProvisionedWorkspaces().map((workspace) => ({ root: workspace.workspacePath || workspace.stateDir, label: workspace.workspacePath || workspace.stateDir }))
    : [{ root: workspaceRoot(args), label: null }];
  if (roots.length === 0) {
    console.log("No provisioned workspaces have local logs.");
    return;
  }
  for (const { root, label } of roots) {
    const paths = logFilePaths(root);
    if (args.path) {
      if (label) console.log(`${label}:`);
      console.log(paths.current);
      console.log(paths.previous);
      continue;
    }
    const text = readLogTail(root, lines);
    if (label) console.log(`== ${label} ==`);
    process.stdout.write(text || "(no log entries)\n");
  }
}

export async function cmdStatus(args) {
  const root = workspaceRoot(args);
  const cfg = requireWorkspaceConfig(root);
  const pidCheck = checkPid(root);
  console.log(`workspace   : ${root}`);
  console.log(`local process: ${pidCheck.status}${pidCheck.info ? ` (pid ${pidCheck.info.pid})` : ""}`);
  console.log(`read gate   : ${readGateStatus(pidCheck)}`);
  console.log(`log         : ${logFilePaths(root).current}`);
  try {
    const scanner = verifyScanner();
    console.log(`secret scan : ${scanner.bin} ${scanner.version}${scanner.ruleCount ? ` (${scanner.ruleCount} rules)` : ""}`);
  } catch (err) {
    console.log(`secret scan : NOT WORKING — ${String(err.message || err).split("\n")[0]}`);
  }
  try {
    printChatStatus(await loadChatSettings(cfg), cfg.workspaceId);
  } catch {
    console.log("chat        : unavailable");
  }
  try {
    await migrateLegacyStateIfNeeded(root, cfg);
  } catch (err) {
    console.log(`migration   : failed — ${err.message || err}`);
  }
  try {
    const remote = await localCall(cfg, "status");
    if (remote.error) throw new WorkerCallError(remote.error);
    const { task, taskWindow } = await remoteActiveState(cfg);
    console.log(`worker link : ${remote.connected ? "connected" : "not connected"}`);
    console.log(`queue       : to_gpt=${remote.pendingToGpt} to_local=${remote.pendingToLocal}`);
    console.log(`task        : ${task ? task.taskId : "(none)"}`);
    if (task) {
      console.log(`iteration   : ${task.iteration}`);
      console.log(`state       : ${task.protocolState}`);
      console.log(`waiting for : ${task.waitingFor}`);
      console.log(`started     : ${formatTimestamp(task.taskStartedAt)}`);
      console.log(`last change : ${formatTimestamp(task.updatedAt)}`);
      console.log(`read window : ${formatWindow(taskWindow)}`);
    }
    try {
      const limit = await localCall(cfg, "max_body_bytes_get");
      if (limit.error) throw new WorkerCallError(limit.error);
      console.log(`body limit  : ${limit.maxBodyBytes} bytes (range ${limit.floor}–${limit.ceiling})`);
    } catch {
      console.log("body limit  : (unknown)");
    }
  } catch (err) {
    if (err instanceof WorkerUnreachableError) console.log(`worker link : UNREACHABLE — ${err.message}`);
    else if (err instanceof WorkerCallError) console.log(`worker link : error ${err.code}`);
    else console.log(`worker link : error ${err.message || err}`);
    console.log("task        : (unknown — the Worker is the only source of task state)");
  }
}
