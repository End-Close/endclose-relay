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

/** Raw stored config, no validation — always readable even if the schema rejects it. */
export function readActiveConfigRaw(db: Db): { yamlText: string } | undefined {
  const row = db
    .prepare('SELECT config_yaml FROM config_versions ORDER BY id DESC LIMIT 1')
    .get() as { config_yaml: string } | undefined
  return row ? { yamlText: row.config_yaml } : undefined
}

/** Parsed active config, or undefined when there is none OR it fails validation. */
export function getActiveConfig(db: Db): LoadedConfig | undefined {
  const raw = readActiveConfigRaw(db)
  if (!raw) return undefined
  try {
    return parseConfig(raw.yamlText)
  } catch {
    return undefined
  }
}

export type ActiveConfigState =
  | { kind: 'ok'; loaded: LoadedConfig }
  | { kind: 'empty' }
  // Stored config exists but fails validation (e.g. written under an older schema).
  // The relay must NOT crash-loop on this — it boots into the setup editor instead,
  // with the stored document and the validation error, so the operator can fix it.
  | { kind: 'invalid'; error: string }

export function resolveActiveConfig(db: Db, seedPath: string | undefined): ActiveConfigState {
  const raw = readActiveConfigRaw(db)
  if (raw) {
    try {
      return { kind: 'ok', loaded: parseConfig(raw.yamlText) }
    } catch (err) {
      return { kind: 'invalid', error: (err as Error).message }
    }
  }
  if (seedPath && existsSync(seedPath)) {
    try {
      return { kind: 'ok', loaded: saveConfig(db, readFileSync(seedPath, 'utf8'), 'seed') }
    } catch (err) {
      return { kind: 'invalid', error: `seed file ${seedPath}: ${(err as Error).message}` }
    }
  }
  return { kind: 'empty' }
}

/**
 * Validate and persist a new config version, rematerializing routes. The config is
 * routes-only, and ingest/dispatch read routes from the DB — every apply is fully live.
 */
export function saveConfig(db: Db, yamlText: string, appliedBy: string): LoadedConfig {
  const loaded = parseConfig(yamlText)
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
