#!/usr/bin/env node
// relayctl — local admin CLI. M1 ships `mask preview` and `config validate`;
// status/killswitch/replay land in M2.
import { readFileSync } from 'node:fs'
import { parseConfig } from '../config/load.js'
import { deriveKey } from '../crypto/keys.js'
import { mask } from '../mask/engine.js'
import type { Json } from '../mask/paths.js'
import type { RelayConfig } from '../config/schema.js'

function usage(): never {
  console.error(`usage:
  relayctl config validate [--config <relay.yaml>]
  relayctl mask preview --route <route-id> --sample <sample.json> [--config <relay.yaml>]

config validate
  Parses and schema-checks the config, then reports whether every referenced secret
  env var is set. Run it against a new image version before approving an update:
  schema errors exit non-zero. Unset env vars are reported but don't fail validation
  (they may simply not be exported in your shell).

mask preview
  Runs the route's masking rules against a sample payload and prints exactly what
  would leave the network (the record metadata) plus a per-field report. Local only.

The config path defaults to $RELAY_CONFIG, then /etc/endclose-relay/relay.yaml.`)
  process.exit(2)
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function requireArg(name: string): string {
  const v = arg(name)
  if (!v) usage()
  return v
}

function loadCliConfig(): { config: RelayConfig; hash: string; path: string } {
  const path = arg('config') ?? process.env.RELAY_CONFIG ?? '/etc/endclose-relay/relay.yaml'
  try {
    const { config, hash } = parseConfig(readFileSync(path, 'utf8'))
    return { config, hash, path }
  } catch (err) {
    console.error(`✗ ${path}: ${(err as Error).message}`)
    process.exit(1)
  }
}

function configValidate(): void {
  const { config, hash, path } = loadCliConfig()
  console.log(`✓ ${path} is valid`)
  console.log(`  config_hash: ${hash}`)
  console.log(`  routes: ${config.routes.map((r) => `${r.id} (${r.source})`).join(', ')}`)

  const envVars = [config.endclose.api_key_env, ...config.routes.map((r) => r.auth.secret_env)]
  const required = ['RELAY_DATA_KEY', 'MASKING_HMAC_KEY', ...new Set(envVars)]
  console.log('  secret env vars:')
  for (const name of required) {
    console.log(`    ${process.env[name] ? '✓ set  ' : '○ unset'} ${name}`)
  }
}

function maskPreview(): void {
  const { config } = loadCliConfig()
  const routeId = requireArg('route')
  const route = config.routes.find((r) => r.id === routeId)
  if (!route) {
    console.error(
      `route not found: ${routeId} (have: ${config.routes.map((r) => r.id).join(', ')})`,
    )
    process.exit(1)
  }

  const sample = JSON.parse(readFileSync(requireArg('sample'), 'utf8')) as Json
  const maskingKey = deriveKey(
    'MASKING_HMAC_KEY',
    process.env.MASKING_HMAC_KEY ?? 'preview-only-key',
  )

  const { output, report } = mask(route.mask, sample, maskingKey)
  console.log(JSON.stringify({ route: routeId, output, report }, null, 2))
}

const [, , cmd, sub] = process.argv
if (cmd === 'config' && sub === 'validate') configValidate()
else if (cmd === 'mask' && sub === 'preview') maskPreview()
else usage()
