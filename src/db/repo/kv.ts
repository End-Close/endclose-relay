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

  globalKillswitch(): GlobalKillswitch {
    const v = this.get('killswitch.global')
    return v === 'pause' || v === 'panic' ? v : 'none'
  }

  setGlobalKillswitch(state: GlobalKillswitch): void {
    this.set('killswitch.global', state)
  }
}
