// MCP access history domain: the durable side of the dashboard's "MCP Access"
// tab. It owns the `mcp_access_events` table — recording an event, paging
// through them, the retention sweep, and the wipe on deprovision — and nothing
// else. What an event may contain is decided by worker-mcp-access.js (pure),
// which is the only thing that builds one; this module stores what it is given
// and never sees a tool call's arguments or results.
//
// Dependency direction: imports nothing (no sibling bridge-*.js, no
// worker-*.js needed here) and touches only the `sql` capability it is handed.
// index.js constructs it and wires it to the other domains through narrow
// callbacks, like every other bridge-*.js module.
//
// Capabilities:
//  - sql: the Durable Object's SQLite (exec(...).toArray()).
//  - maxRows: the per-workspace row cap. Enforced on every insert.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const TOOL_FILTER = /^[a-z][a-z0-9_]{0,39}$/;
const OUTCOME_FILTER = new Set(["success", "gate_denied", "access_denied", "error", "mixed"]);

function createBridgeMcpAccess({ sql, maxRows }) {
  return {
    /** Stores one event and trims the table to `maxRows`.
     *
     *  One INSERT per call. The cap is kept with a primary-key range delete
     *  (`event_id <= newest - maxRows`): event_id is the rowid and only ever
     *  grows, so this needs no COUNT and no OFFSET scan, and costs nothing until
     *  the table is actually full. */
    record(event) {
      sql.exec(
        `INSERT INTO mcp_access_events (started_at, duration_ms, tool_name, connector, task_id, target, outcome, outcome_code, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        event.startedAt,
        event.durationMs,
        event.toolName,
        event.connector,
        event.taskId,
        event.target,
        event.outcome,
        event.outcomeCode,
        event.detailsJson
      );
      const newest = sql.exec(`SELECT last_insert_rowid() AS id`).toArray()[0];
      const threshold = newest && Number.isFinite(newest.id) ? newest.id - maxRows : 0;
      if (threshold > 0) sql.exec(`DELETE FROM mcp_access_events WHERE event_id <= ?`, threshold);
    },

    /** The single most recent event, or null. What a caller may take from it is
     *  the same closed-set metadata the dashboard shows (tool name, outcome, task
     *  id, times) — never a call's arguments or result. Served by the same index
     *  as the dashboard's history query. */
    latest() {
      const rows = sql
        .exec(
          `SELECT started_at, duration_ms, tool_name, outcome, task_id
           FROM mcp_access_events ORDER BY started_at DESC, event_id DESC LIMIT 1`
        )
        .toArray();
      return rows.length ? rows[0] : null;
    },

    /** Newest-first, keyset-paginated rows: (started_at DESC, event_id DESC).
     *  Returns up to `limit + 1` raw rows so the caller can tell whether there is
     *  another page. `tool` and `outcome` are validated here (the values reach
     *  SQL only as bound parameters, but a malformed filter is ignored rather
     *  than silently matching nothing). */
    dashboardRows({ cursor, limit, tool, outcome, since }) {
      const conditions = [];
      const args = [];
      // Rows past retention that the daily alarm() has not swept yet: not shown.
      if (Number.isFinite(since)) {
        conditions.push("started_at >= ?");
        args.push(since);
      }
      if (typeof tool === "string" && TOOL_FILTER.test(tool)) {
        conditions.push("tool_name = ?");
        args.push(tool);
      }
      if (typeof outcome === "string" && OUTCOME_FILTER.has(outcome)) {
        conditions.push("outcome = ?");
        args.push(outcome);
      }
      if (cursor) {
        conditions.push("(started_at < ? OR (started_at = ? AND event_id < ?))");
        args.push(cursor.t, cursor.t, cursor.id);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      return sql
        .exec(
          `SELECT event_id, started_at, duration_ms, tool_name, connector, task_id, target, outcome, outcome_code, detail_json
           FROM mcp_access_events ${where} ORDER BY started_at DESC, event_id DESC LIMIT ?`,
          ...args,
          Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT) + 1
        )
        .toArray();
    },

    /** Deletes events that started before `cutoff`. Returns how many went. */
    cleanupBefore(cutoff) {
      const res = sql.exec(`DELETE FROM mcp_access_events WHERE started_at < ?`, cutoff);
      return typeof res?.rowsWritten === "number" ? res.rowsWritten : sql.exec(`SELECT changes() AS n`).toArray()[0]?.n || 0;
    },

    /** Wipes the whole history (deprovision only — token rotation keeps it). */
    clearAll() {
      sql.exec(`DELETE FROM mcp_access_events`);
    },
  };
}

export { createBridgeMcpAccess };
