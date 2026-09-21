// BridgeDO's SQLite schema bootstrap, extracted verbatim from the
// constructor (see worker/src/index.js's BridgeDO). Pure DDL/migration
// logic against the sql capability only — no ctx/env, no alarm setup, no
// other runtime lifecycle work, which stays in the BridgeDO constructor.
//
// Initialization order is load-bearing and must not change: the msgs.title
// backfill (needsMsgTitleBackfill) depends on both msgs.title and
// tasks.title already existing, so it must run after both ALTER TABLE
// migrations below, not merged into either one. See
// docs/plans/pending/worker-cli-dashboard-modularization-phase0-map.md
// §12.1 for the full inventory this function preserves.
function initializeBridgeSchema(sql) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS msgs (
      message_id  TEXT PRIMARY KEY,
      dir         TEXT NOT NULL,       -- 'to_gpt' | 'to_local'
      task_id     TEXT NOT NULL,
      iteration   INTEGER NOT NULL,
      kind        TEXT NOT NULL,       -- INIT/EXECUTED/PLAN/DONE/BLOCKED
      title       TEXT,
      body        TEXT NOT NULL,
      state       TEXT NOT NULL,       -- 'pending' | 'leased' | 'acked'
      lease_until INTEGER,
      created_at  INTEGER NOT NULL
    )
  `);
  // Existing Durable Objects already have the pre-title `msgs` table.
  const msgColumns = sql.exec(`PRAGMA table_info('msgs')`).toArray();
  let needsMsgTitleBackfill = false;
  if (!msgColumns.some((column) => column.name === "title")) {
    sql.exec(`ALTER TABLE msgs ADD COLUMN title TEXT`);
    needsMsgTitleBackfill = true;
  }
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_q ON msgs(dir, state, created_at)`);

  // Workflow state is deliberately separate from the delivery queue. Queue
  // rows are short-lived transport records; tasks are the durable source of
  // truth that a new local bridge uses to resume after a restart.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_id          TEXT PRIMARY KEY,
      goal             TEXT NOT NULL,
      title            TEXT,
      iteration        INTEGER NOT NULL,
      protocol_state   TEXT NOT NULL,
      waiting_for      TEXT NOT NULL,
      task_started_at  INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      terminal_summary TEXT
    )
  `);
  // Existing Durable Objects already have the pre-title `tasks` table.
  // SQLite's CREATE TABLE IF NOT EXISTS does not add columns, so migrate
  // only those instances. Old rows intentionally remain NULL and use the
  // goal preview fallback in every read surface.
  const taskColumns = sql.exec(`PRAGMA table_info('tasks')`).toArray();
  if (!taskColumns.some((column) => column.name === "title")) {
    sql.exec(`ALTER TABLE tasks ADD COLUMN title TEXT`);
  }
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(protocol_state, updated_at DESC)`);

  // Backfill INIT messages from tasks.title only after both msgs.title and
  // tasks.title are guaranteed to exist, protecting direct upgrades from
  // dormant DO instances that lacked title in both tables.
  if (needsMsgTitleBackfill) {
    sql.exec(`
      UPDATE msgs
      SET title = (SELECT title FROM tasks WHERE tasks.task_id = msgs.task_id)
      WHERE kind = 'INIT' AND title IS NULL AND (SELECT title FROM tasks WHERE tasks.task_id = msgs.task_id) IS NOT NULL
    `);
  }

  // Non-secret, Workspace-scoped preferences. Keeping these here avoids
  // using state.json as an accidental second task-state store. Secrets stay
  // in the dedicated secrets table above.
  sql.exec(`CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);

  // This instance's own gpt/link/cli tokens (one workspace = one DO = one
  // row per key here). Set once via /admin's provision or migrate_default;
  // never a Worker Secret, since a Worker Secret is shared by every
  // workspace's DO instance and these must not be.
  sql.exec(`CREATE TABLE IF NOT EXISTS secrets (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);

  // OAuth 2.1 resource-server state (Phase 2 of
  // docs/plans/oauth-mcp-authentication.md). Raw codes/tokens are never
  // stored — only their SHA-256 hash — and the raw value is returned to
  // the caller exactly once, at issuance time.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
      code_hash      TEXT PRIMARY KEY,
      client_id      TEXT NOT NULL,
      redirect_uri   TEXT NOT NULL,
      resource       TEXT NOT NULL,
      scope          TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      expires_at     INTEGER NOT NULL,
      created_at     INTEGER NOT NULL
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS oauth_access_tokens (
      token_hash  TEXT PRIMARY KEY,
      client_id   TEXT NOT NULL,
      resource    TEXT NOT NULL,
      scope       TEXT NOT NULL,
      family_id   TEXT NOT NULL,
      expires_at  INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      revoked_at  INTEGER
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_oauth_access_family ON oauth_access_tokens(family_id)`);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
      token_hash  TEXT PRIMARY KEY,
      family_id   TEXT NOT NULL,
      client_id   TEXT NOT NULL,
      resource    TEXT NOT NULL,
      scope       TEXT NOT NULL,
      expires_at  INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      used_at     INTEGER,
      revoked_at  INTEGER
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_oauth_refresh_family ON oauth_refresh_tokens(family_id)`);

  // Dynamic Client Registration records (Phase 3). Public clients only —
  // no client secret, since this Worker authenticates the resource owner
  // (see checkResourceOwnerToken), not the OAuth client itself.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id                  TEXT PRIMARY KEY,
      redirect_uris_json         TEXT NOT NULL,
      token_endpoint_auth_method TEXT NOT NULL,
      client_name                TEXT,
      created_at                 INTEGER NOT NULL
    )
  `);

  // Used only by the dedicated hub Durable Object. Keeping the registry in
  // the same class makes it easy to evolve without another Worker binding;
  // individual workspace instances simply leave this table empty.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS workspace_registry (
      workspace_id TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      registered_at INTEGER NOT NULL
    )
  `);

  // Web dashboard sessions (docs/plans/queue-dashboard.md). Deliberately a
  // separate table from `secrets`: this holds short-lived, hashed,
  // revocable session tokens issued *after* a one-time owner-token login
  // (see checkResourceOwnerToken / createDashboardSession), never the
  // owner token itself. Swept by alarm() (expired rows), deprovision()
  // (all rows) and rotateSecret("gpt_token") (all rows, since a leaked
  // owner token rotation should also cut off dashboard sessions already
  // issued under the old value).
  sql.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_sessions (
      session_hash TEXT PRIMARY KEY,
      expires_at   INTEGER NOT NULL,
      created_at   INTEGER NOT NULL
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_expiry ON dashboard_sessions(expires_at)`);

  // Keyset-pagination index for the dashboard's message/task history APIs
  // (§"pagination の API 契約", U4) — the existing idx_q/idx_tasks_active
  // indices are shaped for the live queue/active-task lookups, not a
  // direction-agnostic, all-states history scan ordered by
  // (created_at/updated_at, tie-breaker id).
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_msgs_history ON msgs(created_at DESC, message_id DESC)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_msgs_task_history ON msgs(task_id, created_at DESC, message_id DESC)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_history ON tasks(updated_at DESC, task_id DESC)`);

  // MCP access history (the dashboard's "MCP Access" tab): one row of *metadata*
  // per MCP tool call — never its content. Deliberately not a column set on
  // msgs/tasks: it has a different transport, retention (7 days / a row cap) and
  // privacy contract. What a row may contain is decided in
  // worker-mcp-access.js; the columns here are the closed set it fills.
  // event_id is an INTEGER PRIMARY KEY (the rowid), which is what lets the cap be
  // enforced with a cheap primary-key range delete instead of a COUNT/OFFSET scan.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS mcp_access_events (
      event_id     INTEGER PRIMARY KEY,
      started_at   INTEGER NOT NULL,
      duration_ms  INTEGER NOT NULL,
      tool_name    TEXT NOT NULL,
      connector    TEXT NOT NULL,       -- 'dedicated' | 'shared'
      task_id      TEXT,
      target       TEXT,
      outcome      TEXT NOT NULL,       -- success | gate_denied | access_denied | error | mixed
      outcome_code TEXT,
      detail_json  TEXT
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_access_history ON mcp_access_events(started_at DESC, event_id DESC)`);
}

export { initializeBridgeSchema };
