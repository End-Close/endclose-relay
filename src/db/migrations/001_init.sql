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
