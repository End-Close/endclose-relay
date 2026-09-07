# @end-close/relay-store-contract

The behavioural test suite every [`@end-close/relay`](https://www.npmjs.com/package/@end-close/relay)
`EventStore` implementation must pass. It is what `@end-close/relay-sqlite` and the built-in memory
store are tested against; a store that passes it works with the engine.

```sh
npm install --save-dev @end-close/relay-store-contract vitest
```

Peer dependencies: `@end-close/relay` (same version as this package) and `vitest >=3`. This is a
test-only package; it has no runtime use.

## Usage

```ts
// my-store.test.ts
import { describeEventStoreContract } from '@end-close/relay-store-contract'
import { MyEventStore } from './my-store.js'

describeEventStoreContract(
  'my-store',
  async () => new MyEventStore(await openFreshDb()),   // a fresh, empty store per test
  async (store) => store.close(),                       // optional cleanup
)
```

The suite exercises insert/claim/settle semantics, lease-based claiming across instances,
recovery of expired leases, parking and replay, retention pruning and the `EventStoreAdmin`
listing methods. Your store must implement both `EventStore` and `EventStoreAdmin`.

Requires Node `>=22.12`.

See [`COMPATIBILITY.md`](https://github.com/End-Close/endclose-relay/blob/main/packages/core/COMPATIBILITY.md)
for the store interfaces' stability guarantees.
