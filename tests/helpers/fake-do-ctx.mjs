// A minimal fake of the Cloudflare Durable Object runtime, just enough to
// construct and exercise the real `BridgeDO` class from worker/src/index.js
// with plain `node:test` — no Miniflare/wrangler, no npm dependencies.
//
// The queue logic under test (queueNext/queueSubmit/localEnqueue/localAck/
// localList/localDiscardTask/localDiscard) only ever touches
// `ctx.storage.sql`, so that's the one piece that needs to behave like the
// real thing — backed here by Node's built-in `node:sqlite`, which speaks
// the same "exec(query, ...bindings)" shape as Cloudflare's SqlStorage.
// WebSocket-related ctx methods are stubbed as no-ops/empty, since the
// queue tests never open a socket.

import { DatabaseSync } from "node:sqlite";

function makeFakeSql() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const rows = stmt.all(...bindings);
        return { toArray: () => rows };
      }
      stmt.run(...bindings);
      return { toArray: () => [] };
    },
  };
}

export function makeFakeCtx() {
  let alarmAt = null;
  return {
    storage: {
      sql: makeFakeSql(),
      async getAlarm() {
        return alarmAt;
      },
      async setAlarm(when) {
        alarmAt = when;
      },
    },
    async blockConcurrencyWhile(fn) {
      return fn();
    },
    getWebSockets() {
      return [];
    },
    acceptWebSocket() {
      /* not exercised by queue tests */
    },
  };
}

export function makeFakeEnv() {
  return {};
}
