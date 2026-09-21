// Time budgets for the synchronous child processes this bridge runs, and the
// one predicate every caller needs to tell "the child ran out of time" apart
// from "the child failed".
//
// Why these exist at all: the bridge daemon is a single Node process and every
// `execFileSync` below blocks its whole event loop. A hung `git` (a stuck
// network filesystem, a lock held by another process) or `osascript` (Chrome
// sitting behind a modal dialog) therefore did not just fail one tool call —
// it froze every RPC the daemon serves, while the Worker gave up on each of
// them after its own 20s RPC_TIMEOUT_MS and the local side kept waiting.
//
// The tool budget is deliberately shorter than the Worker's 20s so the bridge
// answers with a structured error first instead of being abandoned.

// GPT_WORKER_EXEC_TIMEOUT_MS replaces every budget below with one value. It
// exists so the timeout paths can be tested in milliseconds instead of by
// waiting out the real budgets; nothing in production sets it.
function override() {
  const value = Number(process.env.GPT_WORKER_EXEC_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** git / rg run on behalf of a ChatGPT tool call (status, diff, log, search). */
export function gitTimeoutMs() {
  return override() ?? 15_000;
}

/** The per-path `git check-ignore` / `git rev-parse` probes behind the
 *  gitignore access check. Short because they run once per path. */
export function gitCheckTimeoutMs() {
  return override() ?? 5_000;
}

/** Handing a URL to the OS opener (`open` / `xdg-open`). It only spawns and
 *  returns, so anything near this long means it is stuck. */
export function openTimeoutMs() {
  return override() ?? 10_000;
}

/** `tar` packing a workspace_bundle archive. Bounded because it blocks the
 *  daemon's event loop like every other synchronous child, but generous
 *  compared with the per-path probes: it is one process over the whole tree. */
export function archiveTimeoutMs() {
  return override() ?? 30_000;
}

/** True when execFileSync killed the child because `timeout` elapsed. Node
 *  reports that as an error with code ETIMEDOUT. */
export function isExecTimeout(err) {
  return !!err && err.code === "ETIMEDOUT";
}
