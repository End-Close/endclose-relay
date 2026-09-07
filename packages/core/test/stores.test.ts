import { describeEventStoreContract } from '@end-close/relay-store-contract'
import { MemoryEventStore } from '../src/index.js'

describeEventStoreContract('memory', () => new MemoryEventStore())
