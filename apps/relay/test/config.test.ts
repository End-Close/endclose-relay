import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config/load.js'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
// relay.example.yaml is the customer-facing seed and ships from the repo root.
const ROOT = join(APP, '..', '..')

describe('shipped configs stay parseable', () => {
  // These files are the customer-facing contract: a schema change that breaks them
  // would break existing deployments on update.
  it('relay.example.yaml', () => {
    const loaded = parseConfig(readFileSync(join(ROOT, 'relay.example.yaml'), 'utf8'))
    expect(loaded.config.routes.map((r) => r.id)).toEqual(['payabli-settlements', 'payabli-batches'])
  })

  it('rejects unknown top-level sections — the document is routes only', () => {
    const withExtras = `
endclose:
  base_url: https://api-staging.endclose.com/v1
` + readFileSync(join(APP, 'dev/relay.dev.yaml'), 'utf8')
    expect(() => parseConfig(withExtras)).toThrow(/[Uu]nrecognized/)
  })

  it('dev/relay.dev.yaml', () => {
    const { config } = parseConfig(readFileSync(join(APP, 'dev/relay.dev.yaml'), 'utf8'))
    expect(config.routes).toHaveLength(2)
  })

  it('rejects duplicate route ids', () => {
    const yaml = readFileSync(join(APP, 'dev/relay.dev.yaml'), 'utf8')
    const dup = yaml + yaml.slice(yaml.indexOf('routes:') + 'routes:'.length)
    expect(() => parseConfig(dup)).toThrow()
  })
})
