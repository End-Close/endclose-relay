import type { Db } from '../db.js'

export type GlobalKillswitch = 'none' | 'pause' | 'panic'

export class KvRepo {
  constructor(private db: Db) {}

  get(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, new Date().toISOString())
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key)
  }

  globalKillswitch(): GlobalKillswitch {
    const v = this.get('killswitch.global')
    return v === 'pause' || v === 'panic' ? v : 'none'
  }

  setGlobalKillswitch(state: GlobalKillswitch): void {
    this.set('killswitch.global', state)
  }

  isRoutePaused(routeId: string): boolean {
    return this.get(`route_paused.${routeId}`) === '1'
  }

  setRoutePaused(routeId: string, paused: boolean): void {
    if (paused) this.set(`route_paused.${routeId}`, '1')
    else this.delete(`route_paused.${routeId}`)
  }
}
