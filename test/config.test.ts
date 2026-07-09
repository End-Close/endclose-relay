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
    const loaded = parseConfig(readFileSync(join(ROOT, 'relay.example.yaml'), 'utf8'))
    expect(loaded.config.routes.map((r) => r.id)).toEqual(['payabli-settlements', 'payabli-batches'])
    expect(loaded.warnings).toEqual([]) // shipped config carries no legacy sections
  })

  it('legacy sections are stripped with a warning, not rejected', () => {
    // A config written before the routes-only split (e.g. already stored in a deployed
    // appliance's database) must keep parsing across the upgrade.
    const legacy = `
endclose:
  base_url: https://api-staging.endclose.com/v1
ingest:
  port: 8443
` + readFileSync(join(ROOT, 'dev/relay.dev.yaml'), 'utf8')
    const loaded = parseConfig(legacy)
    expect(loaded.config.routes).toHaveLength(2)
    expect(loaded.warnings).toHaveLength(1)
    expect(loaded.warnings[0]).toContain('endclose, ingest')
    expect(loaded.warnings[0]).toContain('ENDCLOSE_BASE_URL')
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
