import type { AdminClient } from '../client.js'
import { ApiError } from '../client.js'
import {
  die,
  editInEditor,
  flagString,
  parseFlags,
  printJson,
  readYamlInput,
  writeOutput,
} from '../io.js'

/**
 * Config subcommands — YAML is the interchange format (same document as the admin UI).
 *
 *   relayctl config get [-o file]
 *   relayctl config validate <file|->
 *   relayctl config apply <file|->
 *   relayctl config edit
 *   relayctl config versions
 *   relayctl config show <id> [-o file]
 *   relayctl config preview --route <id> --sample <payload.json> [--file yaml]
 */
export async function configCommand(client: AdminClient, argv: string[]): Promise<void> {
  const sub = argv[0]
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    printConfigHelp()
    return
  }
  const rest = argv.slice(1)

  switch (sub) {
    case 'get':
      return configGet(client, rest)
    case 'validate':
      return configValidate(client, rest)
    case 'apply':
    case 'set': // alias
      return configApply(client, rest)
    case 'edit':
      return configEdit(client, rest)
    case 'versions':
      return configVersions(client)
    case 'show':
      return configShow(client, rest)
    case 'preview':
      return configPreview(client, rest)
    default:
      die(`unknown config subcommand: ${sub}\n\n${CONFIG_HELP}`)
  }
}

const CONFIG_HELP = `Usage:
  relayctl config get [-o file]          Print active YAML (or write to file)
  relayctl config validate <file|->      Validate without applying
  relayctl config apply <file|->         Validate + apply (bootstrap restarts the process)
  relayctl config edit                   Open active YAML in $EDITOR, then apply
  relayctl config versions               List immutable config versions
  relayctl config show <id> [-o file]    Show a historical version's YAML
  relayctl config preview --route <id> --sample <payload.json> [--file yaml]

YAML is the same document as the admin UI / relay.example.yaml (routes only).
Use "-" as the file path to read from stdin:

  relayctl config apply - < relay.yaml
  cat relay.yaml | relayctl config apply -`

function printConfigHelp(): void {
  console.log(CONFIG_HELP)
}

async function configGet(client: AdminClient, argv: string[]): Promise<void> {
  const { flags } = parseFlags(argv, ['o', 'out', 'json'])
  const out = flagString(flags, 'o') ?? flagString(flags, 'out')
  try {
    const { data } = await client.get<{ yaml: string; hash: string | null; error?: string }>('/config')
    if (flags.json) {
      printJson(data)
      return
    }
    if (data.error) console.error(`relayctl: stored config has validation error: ${data.error}`)
    if (data.hash) console.error(`hash: ${data.hash}`)
    writeOutput(out, data.yaml)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      die('no configuration yet (bootstrap mode) — apply one with: relayctl config apply <file>')
    }
    throw err
  }
}

async function configValidate(client: AdminClient, argv: string[]): Promise<void> {
  const path = argv[0]
  const yaml = readYamlInput(path)
  const { data } = await client.post<{
    valid: boolean
    hash?: string
    routes?: string[]
    error?: string
    secret_envs?: { name: string; set: boolean }[]
  }>('/config/validate', { yaml })
  if (!data.valid) {
    console.error(`invalid: ${data.error}`)
    process.exit(1)
  }
  console.log(`valid  hash=${data.hash}`)
  if (data.routes?.length) console.log(`routes: ${data.routes.join(', ')}`)
  const missing = data.secret_envs?.filter((s) => !s.set).map((s) => s.name) ?? []
  if (missing.length) console.error(`warning: unset secret env vars: ${missing.join(', ')}`)
}

async function configApply(client: AdminClient, argv: string[]): Promise<void> {
  const path = argv[0]
  const yaml = readYamlInput(path)
  // Validate first for a clearer error before apply
  const check = await client.post<{ valid: boolean; error?: string }>('/config/validate', { yaml })
  if (!check.data.valid) {
    die(`invalid config: ${check.data.error}`)
  }
  const { data } = await client.post<{ applied: string; restarting?: boolean; paused?: boolean }>(
    '/config',
    { yaml },
  )
  console.log(`applied ${data.applied}`)
  if (data.restarting) {
    console.log('restarting into running mode (container will exit; orchestrator should restart it)')
  }
  if (data.paused) {
    console.log('forwarding held (paused) after recovery apply — resume with: relayctl killswitch resume')
  }
}

async function configEdit(client: AdminClient, argv: string[]): Promise<void> {
  if (argv.length) die('config edit takes no arguments')
  let initial = 'routes: []\n'
  let hadConfig = false
  try {
    const { data } = await client.get<{ yaml: string }>('/config')
    initial = data.yaml
    hadConfig = true
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err
    console.error('relayctl: no config yet — starting from an empty routes document')
  }
  const edited = editInEditor(initial)
  if (hadConfig && edited === initial) {
    console.log('unchanged — nothing applied')
    return
  }
  const check = await client.post<{ valid: boolean; error?: string }>('/config/validate', {
    yaml: edited,
  })
  if (!check.data.valid) {
    die(`invalid config: ${check.data.error}`)
  }
  const { data } = await client.post<{ applied: string; restarting?: boolean; paused?: boolean }>(
    '/config',
    { yaml: edited },
  )
  console.log(`applied ${data.applied}`)
  if (data.restarting) {
    console.log('restarting into running mode (container will exit; orchestrator should restart it)')
  }
  if (data.paused) {
    console.log('forwarding held (paused) after recovery apply — resume with: relayctl killswitch resume')
  }
}

async function configVersions(client: AdminClient): Promise<void> {
  const { data } = await client.get<
    { id: number; applied_at: string; config_hash: string; applied_by: string }[]
  >('/config/versions')
  if (!Array.isArray(data) || data.length === 0) {
    console.log('(no versions)')
    return
  }
  for (const v of data) {
    console.log(`${v.id}\t${v.applied_at}\t${v.config_hash}\t${v.applied_by}`)
  }
}

async function configShow(client: AdminClient, argv: string[]): Promise<void> {
  const { flags, rest } = parseFlags(argv, ['o', 'out'])
  const id = rest[0]
  if (!id) die('usage: relayctl config show <id> [-o file]')
  const out = flagString(flags, 'o') ?? flagString(flags, 'out')
  const { data } = await client.get<{
    id: number
    config_hash: string
    config_yaml: string
    applied_at: string
  }>(`/config/versions/${id}`)
  console.error(`id=${data.id}  hash=${data.config_hash}  at=${data.applied_at}`)
  writeOutput(out, data.config_yaml)
}

async function configPreview(client: AdminClient, argv: string[]): Promise<void> {
  const { flags } = parseFlags(argv, ['route', 'sample', 'file'])
  const route = flagString(flags, 'route')
  const samplePath = flagString(flags, 'sample')
  if (!route || !samplePath) {
    die('usage: relayctl config preview --route <id> --sample <payload.json> [--file yaml]')
  }
  let sample: unknown
  try {
    sample = JSON.parse(readYamlInput(samplePath)) // reuse file reader; JSON is fine
  } catch (err) {
    die(`sample JSON: ${(err as Error).message}`)
  }
  const file = flagString(flags, 'file')
  const body: { route: string; sample: unknown; yaml?: string } = { route, sample }
  if (file) {
    body.yaml = readYamlInput(file)
  }
  const { data } = await client.post('/config/preview', body)
  printJson(data)
}
