import { describeEventStoreContract } from '@endclose/relay-store-contract'
import { MemoryEventStore } from '../src/index.js'

describeEventStoreContract('memory', () => new MemoryEventStore())
