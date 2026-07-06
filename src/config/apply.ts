import type { Db } from '../db/db.js'
import { RoutesRepo } from '../db/repo/routes.js'
import { AuditRepo } from '../db/repo/audit.js'
import { resolveSecret, type LoadedConfig } from './load.js'

/**
 * Materialize a loaded config into the database (routes table + config_versions),
 * verifying every referenced secret env var resolves first.
 */
export function applyConfig(db: Db, loaded: LoadedConfig, appliedBy: string): void {
  const { config, yamlText, hash } = loaded
  resolveSecret(config.endclose.api_key_env)
  for (const route of config.routes) resolveSecret(route.auth.secret_env)

  const routes = new RoutesRepo(db)
  const audit = new AuditRepo(db)
  const tx = db.transaction(() => {
    routes.upsertAll(config.routes)
    const last = db
      .prepare('SELECT config_hash FROM config_versions ORDER BY id DESC LIMIT 1')
      .get() as { config_hash: string } | undefined
    if (last?.config_hash !== hash) {
      db.prepare(
        'INSERT INTO config_versions (applied_at, config_hash, config_yaml, applied_by) VALUES (?, ?, ?, ?)',
      ).run(new Date().toISOString(), hash, yamlText, appliedBy)
      audit.log(appliedBy, 'config.apply', { config_hash: hash, routes: config.routes.length })
    }
  })
  tx()
}
