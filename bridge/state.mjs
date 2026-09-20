// Local secrets, bridge-process and detailed-output management. Workflow
// state lives in the Worker's Durable Object; nothing here is a task-state
// authority, and nothing is stored inside the workspace/repo.
//
// Machine/account-wide (one Worker deployment, shared by every workspace):
//   ~/.config/gpt-worker/worker.json                 {workerUrl, adminToken,
//                                                       hubGptToken, chatUrl,
//                                                       chatUrlsByWorkspace,
//                                                       conversationUrlsByWorkspace,
//                                                       chromeTabsByWorkspace, ...} (mode 600)
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

// Tests can isolate the machine-wide config without touching a developer's
// real connector settings. Production does not set this variable.
const CONFIG_DIR = process.env.GPT_WORKER_CONFIG_DIR || path.join(os.homedir(), ".config", "gpt-worker");
const WORKER_CONFIG_PATH = path.join(CONFIG_DIR, "worker.json");
const WORKER_CONFIG_LOCK_PATH = `${WORKER_CONFIG_PATH}.lock`;
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
  // A lock left behind by a killed process is the one thing that makes every
  // later config update fail until someone removes a file by hand — and this
  // runs at the start of every CLI invocation, so it is where that heals.
  removeStaleLock(WORKER_CONFIG_LOCK_PATH);
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
    removeStaleLock(path.join(wsDir, "tokens.json.lock"));
    for (const f of ["tokens.json", "state.json", "guidance.md", "read-allowlist.json", "read-denylist.json", "bridge.pid", "bridge.log", "bridge.log.1"]) {
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
// to provision new workspaces — never a per-workspace secret). chatUrl and
// chatUrlsByWorkspace, conversationUrlsByWorkspace and chromeTabsByWorkspace are local browser UI
// preferences, not protocol state.
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

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------------------------------------------------------------------------
// Lock files (worker.json.lock, tokens.json.lock)
//
// A lock is a file created with O_EXCL. A process killed while holding one
// (SIGKILL, power loss) never runs its `finally`, so the file outlives it — and
// without a way to tell that, every later config/token update failed with the
// same timeout until someone happened to `rm` the file. So a lock now records
// who took it, and a lock whose holder is gone is broken rather than waited on.
// ---------------------------------------------------------------------------

const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
// A critical section here is a small read-modify-write, i.e. milliseconds. A
// lock that records no holder (one written before holders were recorded, or a
// process that died between creating the file and writing its identity) can
// only be judged by age.
const STALE_LOCK_NO_HOLDER_MS = 30_000;

let ownProcessStart;
/** This process's start-time fingerprint, computed once: it is written into
 *  every lock it takes, and spawning `ps` per lock would be wasteful. */
function ownStartTime() {
  if (ownProcessStart === undefined) ownProcessStart = processStartTime(process.pid);
  return ownProcessStart;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else — still alive.
    return err?.code === "EPERM";
  }
}

/** Why `lockPath` is stale (a string), or null when it is not — including
 *  when the file is already gone. `ino` identifies the exact file inspected so
 *  a caller can refuse to delete a different lock created since. */
function inspectLock(lockPath) {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch {
    return { reason: null, ino: null };
  }
  let holder = null;
  try {
    holder = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    /* empty or half-written: no holder recorded (yet) */
  }
  if (holder && Number.isInteger(holder.pid)) {
    if (!isProcessAlive(holder.pid)) return { reason: `its holder (pid ${holder.pid}) is gone`, ino: stat.ino, holderPid: holder.pid };
    // "Alive" is not enough: the pid may have been reused. The start-time
    // fingerprint settles that, but only when there is one to compare — the
    // holder may not have been able to record it, and `ps` may fail now.
    let verified = false;
    if (holder.startedAt) {
      const now = processStartTime(holder.pid);
      if (now) {
        if (now !== holder.startedAt) {
          return { reason: `pid ${holder.pid} has been reused by another process`, ino: stat.ino, holderPid: holder.pid };
        }
        verified = true;
      }
    }
    if (!verified && Date.now() - stat.mtimeMs > STALE_LOCK_NO_HOLDER_MS) {
      // A live pid that cannot be confirmed as the same process is
      // indistinguishable from a reused one; without an age limit, a holder that
      // died and whose pid was later reused would keep the lock "held" forever.
      // A real critical section is milliseconds, so the limit that judges a
      // holder-less lock applies.
      return {
        reason: `pid ${holder.pid} is alive but its start time cannot be confirmed (none was recorded, or ps could not read it), and the lock is older than 30s`,
        ino: stat.ino,
        holderPid: holder.pid,
      };
    }
    return { reason: null, ino: stat.ino, holderPid: holder.pid };
  }
  if (Date.now() - stat.mtimeMs > STALE_LOCK_NO_HOLDER_MS) {
    return { reason: "it records no holder and is older than 30s", ino: stat.ino, holderPid: null };
  }
  return { reason: null, ino: stat.ino, holderPid: null };
}

