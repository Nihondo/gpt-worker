// INIT/EXECUTED/PLAN/DONE/BLOCKED protocol + queue domain, extracted
// verbatim from BridgeDO (see worker/src/index.js). Behavior, response
// shapes, error codes, and state-transition semantics are unchanged from
// the pre-extraction implementation — this module only relocates the code.
// See reference/protocol.md for the message schemas this implements, and
// docs/plans/pending/worker-cli-dashboard-modularization-phase0-map.md §13
// for the domain dependency/capability matrix this extraction follows.
//
// Dependency direction: this module imports only the pure `byteLength`
// helper from worker-http.js. It never imports index.js or any sibling
// bridge-*.js domain module (admin/oauth/dashboard/mcp/transport) — the two
// genuine cross-domain needs (the workspace's configured body-size limit,
// and the best-effort "a PLAN/DONE/BLOCKED was just queued" push to the
// local bridge) are received as narrow capability callbacks from
// createBridgeProtocol's caller (BridgeDO's constructor) instead.

import { byteLength } from "./worker-http.js";

const POLL_MAX_MS = 20_000; // CLI long-poll budget
const LEASE_MS = 120_000; // next_task lease before it can be re-claimed
// Task titles are concise display metadata produced by the Web planning
// partner when it first receives an INIT. This fixed, code-point limit is
// deliberately independent from the per-workspace message-body limit.
const TASK_TITLE_MAX_CHARS = 80;

/** Validates and makes a title safe for compact, one-line list rendering. */
function normalizeTaskTitle(raw) {
  if (typeof raw !== "string") return null;
  const title = raw.trim().replace(/\s+/gu, " ");
  if (!title || /[\u0000-\u001f\u007f-\u009f]/u.test(title)) return null;
  return Array.from(title).length <= TASK_TITLE_MAX_CHARS ? title : null;
}

