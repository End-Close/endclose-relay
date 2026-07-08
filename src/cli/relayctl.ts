#!/usr/bin/env node
// relayctl — local admin CLI.
//   Local (no running relay needed):  config validate, map preview
//   Against the running relay's admin API:  status, pause, resume, panic,
//     events ls, events replay, audit export, config plan, config apply
import { readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { parseConfig } from '../config/load.js'
import { deriveKey } from '../crypto/keys.js'
import { mapEvent } from '../forward/mapper.js'
import type { Json } from '../mask/paths.js'
import type { RelayConfig } from '../config/schema.js'

const ADMIN_URL = process.env.RELAY_ADMIN_URL ?? 'http://127.0.0.1:8081'

function usage(): never {
  console.error(`usage:
  relayctl status                      relay/queue/killswitch overview
  relayctl pause [--route <id>]        stop forwarding (events still buffer)
  relayctl resume [--route <id>]       resume forwarding
  relayctl panic                       refuse ingest entirely (503) and stop forwarding
  relayctl events ls [--status <s>] [--route <id>] [--limit <n>]
  relayctl events replay <id>|--parked re-queue parked events
  relayctl audit export [--limit <n>]  audit log as JSONL
  relayctl config plan                 diff relay.yaml on disk vs the running config
  relayctl config apply                apply relay.yaml on disk to the running relay
  relayctl config validate [--config <relay.yaml>]     (local)
  relayctl map preview --route <id> --sample <f.json>  (local)

Admin API: $RELAY_ADMIN_URL (default http://127.0.0.1:8081). In Docker:
  docker compose exec relay node dist/cli/relayctl.js status`)
  process.exit(2)
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

// The bin/relayctl host wrapper passes --actor with the SSH user; inside a container the
// OS username is just the service account ("relay"), which is useless in an audit trail.
const ACTOR = arg('actor') ?? `cli:${userInfo().username}`
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}
function requireArg(name: string): string {
  const v = arg(name)
  if (!v) usage()
  return v
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`${ADMIN_URL}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? null : JSON.stringify(body),
    })
  } catch {
    console.error(`✗ cannot reach the relay admin API at ${ADMIN_URL} — is the relay running?`)
    process.exit(1)
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    console.error(`✗ ${data['error'] ?? `HTTP ${res.status}`}`)
    process.exit(1)
  }
  return data
}

async function status(): Promise<void> {
  const s = (await api('GET', '/status')) as {
    version: string
    uptime_s: number
    config_hash: string | null
    killswitch: { global: string; routes_paused: string[] }
    routes: {
      id: string
      data_stream_key: string
      paused: boolean
      counts: Record<string, number>
      oldest_pending_age_s: number | null
      last_delivered_at: string | null
    }[]
    storage: { db_bytes: number }
  }
  console.log(`endclose-relay v${s.version} · up ${s.uptime_s}s · db ${(s.storage.db_bytes / 1048576).toFixed(1)} MiB`)
  console.log(`config: ${s.config_hash ?? 'none'}`)
  console.log(
    s.killswitch.global === 'none'
      ? 'killswitch: none (forwarding)'
      : `killswitch: ${s.killswitch.global.toUpperCase()}`,
  )
  for (const r of s.routes) {
    const c = r.counts
    console.log(
      `  ${r.id}${r.paused ? ' [PAUSED]' : ''} → ${r.data_stream_key}` +
        `  pending=${c['pending'] ?? 0} retry=${c['retry'] ?? 0} parked=${c['parked'] ?? 0} delivered=${c['delivered'] ?? 0}` +
        (r.oldest_pending_age_s != null ? `  oldest_pending=${r.oldest_pending_age_s}s` : '') +
        (r.last_delivered_at ? `  last_delivered=${r.last_delivered_at}` : ''),
    )
  }
}

async function setKillswitch(state: 'none' | 'pause' | 'panic'): Promise<void> {
  const route = arg('route')
  if (route) {
    if (state === 'panic') usage()
    await api('POST', `/routes/${route}/pause`, { paused: state === 'pause', actor: ACTOR })
    console.log(`route ${route}: ${state === 'pause' ? 'paused' : 'resumed'}`)
  } else {
    await api('POST', '/killswitch', { state, actor: ACTOR })
    console.log(`global killswitch: ${state}`)
  }
}

async function eventsLs(): Promise<void> {
  const params = new URLSearchParams()
  for (const k of ['status', 'route', 'limit'] as const) {
    const v = arg(k)
    if (v) params.set(k, v)
  }
  const rows = (await api('GET', `/events?${params}`)) as Record<string, unknown>[]
  for (const r of rows) {
    console.log(
      `#${r['id']} ${r['status']} ${r['route_id']} ${r['event_type'] ?? '?'} ` +
        `received=${r['received_at']} attempts=${r['attempts']}` +
        (r['last_error'] ? ` error="${r['last_error']}"` : ''),
    )
  }
  if (rows.length === 0) console.log('(no events)')
}

