import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const pkg = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url))

// One vitest project for the whole workspace. Package names resolve to their sources so
// tests never need a build step.
export default defineConfig({
  resolve: {
    alias: {
      '@endclose/relay-store-contract': pkg('store-contract'),
      '@endclose/relay-sqlite': pkg('store-sqlite'),
      '@endclose/relay': pkg('core'),
    },
  },
  test: {
    include: ['test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    testTimeout: 15_000,
    pool: 'forks',
  },
})
