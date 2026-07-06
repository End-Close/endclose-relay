#!/usr/bin/env node
// relayctl — local admin CLI. M1 ships `mask preview`; status/killswitch/replay land in M2.
import { readFileSync } from 'node:fs'
import { parseConfig } from '../config/load.js'
import { deriveKey } from '../crypto/keys.js'
import { mask } from '../mask/engine.js'
import type { Json } from '../mask/paths.js'

function usage(): never {
  console.error(`usage:
  relayctl mask preview --config <relay.yaml> --route <route-id> --sample <sample.json>

Runs the route's masking rules against a sample payload and prints exactly what would
leave the network (the record metadata) plus a per-field report. Output stays local.`)
  process.exit(2)
}

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`)
  const v = i >= 0 ? process.argv[i + 1] : undefined
  if (!v) usage()
  return v
}

const [, , cmd, sub] = process.argv
if (cmd !== 'mask' || sub !== 'preview') usage()

const { config } = parseConfig(readFileSync(arg('config'), 'utf8'))
const routeId = arg('route')
const route = config.routes.find((r) => r.id === routeId)
if (!route) {
  console.error(`route not found: ${routeId} (have: ${config.routes.map((r) => r.id).join(', ')})`)
  process.exit(1)
}

const sample = JSON.parse(readFileSync(arg('sample'), 'utf8')) as Json
const maskingKey = deriveKey(
  'MASKING_HMAC_KEY',
  process.env.MASKING_HMAC_KEY ?? 'preview-only-key',
)

const { output, report } = mask(route.mask, sample, maskingKey)
console.log(JSON.stringify({ route: routeId, output, report }, null, 2))
