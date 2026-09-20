// A throwaway HTTP server standing in for the Worker, and a runner for the real
// CLI process. Together they let a test drive `bridge/cli.mjs` end to end —
// argument parsing, retries, exit codes, stdout/stderr — without mocking
// anything inside the CLI: point GPT_WORKER_CONFIG_DIR at a worker.json whose
// workerUrl is this server and the CLI cannot tell the difference.
//
// The server runs in the *test* process, so the CLI must be run with the async
// runCli() below: a synchronous execFileSync would block the event loop the
// server needs to answer on, and deadlock.

import http from "node:http";
import { spawn } from "node:child_process";

const CLI_PATH = new URL("../../bridge/cli.mjs", import.meta.url).pathname;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Starts a server on an ephemeral port. `handler(call, req)` receives
 *  `{ path, op, body }` and returns a reply description:
 *    { status?, body?, raw?, headers?, delayMs? }  — a normal response
 *    { destroy: true }                              — drop the connection
 *    { hang: true }                                 — accept and never answer
 *  Every request is recorded in `requests`. */
export async function startFakeWorker(handler) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* not JSON */
      }
      const call = { path: req.url, op: body && body.op, body };
      requests.push(call);
      let reply;
      try {
        reply = (await handler(call, req)) || {};
      } catch {
        reply = { status: 500 };
      }
      if (reply.destroy) {
        req.socket.destroy();
        return;
      }
      if (reply.hang) return;
      if (reply.delayMs) await sleep(reply.delayMs);
      if (res.destroyed) return;
      res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...(reply.headers || {}) });
      res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    /** Requests whose op equals `op`. */
    calls(op) {
      return requests.filter((request) => request.op === op);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Runs `node bridge/cli.mjs <args>` and resolves with `{ code, stdout, stderr }`.
 *  Killed (and rejected) after `timeoutMs` so a hung CLI fails the test rather
 *  than the whole run. */
export function runCli(args, { env = {}, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI did not exit within ${timeoutMs}ms: gpt-worker ${args.join(" ")}\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
