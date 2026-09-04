import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeEventStoreContract } from './store-contract.js'
import { MemoryEventStore } from '../src/engine/memory-store.js'
import { SqliteEventStore } from '../src/db/sqlite-store.js'
import { openDb, type Db } from '../src/db/db.js'
import { migrate } from '../src/db/migrate.js'
import { noopLogger } from '../src/log.js'

describeEventStoreContract('memory', () => new MemoryEventStore())

const dbs = new Map<SqliteEventStore, Db>()
describeEventStoreContract(
  'sqlite (:memory:)',
  () => {
    const db = openDb(':memory:')
    migrate(db)
    const store = new SqliteEventStore(db, { logger: noopLogger })
    dbs.set(store, db)
    return store
  },
  (store) => {
    dbs.get(store as SqliteEventStore)?.close()
  },
)

const dirs = new Map<SqliteEventStore, string>()
describeEventStoreContract(
  'sqlite (file)',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-store-'))
    const db = openDb(join(dir, 'relay.db'))
    migrate(db)
    const store = new SqliteEventStore(db, { logger: noopLogger })
    dbs.set(store, db)
    dirs.set(store, dir)
    return store
  },
  (store) => {
    dbs.get(store as SqliteEventStore)?.close()
    const dir = dirs.get(store as SqliteEventStore)
    if (dir) rmSync(dir, { recursive: true, force: true })
  },
)
