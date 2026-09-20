import fs from "node:fs";
import path from "node:path";
import {
  allowReadPath,
  denyReadPath,
  readAllowedReadPaths,
} from "./state.mjs";
import { WorkspaceTools } from "./tools.mjs";
import {
  localCall,
  migrateLegacyStateIfNeeded,
  requireWorkspaceConfig,
  workspaceRoot,
} from "./cli-runtime.mjs";

/** Standing planning/review guidance is owner-authenticated and stored with
 * the Workspace on the Worker, never in repository content. */
export async function cmdGuidance(args) {
  const root = workspaceRoot(args);
  const cfg = requireWorkspaceConfig(root);
  await migrateLegacyStateIfNeeded(root, cfg);
  if (args.clear) {
    const result = await localCall(cfg, "guidance_clear");
    if (result.error) throw new Error(result.error);
    console.log("Cleared.");
    return;
  }
  let text = args._[0];
  if (text === "-") {
    text = fs.readFileSync(0, "utf8"); // read all of stdin, for multi-line guidance
  }
  if (text === undefined) {
    const guidance = await localCall(cfg, "guidance_get");
    if (guidance.error) throw new Error(guidance.error);
    console.log(guidance.guidance || "(none set for this workspace)");
    return;
  }
  const result = await localCall(cfg, "guidance_set", { text });
  if (result.error) throw new Error(result.error);
  console.log("Saved. ChatGPT will see this via the workspace_guidance tool from now on.");
}

/** This workspace's `body` size cap — DO-owned (settings.max_body_bytes), not
 * a local file, per CLAUDE.md's "DO is the single source of truth" invariant.
 * Raising it mainly matters for a HANDOFF_BRIEF that outgrows the 16 KiB
 * default; every round's body still lands in the shared ChatGPT conversation
 * regardless of which side wrote it, so a larger cap is a deliberate
 * trade — a bigger body every round it's used, in exchange for reaching that
 * conversation's context ceiling sooner. */
export async function cmdLimits(args) {
  const root = workspaceRoot(args);
  const cfg = requireWorkspaceConfig(root);
  await migrateLegacyStateIfNeeded(root, cfg);

  if (args.reset) {
    const result = await localCall(cfg, "max_body_bytes_set", { maxBodyBytes: null });
    if (result.error) throw new Error(result.message || result.error);
    console.log(`Reset. Message body limit is ${result.maxBodyBytes} bytes (default).`);
    return;
  }

  const input = args._[0];
  if (input === undefined) {
    const result = await localCall(cfg, "max_body_bytes_get");
    if (result.error) throw new Error(result.message || result.error);
    console.log(`Message body limit: ${result.maxBodyBytes} bytes${result.maxBodyBytes === result.default ? " (default)" : ""}`);
    console.log(`Allowed range: ${result.floor}–${result.ceiling} bytes`);
    return;
  }

  const bytes = Number(input);
  if (!Number.isInteger(bytes)) {
    console.error("Usage: gpt-worker limits [<bytes>|--reset] [-w <dir>]");
    process.exit(1);
  }
  const result = await localCall(cfg, "max_body_bytes_set", { maxBodyBytes: bytes });
  if (result.error) throw new Error(result.message || result.error);
  console.log(`Saved. Message body limit is now ${result.maxBodyBytes} bytes.`);
}

export function allowedReadFile(root, input, { mustExist = true, allowSensitive = false } = {}) {
  if (!input) throw new Error("Usage: gpt-worker allow-read|deny-read <workspace-relative-path> [-w <dir>]");
  if (path.isAbsolute(input)) throw new Error("OUT_OF_WORKSPACE");
  const tools = new WorkspaceTools(root);
  const resolved = tools.resolve(input);
  if (resolved.error) throw new Error(resolved.error);
  if (!resolved.relPath || resolved.relPath === ".") throw new Error("A workspace-relative file path or directory path is required.");
  if (!allowSensitive && tools.ignore.isSensitive(resolved.relPath)) throw new Error("ACCESS_DENIED_SENSITIVE_FILE");
  let stat;
  try {
    stat = fs.statSync(resolved.absPath);
  } catch {
    if (mustExist) throw new Error("NOT_FOUND");
    return resolved.relPath;
  }
  if (stat.isDirectory()) {
    if (!allowSensitive && tools.ignore.isSensitive(resolved.relPath, true)) throw new Error("ACCESS_DENIED_SENSITIVE_FILE");
    return `${resolved.relPath}/`;
  }
  if (!stat.isFile()) throw new Error("Only a regular file or directory path can be allowed.");
  return resolved.relPath;
}

export const allowedReadPath = allowedReadFile;

export function cmdAllowRead(args) {
  const root = workspaceRoot(args);
  const relPath = allowedReadFile(root, args._[0]);
  allowReadPath(root, relPath);
  console.log(`Allowed direct MCP reads for ${relPath}. It remains hidden from listing and search.`);
}

export function cmdDenyRead(args) {
  const root = workspaceRoot(args);
  const relPath = allowedReadFile(root, args._[0], { mustExist: false, allowSensitive: true });
  denyReadPath(root, relPath);
  console.log(`Removed direct-read permission for ${relPath}.`);
}

export function cmdAllowList(args) {
  const paths = readAllowedReadPaths(workspaceRoot(args));
  if (paths.length === 0) {
    console.log("(no explicitly allowed paths)");
    return;
  }
  for (const relPath of paths) console.log(relPath);
}
