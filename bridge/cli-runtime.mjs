import fs from "node:fs";
import { readWorkerConfig, workerConfigPath, readTokens, readState, clearLegacyState, readGuidance, clearGuidance } from "./state.mjs";

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") && argv[i + 1] !== "-w") out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else if (a === "-w" && argv[i + 1]) out.workspace = argv[++i];
    else out._.push(a);
  }
  return out;
}

export function workspaceRoot(args) {
  return fs.realpathSync(args.workspace || process.cwd());
}

export function requireWorkspaceConfig(root) {
  const worker = readWorkerConfig();
  if (!worker) {
    console.error(`Not initialized. Run: gpt-worker init -w ${root}  (config path: ${workerConfigPath()})`);
    process.exit(1);
  }
  const tokens = readTokens(root);
  if (!tokens) {
    console.error(`This workspace isn't provisioned yet. Run: gpt-worker init -w ${root}`);
    process.exit(1);
  }
  return { workerUrl: worker.workerUrl, adminToken: worker.adminToken, ...tokens };
}

export async function localCall(cfg, op, extra = {}) {
  const url = `${cfg.workerUrl.replace(/\/$/, "")}/local/${cfg.workspaceId}/${cfg.cliToken}`;
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, ...extra }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && !body.error) body.error = `HTTP_${res.status}`;
  return body;
}

export async function adminCall(worker, op, extra = {}) {
  const url = `${worker.workerUrl.replace(/\/$/, "")}/admin/${worker.adminToken}`;
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, ...extra }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && !body.error) body.error = `HTTP_${res.status}`;
  return body;
}

export async function remoteActiveTask(cfg) {
  const state = await localCall(cfg, "active_task");
  if (state.error) throw new Error(state.error);
  return state.task || null;
}

export async function migrateLegacyStateIfNeeded(root, cfg) {
  const legacy = readState(root);
  const settings = {};
  if (legacy && legacy.chatUrl !== undefined) settings.chatUrl = legacy.chatUrl;
  if (legacy && legacy.enterDelayMs !== undefined) settings.enterDelayMs = legacy.enterDelayMs;
  if (Object.keys(settings).length) {
    const saved = await localCall(cfg, "settings_set", settings);
    if (saved.error) throw new Error(saved.error);
  }
  if (legacy && legacy.taskId && ["WAITING_PLAN", "EXECUTING", "WAITING_REVIEW"].includes(legacy.protocolState)) {
    const migrated = await localCall(cfg, "migrate_legacy_state", legacy);
    if (migrated.error) throw new Error(migrated.error);
  }
  const legacyGuidance = readGuidance(root);
  if (legacyGuidance) {
    const migratedGuidance = await localCall(cfg, "guidance_set", { text: legacyGuidance });
    if (migratedGuidance.error) throw new Error(migratedGuidance.error);
    clearGuidance(root);
  }
  if (legacy) clearLegacyState(root);
}
