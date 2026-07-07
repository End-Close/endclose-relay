import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config/load.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('shipped configs stay parseable', () => {
  // These files are the customer-facing contract: a schema change that breaks them
  // would break existing deployments on update.
  it('relay.example.yaml', () => {
    const { config } = parseConfig(readFileSync(join(ROOT, 'relay.example.yaml'), 'utf8'))
    expect(config.routes.map((r) => r.id)).toEqual(['payabli-settlements', 'payabli-batches'])
    expect(config.endclose.base_url).toBe('https://api.endclose.com/v1')
  })

  it('dev/relay.dev.yaml', () => {
    const { config } = parseConfig(readFileSync(join(ROOT, 'dev/relay.dev.yaml'), 'utf8'))
    expect(config.routes).toHaveLength(2)
  })

  it('rejects duplicate route ids', () => {
    const yaml = readFileSync(join(ROOT, 'dev/relay.dev.yaml'), 'utf8')
    const dup = yaml + yaml.slice(yaml.indexOf('routes:') + 'routes:'.length)
    expect(() => parseConfig(dup)).toThrow()
  })
})