/** Derives a clean one-line fallback title from message text if no title was explicitly provided. */
function deriveMessageTitle(kind, text) {
  if (typeof text !== "string") return null;
  const lines = text.split("\n");
  let inBoilerplate = false;
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    if (/^Execution finished\.?$/i.test(line)) continue;
    if (/^\(?not run\)?\.?$/i.test(line)) continue;
    if (/^CHANGED_FILES:/i.test(line)) {
      inBoilerplate = true;
      continue;
    }
    if (/^TESTS:/i.test(line)) {
      inBoilerplate = false;
      line = line.replace(/^TESTS:\s*/i, "").trim();
      if (!line || /^\(?not run\)?\.?$/i.test(line)) continue;
    }
    if (inBoilerplate) continue;
    if (/^(GOAL|RESULT|HANDOFF|HANDOFF_BRIEF|PLAN|DONE|BLOCKED):/i.test(line)) {
      line = line.replace(/^(GOAL|RESULT|HANDOFF|HANDOFF_BRIEF|PLAN|DONE|BLOCKED):\s*/i, "").trim();
      if (!line) continue;
    }
    if (/^reason:\s*/i.test(line)) {
      line = line.replace(/^reason:\s*/i, "").trim();
      if (!line) continue;
    }
    if (/^\(?not run\)?\.?$/i.test(line)) continue;
    if (/^\(not given\)$/i.test(line)) continue;
    line = line.replace(/^[#>\s*+-]+/, "").trim();
    line = line.replace(/^[*_]{1,2}(.*?)[*_]{1,2}/, "$1").trim();
    if (!line || /^\(?not run\)?\.?$/i.test(line)) continue;
    const normalized = normalizeTaskTitle(line);
    if (normalized) return normalized;
    const chars = Array.from(line.replace(/\s+/gu, " "));
    if (chars.length > TASK_TITLE_MAX_CHARS) {
      const truncated = chars.slice(0, TASK_TITLE_MAX_CHARS - 1).join("") + "…";
      const normTrunc = normalizeTaskTitle(truncated);
      if (normTrunc) return normTrunc;
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds the protocol/queue domain's operations against a Durable Object's
 * own SQLite (`sql`) plus a small set of narrow capabilities:
 *  - maxBodyBytes(): () => number — this workspace's configured `body` size
 *    cap (owned by admin/settings; see bridge-admin.js's maxBodyBytes()).
 *  - notifyPlanPushed(messageId): best-effort push to the local bridge that
 *    a PLAN/DONE/BLOCKED message was just queued. Never authoritative — the
 *    CLI's /local poll remains the real delivery path — so a caller-side
 *    rejection here must never surface as a queueSubmit() failure.
 *  - toolOk(data) / toolError(code, message): MCP tool-result formatters,
 *    reused as-is (they are owned by bridge-mcp.js and injected by
 *    index.js) so queueSetTitle/queueSubmit keep returning the exact
 *    response shape invokeTool() already expects.
 *
 * Methods call each other through `this` (e.g. queueNext calling
 * this.getTask), which works because every call site invokes them as
 * `this.protocol.<method>(...)` from BridgeDO — a plain dot-call binds
 * `this` to the returned object itself, no class/prototype needed.
 */
function createBridgeProtocol({ sql, maxBodyBytes, notifyPlanPushed, toolOk, toolError }) {
  return {
    queueNext(taskId) {
      const now = Date.now();
      const rows = (
        typeof taskId === "string" && taskId
          ? sql.exec(
              `SELECT * FROM msgs
               WHERE dir = 'to_gpt' AND task_id = ? AND (state = 'pending' OR (state = 'leased' AND lease_until < ?))
               ORDER BY created_at ASC LIMIT 1`,
              taskId,
              now
            )
          : sql.exec(
              `SELECT * FROM msgs
               WHERE dir = 'to_gpt' AND (state = 'pending' OR (state = 'leased' AND lease_until < ?))
               ORDER BY created_at ASC LIMIT 1`,
              now
            )
      ).toArray();
      if (rows.length === 0) return { empty: true };
      const row = rows[0];
      sql.exec(`UPDATE msgs SET state = 'leased', lease_until = ? WHERE message_id = ?`, now + LEASE_MS, row.message_id);
      const task = this.getTask(row.task_id);
      return {
        empty: false,
        message_id: row.message_id,
        task_id: row.task_id,
        iteration: row.iteration,
        kind: row.kind,
        body: row.body,
        task_title: task && task.title ? task.title : null,
        title: row.title || null,
      };
    },

    /**
     * Persist the Web-generated label for a task only during the active INIT
     * lease. It intentionally does not advance protocol state, create queue
     * messages, or touch updated_at: this is presentation metadata, not a
     * PLAN/DONE/BLOCKED transition.
     */
    queueSetTitle(args) {
      const { message_id: messageId, task_id: taskId, iteration, title: rawTitle } = args || {};
      if (typeof messageId !== "string" || typeof taskId !== "string" || !Number.isInteger(iteration) || typeof rawTitle !== "string") {
        return toolError("INVALID_ARGS", "message_id, task_id, iteration and title are required");
      }
      const title = normalizeTaskTitle(rawTitle);
      if (!title) {
        return toolError("INVALID_TITLE", `title must be one non-empty line of at most ${TASK_TITLE_MAX_CHARS} characters`);
      }

      const now = Date.now();
      const messages = sql
        .exec(
          `SELECT message_id FROM msgs
           WHERE message_id = ? AND dir = 'to_gpt' AND task_id = ? AND iteration = ?
             AND kind = 'INIT' AND state = 'leased' AND lease_until >= ?`,
          messageId,
          taskId,
          iteration,
          now
        )
        .toArray();
      const task = this.getTask(taskId);
      if (
        messages.length === 0 ||
        !task ||
        task.iteration !== iteration ||
        iteration !== 0 ||
        task.protocol_state !== "WAITING_PLAN"
      ) {
        return toolError("NO_MATCHING_TASK", `No current INIT lease for task_id=${taskId} iteration=${iteration}`);
      }

      if (task.title) {
        if (task.title === title) {
          sql.exec(`UPDATE msgs SET title = ? WHERE message_id = ? AND title IS NULL`, task.title, messageId);
          return toolOk({ title: task.title, idempotent: true });
        }
        return toolError("TITLE_ALREADY_SET", "Task title is already set and cannot be replaced");
      }
      sql.exec(`UPDATE tasks SET title = ? WHERE task_id = ?`, title, taskId);
      sql.exec(`UPDATE msgs SET title = ? WHERE message_id = ?`, title, messageId);
      return toolOk({ title, idempotent: false });
    },

    queueSubmit(args) {
      const { task_id, iteration, state, body, title: rawTitle } = args || {};
      if (
        typeof task_id !== "string" ||
        typeof iteration !== "number" ||
        !["PLAN", "DONE", "BLOCKED"].includes(state) ||
        typeof body !== "string"
      ) {
        return toolError("INVALID_ARGS", "task_id, iteration, state and body are required");
      }
      const bodyLimit = maxBodyBytes();
      if (byteLength(body) > bodyLimit) {
        return toolError("BODY_TOO_LARGE", `body exceeds ${bodyLimit} bytes (raise it with: gpt-worker limits <bytes>)`);
      }

      const matches = sql
        .exec(
          `SELECT message_id FROM msgs WHERE dir = 'to_gpt' AND task_id = ? AND iteration = ? AND state != 'acked'`,
          task_id,
          iteration
        )
        .toArray();
      if (matches.length === 0) {
        return toolError("NO_MATCHING_TASK", `No open INIT/EXECUTED for task_id=${task_id} iteration=${iteration}`);
      }
      const task = this.getTask(task_id);
      if (
        !task ||
        ["DONE", "BLOCKED"].includes(task.protocol_state) ||
        !["WAITING_PLAN", "WAITING_REVIEW"].includes(task.protocol_state) ||
        task.iteration !== iteration
      ) {
        return toolError("NO_MATCHING_TASK", `No active task for task_id=${task_id} iteration=${iteration}`);
      }
      let explicitTitle = null;
      if (rawTitle !== undefined && rawTitle !== null) {
        explicitTitle = normalizeTaskTitle(rawTitle);
        if (!explicitTitle) {
          return toolError("INVALID_TITLE", "Title must be non-empty and at most 80 characters without control characters.");
        }
      }
      for (const m of matches) {
        sql.exec(`UPDATE msgs SET state = 'acked' WHERE message_id = ?`, m.message_id);
      }

      const now = Date.now();
      const waitingFor = state === "PLAN" ? "LOCAL_PLAN_ACK" : state === "DONE" ? "LOCAL_DONE_ACK" : "LOCAL_BLOCKED_ACK";
      sql.exec(
        `UPDATE tasks
         SET protocol_state = 'WAITING_LOCAL', waiting_for = ?, terminal_summary = ?, updated_at = ?
         WHERE task_id = ?`,
        waitingFor,
        state === "PLAN" ? null : body,
        now,
        task_id
      );

      const messageId = crypto.randomUUID();
      const title = explicitTitle || deriveMessageTitle(state, body);
      sql.exec(
        `INSERT INTO msgs (message_id, dir, task_id, iteration, kind, title, body, state, lease_until, created_at)
         VALUES (?, 'to_local', ?, ?, ?, ?, ?, 'pending', NULL, ?)`,
        messageId,
        task_id,
        iteration,
        state,
        title,
        body,
        now
      );
      // Best-effort immediate push; the CLI's /local poll (below) is the
      // authoritative delivery path and does not depend on this succeeding.
      notifyPlanPushed(messageId).catch(() => {});
      return toolOk({ message_id: messageId, title: title || null });
    },

    /** Past tasks that reached a terminal state (DONE/BLOCKED), newest first —
     *  lets GPT orient itself in a fresh conversation without depending
     *  solely on this Project's own (less reliable) memory. Lives entirely
     *  in this queue's SQLite, so unlike the workspace tools it works even
     *  while the local bridge is offline. Returns terminal tasks (DONE/BLOCKED)
     *  that have been acknowledged/finalized by the local side. */
    taskHistory(args) {
      const limit = Math.min(Math.max(Number(args && args.limit) || 20, 1), 100);
      const rows = sql
        .exec(
          `SELECT task_id, title, protocol_state, terminal_summary, updated_at FROM tasks
           WHERE protocol_state IN ('DONE', 'BLOCKED')
           ORDER BY updated_at DESC LIMIT ?`,
          limit
        )
        .toArray();
      return {
        tasks: rows.map((r) => ({
          task_id: r.task_id,
          title: r.title || null,
          outcome: r.protocol_state,
          summary: (r.terminal_summary || "").length > 500 ? r.terminal_summary.slice(0, 500) + "…" : r.terminal_summary || "",
          created_at: r.updated_at,
        })),
      };
    },

    getTask(taskId) {
      const rows = sql.exec(`SELECT * FROM tasks WHERE task_id = ?`, taskId).toArray();
      return rows.length ? rows[0] : null;
    },

    /** Wipes every queued message and task row — the protocol/queue domain's
     *  entire durable state. Used only by admin's deprovision() (via a
     *  narrow callback; see bridge-admin.js's own header comment), never
     *  called directly from outside this module otherwise. */
    clearProtocolState() {
      sql.exec(`DELETE FROM msgs`);
      sql.exec(`DELETE FROM tasks`);
    },

    activeTask() {
      const rows = sql
        .exec(`SELECT * FROM tasks WHERE protocol_state NOT IN ('DONE', 'BLOCKED') ORDER BY updated_at DESC LIMIT 1`)
        .toArray();
      return rows.length ? rows[0] : null;
    },

    taskView(task) {
      if (!task) return null;
      return {
        taskId: task.task_id,
        goal: task.goal,
        title: task.title || null,
        iteration: task.iteration,
        protocolState: task.protocol_state,
        waitingFor: task.waiting_for,
        taskStartedAt: task.task_started_at,
        updatedAt: task.updated_at,
        terminalSummary: task.terminal_summary || null,
      };
    },

    localStartTask(body) {
      const { task_id: taskId, goal, text, force, title: rawTitle } = body || {};
      if (typeof taskId !== "string" || typeof goal !== "string" || typeof text !== "string") {
        return { error: "INVALID_ARGS" };
      }
      // Preflight the one predictable, common failure mode of localEnqueue()
      // (an oversized INIT body) *before* any state mutation below — in
      // particular before a force discard BLOCKs the previous active task.
      // Doing this check only after the INSERT/discard (the original order)
      // could otherwise leave a WAITING_PLAN tasks row with zero queued INIT,
      // and — with force — also lose the previous task, which localEnqueue's
      // own idempotency check can't recover from (it would keep matching the
      // already-acked discarded row instead of inserting a fresh one). See
      // docs/plans/queue-dashboard.md's "localStartTask() の失敗時の整合性".
      if (byteLength(text) > maxBodyBytes()) return { error: "BODY_TOO_LARGE" };
      // Same reasoning, same ordering requirement: task_id is a primary key,
      // so an existing row (the current active task included — a caller can
      // pass force:true with that same task_id) would otherwise throw a raw
      // SQL constraint error out of the INSERT below, and with force could
      // discard/BLOCK the previous active task first regardless. Reject it as
      // a controlled protocol error before any mutation, not an exception
      // after one.
      if (this.getTask(taskId)) return { error: "TASK_EXISTS" };

      let title = null;
      if (rawTitle !== undefined && rawTitle !== null) {
        title = normalizeTaskTitle(rawTitle);
        if (!title) return { error: "INVALID_TITLE" };
      }

      const active = this.activeTask();
      if (active && !force) return { error: "ACTIVE_TASK", task: this.taskView(active) };
      if (active) this.localDiscardTask({ task_id: active.task_id });

      const now = Date.now();
      sql.exec(
        `INSERT INTO tasks (task_id, goal, title, iteration, protocol_state, waiting_for, task_started_at, updated_at)
         VALUES (?, ?, ?, 0, 'WAITING_PLAN', 'GPT_PLAN', ?, ?)`,
        taskId,
        goal,
        title,
        now,
        now
      );
      const queued = this.localEnqueue({ kind: "INIT", task_id: taskId, iteration: 0, body: text, title });
      if (queued.error) {
        // Belt-and-suspenders: the preflight above should make this
        // unreachable for BODY_TOO_LARGE, but any other localEnqueue failure
        // must not leave an orphaned tasks row with no queued INIT — roll it
        // back rather than leaving WAITING_PLAN wedged forever.
        sql.exec(`DELETE FROM tasks WHERE task_id = ?`, taskId);
        return queued;
      }
      return { task: this.taskView(this.getTask(taskId)), ...queued };
    },

    localReportTask(body) {
      const { task_id: taskId, changed, tests, text, title: rawTitle } = body || {};
      if (typeof taskId !== "string" || typeof text !== "string") return { error: "INVALID_ARGS" };
      const task = this.getTask(taskId);
      if (!task) return { error: "NO_ACTIVE_TASK" };
      const nextIteration = task.iteration + 1;
      if (task.protocol_state !== "EXECUTING") return { error: "INVALID_STATE", state: task.protocol_state };
      let explicitTitle = null;
      if (rawTitle !== undefined && rawTitle !== null) {
        explicitTitle = normalizeTaskTitle(rawTitle);
        if (!explicitTitle) return { error: "INVALID_TITLE" };
      }
      const title = explicitTitle || (tests && !/^\(?not run\)?\.?$/i.test(tests.trim()) ? deriveMessageTitle("EXECUTED", tests) : null);
      const queued = this.localEnqueue({ kind: "EXECUTED", task_id: taskId, iteration: nextIteration, body: text, title });
      if (queued.error) return queued;
      sql.exec(
        `UPDATE tasks SET iteration = ?, protocol_state = 'WAITING_REVIEW', waiting_for = 'GPT_REVIEW', updated_at = ? WHERE task_id = ?`,
        nextIteration,
        Date.now(),
        taskId
      );
      return { task: this.taskView(this.getTask(taskId)), changed, tests, ...queued };
    },

    localCompleteTask(body) {
      const taskId = body && typeof body.task_id === "string" ? body.task_id : null;
      if (!taskId) return { error: "INVALID_ARGS" };
      const task = this.getTask(taskId);
      if (!task) return { error: "NOT_FOUND" };
      if (task.protocol_state !== "WAITING_LOCAL" || task.waiting_for !== "LOCAL_DECISION") {
        return { error: "INVALID_STATE", state: task.protocol_state, waiting_for: task.waiting_for };
      }
      const now = Date.now();
      sql.exec(
        `UPDATE tasks SET protocol_state = 'DONE', waiting_for = 'none', updated_at = ? WHERE task_id = ?`,
        now,
        taskId
      );
      return { ok: true, task: this.taskView(this.getTask(taskId)) };
    },

    localContinueTask(body) {
      const taskId = body && typeof body.task_id === "string" ? body.task_id : null;
      if (!taskId) return { error: "INVALID_ARGS" };
      const task = this.getTask(taskId);
      if (!task) return { error: "NOT_FOUND" };
      if (task.protocol_state !== "WAITING_LOCAL" || task.waiting_for !== "LOCAL_DECISION") {
        return { error: "INVALID_STATE", state: task.protocol_state, waiting_for: task.waiting_for };
      }
      const now = Date.now();
      sql.exec(
        `UPDATE tasks SET protocol_state = 'EXECUTING', waiting_for = 'none', terminal_summary = NULL, updated_at = ? WHERE task_id = ?`,
        now,
        taskId
      );
      return { ok: true, task: this.taskView(this.getTask(taskId)) };
    },

    /** Ad-hoc cleanup of one message by id, either direction — for manually
     *  clearing test/abandoned entries found via `gpt-worker queue`.
     *  Refuses messages belonging to active tasks to keep protocol state consistent;
     *  callers must use localDiscardTask() instead. */
    localDiscard(body) {
      if (typeof body?.message_id !== "string") return { error: "INVALID_ARGS" };
      const rows = sql.exec(`SELECT dir, task_id FROM msgs WHERE message_id = ?`, body.message_id).toArray();
      if (rows.length === 0) return { error: "NOT_FOUND" };
      const row = rows[0];
      const task = this.getTask(row.task_id);
      if (task && !["DONE", "BLOCKED"].includes(task.protocol_state)) {
        return {
          error: "USE_DISCARD_TASK",
          message: "This message belongs to an active task; discard the task instead to keep protocol state consistent.",
        };
      }
      sql.exec(`UPDATE msgs SET state = 'acked' WHERE message_id = ?`, body.message_id);
      return { ok: true };
    },

    /** Marks every not-yet-acked message for a task_id as acked, without
     *  requiring a matching submit_plan. Used when `gpt-worker task --force`
     *  replaces an unfinished task — otherwise the abandoned control messages
     *  would sit in the queue forever. */
    localDiscardTask(body) {
      if (typeof body.task_id !== "string") return { error: "INVALID_ARGS" };
      sql.exec(`UPDATE msgs SET state = 'acked' WHERE task_id = ? AND state != 'acked'`, body.task_id);
      sql.exec(
        `UPDATE tasks
         SET protocol_state = 'BLOCKED', waiting_for = 'none', terminal_summary = 'Task replaced or discarded locally.', updated_at = ?
         WHERE task_id = ? AND protocol_state NOT IN ('DONE', 'BLOCKED')`,
        Date.now(),
        body.task_id
      );
      return { ok: true };
    },

    /** Debug/inspection: every not-yet-acked message in both directions, oldest
     *  first, with the body truncated for display. Not used by the normal
     *  task/wait/report loop — this is what `gpt-worker queue` calls. */
    localList(body) {
      const taskId = body && typeof body.task_id === "string" ? body.task_id : null;
      const rows = (
        taskId
          ? sql.exec(`SELECT * FROM msgs WHERE state != 'acked' AND task_id = ? ORDER BY created_at ASC LIMIT 100`, taskId)
          : sql.exec(`SELECT * FROM msgs WHERE state != 'acked' ORDER BY created_at ASC LIMIT 100`)
      ).toArray();
      const now = Date.now();
      return {
        messages: rows.map((r) => ({
          message_id: r.message_id,
          dir: r.dir,
          task_id: r.task_id,
          iteration: r.iteration,
          kind: r.kind,
          title: r.title || null,
          // The DB row can say 'leased' after its lease_until has already
          // passed — queueNext() already treats that as available again, so
          // report it that way here too rather than showing a stale "leased".
          state: r.state === "leased" && r.lease_until && r.lease_until < now ? "pending" : r.state,
          created_at: r.created_at,
          body_preview: r.body.length > 200 ? r.body.slice(0, 200) + "…" : r.body,
        })),
      };
    },

    localEnqueue(body) {
      const { kind, task_id, iteration, body: text, title: rawTitle } = body;
      if (
        !["INIT", "EXECUTED"].includes(kind) ||
        typeof task_id !== "string" ||
        typeof iteration !== "number" ||
        !Number.isInteger(iteration) ||
        typeof text !== "string"
      ) {
        return { error: "INVALID_ARGS" };
      }
      // Protocol invariant (reference/protocol.md): INIT always starts a task
      // at iteration 0; every EXECUTED reports on a round that already had an
      // INIT, so it is always >= 1.
      if (kind === "INIT" && iteration !== 0) {
        return { error: "INVALID_ITERATION", message: "INIT must be iteration 0" };
      }
      if (kind === "EXECUTED" && iteration < 1) {
        return { error: "INVALID_ITERATION", message: "EXECUTED must be iteration >= 1" };
      }
      if (byteLength(text) > maxBodyBytes()) return { error: "BODY_TOO_LARGE" };

      // Kept for the narrow legacy/debug enqueue endpoint. The normal CLI path
      // uses localStartTask(), but direct INIT callers still receive a durable
      // task row instead of silently creating queue-only state.
      if (kind === "INIT" && !this.getTask(task_id)) {
        const now = Date.now();
        sql.exec(
          `INSERT INTO tasks (task_id, goal, iteration, protocol_state, waiting_for, task_started_at, updated_at)
           VALUES (?, '', 0, 'WAITING_PLAN', 'GPT_PLAN', ?, ?)`,
          task_id,
          now,
          now
        );
      }

      // Idempotent retry: a CLI retry after a dropped response (the write
      // landed but the HTTP reply didn't) must not create a second physical
      // row for the same round — reuse the existing message_id instead. This
      // check-then-insert is safe without extra locking because a Durable
      // Object runs at most one request's synchronous SQL calls at a time.
      const existing = sql
        .exec(`SELECT message_id FROM msgs WHERE dir = 'to_gpt' AND task_id = ? AND iteration = ?`, task_id, iteration)
        .toArray();
      if (existing.length > 0) return { message_id: existing[0].message_id, idempotent: true };

      let explicitTitle = null;
      if (rawTitle !== undefined && rawTitle !== null) {
        explicitTitle = normalizeTaskTitle(rawTitle);
        if (!explicitTitle) return { error: "INVALID_TITLE" };
      }

      const title = explicitTitle || deriveMessageTitle(kind, text);
      const messageId = crypto.randomUUID();
      const now = Date.now();
      sql.exec(
        `INSERT INTO msgs (message_id, dir, task_id, iteration, kind, title, body, state, lease_until, created_at)
         VALUES (?, 'to_gpt', ?, ?, ?, ?, ?, 'pending', NULL, ?)`,
        messageId,
        task_id,
        iteration,
        kind,
        title,
        text,
        now
      );
      return { message_id: messageId, title: title || null };
    },

    async localPoll(body) {
      const timeoutMs = Math.min(Math.max(Number(body.timeout_ms) || 0, 0), POLL_MAX_MS);
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const rows = sql
          .exec(`SELECT * FROM msgs WHERE dir = 'to_local' AND state != 'acked' ORDER BY created_at ASC LIMIT 20`)
          .toArray();
        if (rows.length > 0) {
          return {
            messages: rows.map((r) => ({
              message_id: r.message_id,
              task_id: r.task_id,
              iteration: r.iteration,
              kind: r.kind,
              title: r.title || null,
              body: r.body,
            })),
          };
        }
        if (Date.now() >= deadline) return { messages: [] };
        await sleep(1000);
      }
    },

    localAck(body) {
      if (!body || typeof body.message_id !== "string") return { error: "INVALID_ARGS" };
      const rows = sql
        .exec(`SELECT * FROM msgs WHERE message_id = ? AND dir = 'to_local'`, body.message_id)
        .toArray();
      if (rows.length === 0) return { ok: true };
      const msg = rows[0];
      if (msg.state !== "acked") {
        sql.exec(`UPDATE msgs SET state = 'acked' WHERE message_id = ? AND dir = 'to_local'`, body.message_id);
      }

      const task = this.getTask(msg.task_id);
      if (
        task &&
        task.protocol_state === "WAITING_LOCAL" &&
        task.iteration === msg.iteration
      ) {
        const now = Date.now();
        if (msg.kind === "PLAN" && task.waiting_for === "LOCAL_PLAN_ACK") {
          sql.exec(
            `UPDATE tasks SET protocol_state = 'EXECUTING', waiting_for = 'none', updated_at = ? WHERE task_id = ?`,
            now,
            task.task_id
          );
        } else if (msg.kind === "BLOCKED" && task.waiting_for === "LOCAL_BLOCKED_ACK") {
          sql.exec(
            `UPDATE tasks SET protocol_state = 'BLOCKED', waiting_for = 'USER', updated_at = ? WHERE task_id = ?`,
            now,
            task.task_id
          );
        } else if (msg.kind === "DONE" && task.waiting_for === "LOCAL_DONE_ACK") {
          if (msg.iteration >= 1) {
            sql.exec(
              `UPDATE tasks SET protocol_state = 'DONE', waiting_for = 'none', updated_at = ? WHERE task_id = ?`,
              now,
              task.task_id
            );
          } else {
            sql.exec(
              `UPDATE tasks SET protocol_state = 'WAITING_LOCAL', waiting_for = 'LOCAL_DECISION', updated_at = ? WHERE task_id = ?`,
              now,
              task.task_id
            );
          }
        }
      }
      return { ok: true };
    },

    localMigrateLegacyState(body) {
      const { taskId, goal, iteration, protocolState, waitingFor, taskStartedAt } = body || {};
      if (this.activeTask()) return { task: this.taskView(this.activeTask()), migrated: false };
      if (
        typeof taskId !== "string" || typeof goal !== "string" || !Number.isInteger(iteration) ||
        !["WAITING_PLAN", "EXECUTING", "WAITING_REVIEW"].includes(protocolState)
      ) return { error: "INVALID_ARGS" };
      const now = Date.now();
      sql.exec(
        `INSERT OR IGNORE INTO tasks (task_id, goal, iteration, protocol_state, waiting_for, task_started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        taskId, goal, iteration, protocolState, typeof waitingFor === "string" ? waitingFor : "none",
        Number.isFinite(taskStartedAt) ? taskStartedAt : now, now
      );
      return { task: this.taskView(this.getTask(taskId)), migrated: true };
    },

    // Read-only queries backing the Web dashboard's history/ack APIs
    // (bridge-dashboard.js). They live here — not in the dashboard module —
    // because `msgs`/`tasks` are this domain's tables; the dashboard reaches
    // them only through these purpose-fixed capabilities and keeps the
    // response shaping/cursor encoding itself. None of them mutate state.

    /** Keyset-paginated (created_at DESC, message_id DESC) message rows,
     *  acked included. Returns up to `limit + 1` raw rows so the caller can
     *  tell whether another page exists. `cursor` is an already-decoded
     *  `{ t, id }` (or null). */
    dashboardMessageRows({ taskId, cursor, includeBody, limit }) {
      const conditions = [];
      const args = [];
      if (taskId) {
        conditions.push("task_id = ?");
        args.push(taskId);
      }
      if (cursor) {
        conditions.push("(created_at < ? OR (created_at = ? AND message_id < ?))");
        args.push(cursor.t, cursor.t, cursor.id);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      return sql
        .exec(
          includeBody
            ? `SELECT message_id, dir, task_id, iteration, kind, title, body, state, lease_until, created_at FROM msgs ${where} ORDER BY created_at DESC, message_id DESC LIMIT ?`
            : `SELECT message_id, dir, task_id, iteration, kind, title, state, lease_until, created_at FROM msgs ${where} ORDER BY created_at DESC, message_id DESC LIMIT ?`,
          ...args,
          limit + 1
        )
        .toArray();
    },

    /** Keyset-paginated (updated_at DESC, task_id DESC) task rows — every
     *  protocol state, not just terminal. Returns up to `limit + 1` raw rows. */
    dashboardTaskRows({ cursor, limit }) {
      const conditions = [];
      const args = [];
      if (cursor) {
        conditions.push("(updated_at < ? OR (updated_at = ? AND task_id < ?))");
        args.push(cursor.t, cursor.t, cursor.id);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      return sql
        .exec(
          `SELECT task_id, goal, title, iteration, protocol_state, waiting_for, task_started_at, updated_at, terminal_summary FROM tasks ${where} ORDER BY updated_at DESC, task_id DESC LIMIT ?`,
          ...args,
          limit + 1
        )
        .toArray();
    },

    /** A message's direction ("to_gpt"/"to_local"), or null when no such
     *  message exists — the dashboard's ack precondition check. */
    messageDirection(messageId) {
      const rows = sql.exec(`SELECT dir FROM msgs WHERE message_id = ?`, messageId).toArray();
      return rows.length === 0 ? null : rows[0].dir;
    },

    /** Counts of not-yet-acked messages per direction — the queue half of
     *  the /local "status" answer (the connection half is transport's own
     *  state; see bridge-transport.js's localStatus()). */
    pendingMessageCounts() {
      const pendingToGpt = sql.exec(`SELECT COUNT(*) AS n FROM msgs WHERE dir='to_gpt' AND state != 'acked'`).toArray()[0].n;
      const pendingToLocal = sql.exec(`SELECT COUNT(*) AS n FROM msgs WHERE dir='to_local' AND state != 'acked'`).toArray()[0].n;
      return { pendingToGpt, pendingToLocal };
    },
  };
}

export { createBridgeProtocol };
