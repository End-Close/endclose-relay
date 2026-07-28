import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Db = Database.Database

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  // DELETE (rollback journal), not WAL: WAL needs shared-memory primitives that network
  // filesystems (EFS/NFS) do not provide correctly. Durability comes from synchronous=FULL
  // below — an acked webhook must survive power loss (the store-and-forward contract).
  db.pragma('journal_mode = DELETE')
  db.pragma('synchronous = FULL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  return db
}
