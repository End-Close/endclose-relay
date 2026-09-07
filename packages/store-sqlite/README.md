# @end-close/relay-sqlite

SQLite `EventStore` and `ControlStore` for [`@end-close/relay`](https://www.npmjs.com/package/@end-close/relay).
This is the store the End Close relay application ships with: rollback journal,
`synchronous=FULL`, safe on network filesystems (EFS/NFS), migrations inlined in the package.

```sh
npm install @end-close/relay @end-close/relay-sqlite
```

Install both at the same version. `@end-close/relay` is a peer dependency; the two packages are
released together in lockstep with the relay application.

## Usage

```ts
import { createRelay } from '@end-close/relay'
import { SqliteEventStore, SqliteControlStore, openDb, migrate } from '@end-close/relay-sqlite'

const db = openDb('/var/lib/myapp/relay.db')
migrate(db)

const relay = createRelay({
  store: new SqliteEventStore(db),
  control: new SqliteControlStore(db),   // killswitch + per-route pause
  // ...routes, secrets, endclose, encryption, maskingKey — see @end-close/relay
})
```

`openDb` configures the connection (journal mode, busy timeout, foreign keys); `migrate` applies
the schema idempotently and is safe to run on every boot. Several relay instances may share one
database file; claiming is lease-based.

Requires Node `>=22.12`. Depends on `better-sqlite3`, which ships prebuilt binaries for the
common platforms.

See the [engine README](https://github.com/End-Close/endclose-relay/tree/main/packages/core#readme)
for the full embedding guide, and [`COMPATIBILITY.md`](https://github.com/End-Close/endclose-relay/blob/main/packages/core/COMPATIBILITY.md)
for what is a stable contract.
