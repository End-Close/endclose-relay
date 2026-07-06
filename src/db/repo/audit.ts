import type { Db } from '../db.js'

export class AuditRepo {
  constructor(private db: Db) {}

  // detail must be metadata only — payloads never pass through here.
  log(actor: string, action: string, detail: Record<string, string | number | boolean | null>): void {
    this.db
      .prepare('INSERT INTO audit_log (at, actor, action, detail_json) VALUES (?, ?, ?, ?)')
      .run(new Date().toISOString(), actor, action, JSON.stringify(detail))
  }
}
