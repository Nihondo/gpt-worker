// Local secrets, bridge-process and detailed-output management. Workflow
// state lives in the Worker's Durable Object; nothing here is a task-state
// authority, and nothing is stored inside the workspace/repo.
//
// Machine/account-wide (one Worker deployment, shared by every workspace):
//   ~/.config/gpt-worker/worker.json                 {workerUrl, adminToken,
//                                                       hubGptToken, chatUrl, ...} (mode 600)
//
// Per workspace (one Durable Object, its own gpt/link/cli tokens):
//   ~/.local/state/gpt-worker/<slug>-<hash8>/tokens.json  {workspaceId, gptToken, linkToken, cliToken}
//   ~/.local/state/gpt-worker/<slug>-<hash8>/records/*.jsonl
//   ~/.local/state/gpt-worker/<slug>-<hash8>/bridge.log (+ .1 rotation)
//   ~/.local/state/gpt-worker/<slug>-<hash8>/bridge.pid
//   ~/.local/state/gpt-worker/<slug>-<hash8>/state.json and guidance.md
//                                                          legacy migration inputs only

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const CONFIG_DIR = path.join(os.homedir(), ".config", "gpt-worker");
const WORKER_CONFIG_PATH = path.join(CONFIG_DIR, "worker.json");
// Tests point this at a temporary directory so they never write a developer's
// real local bridge state. Production intentionally ignores it unless set.
const STATE_ROOT = process.env.GPT_WORKER_STATE_ROOT || path.join(os.homedir(), ".local", "state", "gpt-worker");
const MAX_LOG_BYTES = 10 * 1024 * 1024;

/** Every path this module manages lives under the user's own home directory
 *  and holds either secrets (config.json's tokens) or task/command content
 *  the user may not want other local accounts to read — so everything here
 *  is private by default: 0600 for files, 0700 for directories. */
function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best-effort; don't fail the caller over a chmod */
  }
}

function atomicWrite(filePath, contents, mode = 0o600) {
  ensurePrivateDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, contents, { mode });
  fs.renameSync(tmp, filePath);
}

function chmodIfExists(filePath, mode) {
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    /* doesn't exist, or not ours to touch — ignore */
  }
}

/** Self-heal permissions on every path this module knows about, including
 *  ones written before this hardening existed. Cheap and idempotent — safe
 *  to call once at the start of every CLI invocation. */
