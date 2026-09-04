import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SQLITE_BUSY_TIMEOUT_MS } from './busy.js'

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
  // EFS lock/fsync can exceed a few seconds; sqlite retries internally up to this timeout
  // before throwing SQLITE_BUSY. Application-level retries sit on top (see withBusyRetry).
  db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`)
  return db
}
