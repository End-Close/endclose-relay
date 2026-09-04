import type { Db } from './db.js'

// Schema migrations, inlined so the package is bundler-friendly. Names are the keys in
// schema_migrations, so they must never change once shipped.

export interface Migration {
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    name: '001_init.sql',
    sql: `
CREATE TABLE events (
  id              INTEGER PRIMARY KEY,
  route_id        TEXT NOT NULL,
  source          TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  event_type      TEXT,
  payload_enc     BLOB NOT NULL,
  payload_iv      BLOB NOT NULL,
  headers_json    TEXT NOT NULL,
  received_at     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','retry','delivering','delivered','parked','dropped_by_filter')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  delivered_at    TEXT,
  bulk_request_id TEXT,
  last_error      TEXT,
  idempotency_key TEXT NOT NULL,
  UNIQUE (idempotency_key)
);
CREATE INDEX idx_events_dispatch ON events (status, next_attempt_at, route_id, id);
CREATE INDEX idx_events_route_status ON events (route_id, status);

CREATE TABLE routes (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  paused      INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE config_versions (
  id          INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  config_yaml TEXT NOT NULL,
  applied_by  TEXT NOT NULL
);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  detail_json TEXT NOT NULL
);

CREATE TABLE kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    // Lease-based claiming: a crashed or slow instance's rows are recoverable by others.
    name: '002_leases.sql',
    sql: `
ALTER TABLE events ADD COLUMN claimed_by TEXT;
ALTER TABLE events ADD COLUMN lease_until TEXT;
`,
  },
  {
    // Per-route pause moves from the appliance-owned routes table into kv, next to the
    // global killswitch, so the store package never touches route definitions.
    name: '003_route_pause_to_kv.sql',
    sql: `
INSERT INTO kv (key, value, updated_at)
  SELECT 'route_paused.' || id, '1', updated_at FROM routes WHERE paused = 1
  ON CONFLICT (key) DO NOTHING;
`,
  },
]

export function migrate(db: Db, sets: Migration[][] = [MIGRATIONS]): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  )
  const applied = new Set(
    db
      .prepare('SELECT name FROM schema_migrations')
      .all()
      .map((r) => (r as { name: string }).name),
  )
  for (const set of sets) {
    for (const m of set) {
      if (applied.has(m.name)) continue
      const run = db.transaction(() => {
        db.exec(m.sql)
        db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
          m.name,
          new Date().toISOString(),
        )
      })
      run()
    }
  }
}
