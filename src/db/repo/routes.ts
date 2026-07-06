import type { Db } from '../db.js'
import type { RouteConfig } from '../../config/schema.js'

export interface RouteRow {
  id: string
  source: string
  paused: number
  config_json: string
  updated_at: string
}

export class RoutesRepo {
  constructor(private db: Db) {}

  upsertAll(routes: RouteConfig[]): void {
    const now = new Date().toISOString()
    const upsert = this.db.prepare(
      `INSERT INTO routes (id, source, paused, config_json, updated_at)
       VALUES (?, ?, 0, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         source = excluded.source, config_json = excluded.config_json, updated_at = excluded.updated_at`,
    )
    const removeMissing = this.db.prepare(
      `DELETE FROM routes WHERE id NOT IN (${routes.map(() => '?').join(',') || "''"})`,
    )
    const tx = this.db.transaction(() => {
      for (const r of routes) upsert.run(r.id, r.source, JSON.stringify(r), now)
      removeMissing.run(...routes.map((r) => r.id))
    })
    tx()
  }

  get(id: string): RouteConfig | undefined {
    const row = this.db.prepare('SELECT * FROM routes WHERE id = ?').get(id) as
      | RouteRow
      | undefined
    return row ? (JSON.parse(row.config_json) as RouteConfig) : undefined
  }

  isPaused(id: string): boolean {
    const row = this.db.prepare('SELECT paused FROM routes WHERE id = ?').get(id) as
      | { paused: number }
      | undefined
    return row ? row.paused === 1 : false
  }

  setPaused(id: string, paused: boolean): void {
    this.db
      .prepare('UPDATE routes SET paused = ?, updated_at = ? WHERE id = ?')
      .run(paused ? 1 : 0, new Date().toISOString(), id)
  }

  all(): RouteConfig[] {
    const rows = this.db.prepare('SELECT * FROM routes').all() as RouteRow[]
    return rows.map((r) => JSON.parse(r.config_json) as RouteConfig)
  }
}