export function fixPermissions() {
  chmodIfExists(CONFIG_DIR, 0o700);
  chmodIfExists(WORKER_CONFIG_PATH, 0o600);
  chmodIfExists(STATE_ROOT, 0o700);
  let workspaceDirs;
  try {
    workspaceDirs = fs.readdirSync(STATE_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return; // STATE_ROOT doesn't exist yet — nothing to fix
  }
  for (const d of workspaceDirs) {
    const wsDir = path.join(STATE_ROOT, d.name);
    chmodIfExists(wsDir, 0o700);
    for (const f of ["tokens.json", "state.json", "guidance.md", "bridge.pid", "bridge.log", "bridge.log.1"]) {
      chmodIfExists(path.join(wsDir, f), 0o600);
    }
    const rDir = path.join(wsDir, "records");
    chmodIfExists(rDir, 0o700);
    try {
      for (const f of fs.readdirSync(rDir)) chmodIfExists(path.join(rDir, f), 0o600);
    } catch {
      /* no records directory yet */
    }
  }
}

// ---------------------------------------------------------------------------
// Worker config (machine/account-wide: one Worker URL + the admin token used
// to provision new workspaces — never a per-workspace secret).
// ---------------------------------------------------------------------------

export function readWorkerConfig() {
  try {
    return JSON.parse(fs.readFileSync(WORKER_CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

export function writeWorkerConfigAtomic(data) {
  atomicWrite(WORKER_CONFIG_PATH, JSON.stringify(data, null, 2) + "\n", 0o600);
}

export function workerConfigPath() {
  return WORKER_CONFIG_PATH;
}

// ---------------------------------------------------------------------------
// Per-workspace state directory
// ---------------------------------------------------------------------------

export function workspaceSlug(workspaceRoot) {
  const real = fs.realpathSync(workspaceRoot);
  const hash = crypto.createHash("sha256").update(real).digest("hex").slice(0, 8);
  const base = path.basename(real).replace(/[^a-zA-Z0-9._-]/g, "_") || "workspace";
  return { real, dirName: `${base}-${hash}` };
}

export function workspaceStateDir(workspaceRoot) {
  const { dirName } = workspaceSlug(workspaceRoot);
  return path.join(STATE_ROOT, dirName);
}

/** Deletes this workspace's entire local state directory (tokens, state,
 *  guidance, records, logs, pid) — used by `gpt-worker remove`. Does not
 *  touch the Worker side; the caller is expected to have already called
 *  the /admin deprovision op (or deliberately chosen to keep the remote
 *  side, via --keep-remote). */
export function removeWorkspaceStateDir(workspaceRoot) {
  try {
    fs.rmSync(workspaceStateDir(workspaceRoot), { recursive: true, force: true });
  } catch {
    /* already gone, or nothing was ever provisioned here */
  }
}

export function recordsDir(workspaceRoot) {
  return path.join(workspaceStateDir(workspaceRoot), "records");
}

function tokensFilePath(workspaceRoot) {
  return path.join(workspaceStateDir(workspaceRoot), "tokens.json");
}

/** {workspaceId, gptToken, linkToken, cliToken} for this one workspace, or
 *  null if it has never been provisioned (`gpt-worker init -w <dir>`). */
export function readTokens(workspaceRoot) {
  try {
    return JSON.parse(fs.readFileSync(tokensFilePath(workspaceRoot), "utf8"));
  } catch {
    return null;
  }
}

export function writeTokensAtomic(workspaceRoot, data) {
  atomicWrite(tokensFilePath(workspaceRoot), JSON.stringify(data, null, 2) + "\n");
}

function guidanceFilePath(workspaceRoot) {
  return path.join(workspaceStateDir(workspaceRoot), "guidance.md");
}

/** Legacy migration input for guidance that older releases kept locally. */
export function readGuidance(workspaceRoot) {
  try {
    const text = fs.readFileSync(guidanceFilePath(workspaceRoot), "utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export function clearGuidance(workspaceRoot) {
  try {
    fs.unlinkSync(guidanceFilePath(workspaceRoot));
  } catch {
    /* already gone */
  }
}

function stateFilePath(workspaceRoot) {
  return path.join(workspaceStateDir(workspaceRoot), "state.json");
}

export function readState(workspaceRoot) {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath(workspaceRoot), "utf8"));
  } catch {
    return null;
  }
}

/** Legacy migration only. Task state is now held in the Worker's tasks table;
 * this removes the old local checkpoint after it is imported successfully. */
export function clearLegacyState(workspaceRoot) {
  try {
    fs.unlinkSync(stateFilePath(workspaceRoot));
  } catch {
    /* already absent */
  }
}

// ---------------------------------------------------------------------------
// Log file (10MB rotation, 2 generations)
// ---------------------------------------------------------------------------

function logFilePath(workspaceRoot) {
  return path.join(workspaceStateDir(workspaceRoot), "bridge.log");
}

export function appendLog(workspaceRoot, line) {
  const logPath = logFilePath(workspaceRoot);
  ensurePrivateDir(path.dirname(logPath));
  try {
    const st = fs.statSync(logPath);
    if (st.size > MAX_LOG_BYTES) {
      fs.renameSync(logPath, `${logPath}.1`);
    }
  } catch {
    /* no existing log yet */
  }
  const stamp = new Date().toISOString();
  fs.appendFileSync(logPath, `[${stamp}] ${line}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// PID file with reuse guard
// ---------------------------------------------------------------------------

function pidFilePath(workspaceRoot) {
  return path.join(workspaceStateDir(workspaceRoot), "bridge.pid");
}

function processStartTime(pid) {
  try {
    // macOS/Linux: process start time as a stable fingerprint against PID reuse.
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    return out.trim() || null;
  } catch {
    return null; // process not found
  }
}

export function writePidFile(workspaceRoot, { workspace }) {
  const pid = process.pid;
  const startedAt = processStartTime(pid);
  atomicWrite(pidFilePath(workspaceRoot), JSON.stringify({ pid, startedAt, workspace }, null, 2) + "\n");
}

export function readPidFile(workspaceRoot) {
  try {
    return JSON.parse(fs.readFileSync(pidFilePath(workspaceRoot), "utf8"));
  } catch {
    return null;
  }
}

export function removePidFile(workspaceRoot) {
  try {
    fs.unlinkSync(pidFilePath(workspaceRoot));
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// Listing every locally known workspace (for `gpt-worker workspaces`)
// ---------------------------------------------------------------------------

/** Every workspace this machine has ever provisioned, from its saved
 *  tokens.json (which records the real workspace path — the state
 *  directory's own name is just a one-way hash of it, not reversible). */
export function listProvisionedWorkspaces() {
  let dirs;
  try {
    dirs = fs.readdirSync(STATE_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const out = [];
  for (const d of dirs) {
    const tokensPath = path.join(STATE_ROOT, d.name, "tokens.json");
    try {
      const tokens = JSON.parse(fs.readFileSync(tokensPath, "utf8"));
      out.push({ stateDir: path.join(STATE_ROOT, d.name), ...tokens });
    } catch {
      /* not a provisioned workspace directory (or corrupt) — skip */
    }
  }
  return out;
}

/** Returns 'alive' | 'dead' | 'reused' (pid alive but not the same process — a
 *  stale pid file from a since-recycled pid) | 'none' (no pid file). */
export function checkPid(workspaceRoot) {
  const info = readPidFile(workspaceRoot);
  if (!info) return { status: "none" };
  const currentStart = processStartTime(info.pid);
  if (currentStart === null) return { status: "dead", info };
  if (info.startedAt && currentStart !== info.startedAt) return { status: "reused", info };
  return { status: "alive", info };
}
