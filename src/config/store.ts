import { readFileSync, existsSync } from 'node:fs'
import type { Db } from '../db/db.js'
import { RoutesRepo } from '../db/repo/routes.js'
import { AuditRepo } from '../db/repo/audit.js'
import { parseConfig, resolveSecret, type LoadedConfig } from './load.js'

// The database is the source of truth for configuration: the latest config_versions row
// IS the config. A relay.yaml file is only read once — to seed an empty database on
// first boot — and is ignored afterwards; the admin UI/API is how config changes.
// Config therefore lives on the data volume and survives image redeploys and host
// re-provisioning.

export interface ConfigVersion {
  id: number
  applied_at: string
  config_hash: string
  applied_by: string
}

export function getActiveConfig(db: Db): LoadedConfig | undefined {
  const row = db
    .prepare('SELECT config_yaml FROM config_versions ORDER BY id DESC LIMIT 1')
    .get() as { config_yaml: string } | undefined
  return row ? parseConfig(row.config_yaml) : undefined
}

/**
 * Validate and persist a new config version, rematerializing routes. Route-level changes
 * take effect immediately (ingest and dispatch read routes from the DB); everything else
 * (ports, endclose block, dispatch/retention tuning) applies at next boot.
 */
export function saveConfig(db: Db, yamlText: string, appliedBy: string): LoadedConfig {
  const loaded = parseConfig(yamlText)
  resolveSecret(loaded.config.endclose.api_key_env)
  for (const route of loaded.config.routes) resolveSecret(route.auth.secret_env)

  const routes = new RoutesRepo(db)
  const audit = new AuditRepo(db)
  const tx = db.transaction(() => {
    const last = db
      .prepare('SELECT config_hash FROM config_versions ORDER BY id DESC LIMIT 1')
      .get() as { config_hash: string } | undefined
    if (last?.config_hash === loaded.hash) return
    routes.upsertAll(loaded.config.routes)
    db.prepare(
      'INSERT INTO config_versions (applied_at, config_hash, config_yaml, applied_by) VALUES (?, ?, ?, ?)',
    ).run(new Date().toISOString(), loaded.hash, yamlText, appliedBy)
    audit.log(appliedBy, 'config.apply', {
      config_hash: loaded.hash,
      routes: loaded.config.routes.length,
    })
  })
  tx()
  return loaded
}

/** First boot: seed the store from a relay.yaml if the database has no config yet. */
export function seedIfEmpty(db: Db, seedPath: string | undefined): LoadedConfig {
  const active = getActiveConfig(db)
  if (active) return active
  if (!seedPath || !existsSync(seedPath)) {
    throw new Error(
      `no configuration in the database and no seed file found` +
        (seedPath ? ` at ${seedPath}` : ` (set RELAY_CONFIG)`) +
        ` — first boot needs a relay.yaml to seed from`,
    )
  }
  return saveConfig(db, readFileSync(seedPath, 'utf8'), 'seed')
}

export function listConfigVersions(db: Db, limit = 50): ConfigVersion[] {
  return db
    .prepare(
      'SELECT id, applied_at, config_hash, applied_by FROM config_versions ORDER BY id DESC LIMIT ?',
    )
    .all(limit) as ConfigVersion[]
}

export function getConfigVersion(db: Db, id: number): (ConfigVersion & { config_yaml: string }) | undefined {
  return db.prepare('SELECT * FROM config_versions WHERE id = ?').get(id) as
    | (ConfigVersion & { config_yaml: string })
    | undefined
}