/** Deletes `lockPath` if — and only if — it is stale. True when the way is now
 *  clear (removed, or already gone); false when the lock is live or could not
 *  be removed.
 *
 *  Residual race, stated plainly: two processes can find the same stale lock
 *  and both remove it, and the inode re-check narrows but cannot close the
 *  window between check and unlink. The worst outcome is two processes briefly
 *  believing they hold the lock, i.e. one lost update of a small JSON file
 *  (every write is temp-file + rename, so the file itself is never torn). That
 *  is preferable to failing every config update forever. */
function removeStaleLock(lockPath) {
  const inspected = inspectLock(lockPath);
  if (inspected.ino === null) return true; // already gone
  if (!inspected.reason) return false;
  try {
    if (fs.statSync(lockPath).ino !== inspected.ino) return false; // replaced since: not ours to break
    fs.unlinkSync(lockPath);
    return true;
  } catch (err) {
    return err?.code === "ENOENT";
  }
}

/** Exported for tests, which need a short `timeoutMs` to exercise the timeout
 *  path without waiting out the real 5s. Production callers use the defaults
 *  through updateWorkerConfigAtomic()/updateTokensAtomic(). */
export function acquireFileLock(lockPath, label, timeoutMs = LOCK_ACQUIRE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: ownStartTime(), createdAt: Date.now() }));
      } catch {
        /* an identity-less lock is still a valid lock; it is just judged by age */
      }
      return fd;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      if (Date.now() < deadline && removeStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        const { holderPid } = inspectLock(lockPath);
        throw new Error(
          `Timed out acquiring the gpt-worker ${label} lock (${lockPath}). ` +
            (holderPid ? `It is held by pid ${holderPid}. ` : "") +
            `If no gpt-worker process is running, remove it: rm ${lockPath}`
        );
      }
      sleepSync(10);
    }
  }
}

/** Exported for tests; see acquireFileLock(). */
export function releaseFileLock(fd, lockPath) {
  // Only remove the lock file if it is still the one *we* created: if another
  // process judged it stale and took a fresh lock meanwhile, unlinking by path
  // would delete that process's live lock.
  let ours = false;
  try {
    ours = fs.fstatSync(fd).ino === fs.statSync(lockPath).ino;
  } catch {
    /* lock already gone */
  }
  try {
    fs.closeSync(fd);
  } finally {
    if (ours) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* already cleaned up */
      }
    }
  }
}

/** Serialize small machine-wide config mutations across simultaneous CLI
 *  processes. The lock protects read-modify-write callers from replacing a
 *  tab association another workspace just added. */
