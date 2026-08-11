#!/usr/bin/env node
/**
 * relayctl — in-container operator CLI for endclose-relay.
 *
 * Talks to the admin API on localhost. Uses ADMIN_BASIC_AUTH from the process
 * environment (already injected into the container), so ECS Exec / docker exec
 * users never type a password.
 *
 *   relayctl status
 *   relayctl config apply ./relay.yaml
 *   relayctl killswitch pause
 */
import { ApiError, createClientFromEnv } from './client.js'
import { die } from './io.js'
import { configCommand } from './commands/config.js'
import { eventsCommand } from './commands/events.js'
import { killswitchCommand } from './commands/killswitch.js'
import { statusCommand, statusJsonCommand } from './commands/status.js'

const HELP = `relayctl — manage this endclose-relay instance

Usage:
  relayctl status [--json]
  relayctl config <get|validate|apply|edit|versions|show|preview> ...
  relayctl killswitch [get|pause|resume|panic|none]
  relayctl events <list|payload|replay|replay-parked> ...

Auth: uses ADMIN_BASIC_AUTH from the environment (no prompt).
API:  RELAY_ADMIN_URL (default http://127.0.0.1:$RELAY_ADMIN_PORT or :8081)

Run inside the relay container (docker exec / ECS Exec). For config YAML help:
  relayctl config help
`

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const cmd = argv[0]

  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(HELP)
    return
  }

  let client
  try {
    client = createClientFromEnv()
  } catch (err) {
    die((err as Error).message)
  }

  try {
    switch (cmd) {
      case 'status':
        if (argv.includes('--json')) await statusJsonCommand(client)
        else await statusCommand(client)
        break
      case 'config':
        await configCommand(client, argv.slice(1))
        break
      case 'killswitch':
        await killswitchCommand(client, argv.slice(1))
        break
      case 'events':
        await eventsCommand(client, argv.slice(1))
        break
      default:
        die(`unknown command: ${cmd}\n\n${HELP}`)
    }
  } catch (err) {
    if (err instanceof ApiError) {
      die(`${err.message} (HTTP ${err.status})`, 1)
    }
    const msg = (err as Error).message
    if (msg === 'fetch failed' || (err as Error).name === 'TypeError') {
      die(
        `cannot reach admin API at ${client.baseUrl} (${msg}).\n` +
          'Is the relay process running? relayctl talks to localhost:8081 inside this container.',
      )
    }
    die(msg)
  }
}

main()