async function eventsReplay(): Promise<void> {
  if (flag('parked')) {
    const res = (await api('POST', '/events/replay-parked', { actor: ACTOR })) as { replayed: number }
    console.log(`replayed ${res.replayed} parked event(s)`)
    return
  }
  const id = process.argv[4]
  if (!id || Number.isNaN(Number(id))) usage()
  await api('POST', `/events/${id}/replay`, { actor: ACTOR })
  console.log(`replayed event #${id}`)
}

async function auditExport(): Promise<void> {
  const rows = (await api('GET', `/audit?limit=${arg('limit') ?? 1000}`)) as unknown[]
  for (const row of rows) console.log(JSON.stringify(row))
}

async function configPlan(): Promise<void> {
  const p = (await api('GET', '/config/plan')) as {
    file: string
    file_hash: string
    applied_hash: string | null
    in_sync: boolean
    routes_added: string[]
    routes_removed: string[]
  }
  if (p.in_sync) {
    console.log(`✓ in sync (${p.file_hash})`)
    return
  }
  console.log(`file:    ${p.file_hash} (${p.file})`)
  console.log(`applied: ${p.applied_hash ?? 'none'}`)
  if (p.routes_added.length) console.log(`routes added:   ${p.routes_added.join(', ')}`)
  if (p.routes_removed.length) console.log(`routes removed: ${p.routes_removed.join(', ')}`)
  console.log('run `relayctl config apply` to apply')
}

async function configApply(): Promise<void> {
  const res = (await api('POST', '/config/apply', { actor: ACTOR })) as { applied: string }
  console.log(`✓ applied ${res.applied}`)
}

// ── local commands (no running relay required) ────────────────────────────────

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

function mapPreview(): void {
  const { config } = loadCliConfig()
  const routeId = requireArg('route')
  const route = config.routes.find((r) => r.id === routeId)
  if (!route) {
    console.error(`route not found: ${routeId} (have: ${config.routes.map((r) => r.id).join(', ')})`)
    process.exit(1)
  }
  // '-' reads the sample from stdin — how the host wrapper feeds a host-side file into
  // the containerized CLI.
  const samplePath = requireArg('sample')
  const sample = JSON.parse(readFileSync(samplePath === '-' ? 0 : samplePath, 'utf8')) as Json
  const maskingKey = deriveKey('MASKING_HMAC_KEY', process.env.MASKING_HMAC_KEY ?? 'preview-only-key')
  const { record, report } = mapEvent(route, sample, new Date().toISOString(), maskingKey)
  console.log(JSON.stringify({ route: routeId, record, report }, null, 2))
}

const [, , cmd, sub] = process.argv
const run = async (): Promise<void> => {
  if (cmd === 'status') return status()
  if (cmd === 'pause') return setKillswitch('pause')
  if (cmd === 'resume') return setKillswitch('none')
  if (cmd === 'panic') return setKillswitch('panic')
  if (cmd === 'events' && sub === 'ls') return eventsLs()
  if (cmd === 'events' && sub === 'replay') return eventsReplay()
  if (cmd === 'audit' && sub === 'export') return auditExport()
  if (cmd === 'config' && sub === 'plan') return configPlan()
  if (cmd === 'config' && sub === 'apply') return configApply()
  if (cmd === 'config' && sub === 'validate') return configValidate()
  if (cmd === 'map' && sub === 'preview') return mapPreview()
  usage()
}
run().catch((err) => {
  console.error(`✗ ${(err as Error).message}`)
  process.exit(1)
})