export function updateWorkerConfigAtomic(update) {
  const lockFd = acquireFileLock(WORKER_CONFIG_LOCK_PATH, "config");
  try {
    const current = readWorkerConfig();
    const next = update(current);
    if (next && next !== current) writeWorkerConfigAtomic(next);
    return next;
  } finally {
    releaseFileLock(lockFd, WORKER_CONFIG_LOCK_PATH);
  }
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

function tokensLockPath(workspaceRoot) {
  return `${tokensFilePath(workspaceRoot)}.lock`;
}

export function updateTokensAtomic(workspaceRoot, update) {
  const lockFile = tokensLockPath(workspaceRoot);
  ensurePrivateDir(path.dirname(lockFile));
  const lockFd = acquireFileLock(lockFile, "tokens");
  try {
    const current = readTokens(workspaceRoot);
    const next = update(current);
    if (next && next !== current) writeTokensAtomic(workspaceRoot, next);
    return next;
  } finally {
    releaseFileLock(lockFd, lockFile);
  }
}

export function stripLegacyWorkerConfigFields({ stripHubGptToken = false, stripChatUrl = false, workspaceIdToStrip = null } = {}) {
  return updateWorkerConfigAtomic((current) => {
    if (!current) return current;
    let changed = false;
    const next = { ...current };
    if (stripHubGptToken && "hubGptToken" in next) {
      delete next.hubGptToken;
      changed = true;
    }
    if (stripChatUrl && "chatUrl" in next) {
      delete next.chatUrl;
      changed = true;
    }
    if (workspaceIdToStrip) {
      if (next.chatUrlsByWorkspace && workspaceIdToStrip in next.chatUrlsByWorkspace) {
        const nextUrls = { ...next.chatUrlsByWorkspace };
        delete nextUrls[workspaceIdToStrip];
        if (Object.keys(nextUrls).length === 0) delete next.chatUrlsByWorkspace;
        else next.chatUrlsByWorkspace = nextUrls;
        changed = true;
      }
      if (next.conversationUrlsByWorkspace && workspaceIdToStrip in next.conversationUrlsByWorkspace) {
        const nextConvs = { ...next.conversationUrlsByWorkspace };
        delete nextConvs[workspaceIdToStrip];
        if (Object.keys(nextConvs).length === 0) delete next.conversationUrlsByWorkspace;
        else next.conversationUrlsByWorkspace = nextConvs;
        changed = true;
      }
    }
    return changed ? next : current;
  });
}

export function stripLegacyWorkspaceGptToken(workspaceRoot) {
  return updateTokensAtomic(workspaceRoot, (tokens) => {
    if (!tokens || !tokens.gptToken) return tokens;
    const next = { ...tokens };
    delete next.gptToken;
    return next;
  });
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

// Owner-controlled exceptions for Git-ignored paths. This is deliberately
// outside the repository so untrusted workspace content cannot grant itself
// access. It is access policy, not task/protocol state.
function readAllowlistFilePath(workspaceRoot) {
  return path.join(workspaceStateDir(workspaceRoot), "read-allowlist.json");
}

export function readAllowedReadPaths(workspaceRoot) {
  try {
    const data = JSON.parse(fs.readFileSync(readAllowlistFilePath(workspaceRoot), "utf8"));
    return Array.isArray(data.paths) ? data.paths.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function writeAllowedReadPaths(workspaceRoot, paths) {
  atomicWrite(readAllowlistFilePath(workspaceRoot), JSON.stringify({ paths }, null, 2) + "\n");
}

export function allowReadPath(workspaceRoot, relPath) {
  const opposite = relPath.endsWith("/") ? relPath.slice(0, -1) : `${relPath}/`;
  const paths = readAllowedReadPaths(workspaceRoot).filter((p) => p !== opposite);
  if (!paths.includes(relPath)) paths.push(relPath);
  writeAllowedReadPaths(workspaceRoot, paths.sort());
}

export function unallowReadPath(workspaceRoot, relPath) {
  const stripped = relPath.endsWith("/") ? relPath.slice(0, -1) : relPath;
  const withSlash = `${stripped}/`;
  const paths = readAllowedReadPaths(workspaceRoot).filter((p) => p !== stripped && p !== withSlash);
  writeAllowedReadPaths(workspaceRoot, paths);
}

// Owner-controlled explicit read denylist. Overrides allow-read and normal
// Git-tracked reads.
function readDenylistFilePath(workspaceRoot) {
  return path.join(workspaceStateDir(workspaceRoot), "read-denylist.json");
}

export function readDeniedReadPaths(workspaceRoot) {
  const filePath = readDenylistFilePath(workspaceRoot);
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  let data;
  try {
    data = JSON.parse(content);
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${err.message}`);
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.paths)) {
    throw new Error(`Invalid denylist schema in ${filePath}: expected { paths: string[] }`);
  }
  if (!data.paths.every((p) => typeof p === "string")) {
    throw new Error(`Invalid denylist schema in ${filePath}: all paths must be strings`);
  }
  return data.paths;
}

function writeDeniedReadPaths(workspaceRoot, paths) {
  atomicWrite(readDenylistFilePath(workspaceRoot), JSON.stringify({ paths }, null, 2) + "\n");
}

export function denyReadPath(workspaceRoot, relPath) {
  const opposite = relPath.endsWith("/") ? relPath.slice(0, -1) : `${relPath}/`;
  const paths = readDeniedReadPaths(workspaceRoot).filter((p) => p !== opposite);
  if (!paths.includes(relPath)) paths.push(relPath);
  writeDeniedReadPaths(workspaceRoot, paths.sort());
}

export function undenyReadPath(workspaceRoot, relPath) {
  const stripped = relPath.endsWith("/") ? relPath.slice(0, -1) : relPath;
  const withSlash = `${stripped}/`;
  const paths = readDeniedReadPaths(workspaceRoot).filter((p) => p !== stripped && p !== withSlash);
  writeDeniedReadPaths(workspaceRoot, paths);
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

/** The state directory is durable even after a workspace was moved or removed.
 * `logs --all` must use it directly instead of re-hashing a stale path from
 * tokens.json. */
export function logFilePathsFromStateDir(stateDir) {
  const current = path.join(stateDir, "bridge.log");
  return { current, previous: `${current}.1` };
}

/** Paths for the current log and its single rotated predecessor. These are
 * intentionally available without tokens or Worker connectivity: logs remain
 * the primary local diagnostic when the Worker or bridge is unavailable. */
export function logFilePaths(workspaceRoot) {
  return logFilePathsFromStateDir(workspaceStateDir(workspaceRoot));
}

function readTailBytes(filePath, lineCount) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    const chunks = [];
    let position = size;
    let newlines = 0;
    const chunkSize = 16 * 1024;
    while (position > 0 && newlines <= lineCount) {
      const length = Math.min(chunkSize, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      fs.readSync(fd, chunk, 0, length, position);
      chunks.unshift(chunk);
      for (const byte of chunk) if (byte === 10) newlines++;
    }
    // Decode only after concatenating the raw chunks: decoding independently
    // would corrupt a multibyte UTF-8 character split at a chunk boundary.
    return Buffer.concat(chunks).toString("utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return "";
    throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Return the final `lines` log records, crossing the one retained rotation.
 * Reading starts at the end of each file so an old 10MB generation is not
 * routinely loaded just to display a few diagnostics. */
export function readLogTail(workspaceRoot, lines = 50) {
  return readLogTailFromStateDir(workspaceStateDir(workspaceRoot), lines);
}

export function readLogTailFromStateDir(stateDir, lines = 50) {
  const count = Math.max(1, Math.min(10_000, Number.parseInt(lines, 10) || 50));
  const { current, previous } = logFilePathsFromStateDir(stateDir);
  const currentText = readTailBytes(current, count);
  const currentLines = currentText.split("\n").filter(Boolean);
  if (currentLines.length >= count) return currentLines.slice(-count).join("\n") + "\n";
  const previousText = readTailBytes(previous, count - currentLines.length);
  const combined = [...previousText.split("\n").filter(Boolean), ...currentLines];
  return combined.length ? combined.slice(-count).join("\n") + "\n" : "";
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

export function writePidFile(workspaceRoot, { workspace, alwaysAllow = undefined }) {
  const pid = process.pid;
  const startedAt = processStartTime(pid);
  const data = { pid, startedAt, workspace };
  if (typeof alwaysAllow === "boolean") data.alwaysAllow = alwaysAllow;
  atomicWrite(pidFilePath(workspaceRoot), JSON.stringify(data, null, 2) + "\n");
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
