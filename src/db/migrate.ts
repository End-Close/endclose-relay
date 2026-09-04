import { migrate as migrateStore, MIGRATIONS as STORE_MIGRATIONS, type Db, type Migration } from '@endclose/relay-sqlite'

// Appliance-owned tables. `001_init.sql` (the store package's first migration) created
// these too on databases from before the split; IF NOT EXISTS makes both paths converge.
export const APPLIANCE_MIGRATIONS: Migration[] = [
  {
    name: '001_appliance.sql',
    sql: `
CREATE TABLE IF NOT EXISTS routes (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  paused      INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config_versions (
  id          INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  config_yaml TEXT NOT NULL,
  applied_by  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
`,
  },
  {
    // Per-route pause moved from routes.paused into kv (route_paused.<id>) next to the
    // global killswitch, so the store package never touches route definitions.
    name: '003_route_pause_to_kv.sql',
    sql: `
INSERT INTO kv (key, value, updated_at)
  SELECT 'route_paused.' || id, '1', updated_at FROM routes WHERE paused = 1
  ON CONFLICT (key) DO NOTHING;
`,
  },
]

/** Apply the store's migrations and then the appliance's. */
export function migrate(db: Db): void {
  migrateStore(db, [STORE_MIGRATIONS, APPLIANCE_MIGRATIONS])
}
