import type { AdminClient } from '../client.js'
import { die, flagString, parseFlags, printJson } from '../io.js'

/**
 *   relayctl events list [--status parked] [--route id] [--limit N]
 *   relayctl events payload <id>
 *   relayctl events replay <id>
 *   relayctl events replay-parked
 */
export async function eventsCommand(client: AdminClient, argv: string[]): Promise<void> {
  const sub = argv[0]
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    console.log(`Usage:
  relayctl events list [--status <status>] [--route <id>] [--limit N]
  relayctl events payload <id>
  relayctl events replay <id>
  relayctl events replay-parked`)
    return
  }
  const rest = argv.slice(1)

  switch (sub) {
    case 'list':
    case 'ls':
      return eventsList(client, rest)
    case 'payload':
      return eventsPayload(client, rest)
    case 'replay':
      return eventsReplay(client, rest)
    case 'replay-parked':
      return eventsReplayParked(client)
    default:
      die(`unknown events subcommand: ${sub}`)
  }
}

async function eventsList(client: AdminClient, argv: string[]): Promise<void> {
  const { flags } = parseFlags(argv, ['status', 'route', 'limit', 'json'])
  const qs = new URLSearchParams()
  const status = flagString(flags, 'status')
  const route = flagString(flags, 'route')
  const limit = flagString(flags, 'limit')
  if (status) qs.set('status', status)
  if (route) qs.set('route', route)
  if (limit) qs.set('limit', limit)
  const path = `/events${qs.toString() ? '?' + qs : ''}`
  const { data } = await client.get<
    {
      id: number
      route_id: string
      event_type: string | null
      status: string
      received_at: string
      last_error: string | null
    }[]
  >(path)
  if (flags.json) {
    printJson(data)
    return
  }
  if (!Array.isArray(data) || data.length === 0) {
    console.log('(no events)')
    return
  }
  for (const e of data) {
    const err = e.last_error ? `  err=${e.last_error}` : ''
    console.log(
      `${e.id}\t${e.status}\t${e.route_id}\t${e.event_type ?? '-'}\t${e.received_at}${err}`,
    )
  }
}

async function eventsPayload(client: AdminClient, argv: string[]): Promise<void> {
  const id = argv[0]
  if (!id) die('usage: relayctl events payload <id>')
  const { data } = await client.get<{ payload: unknown }>(`/events/${id}/payload`)
  printJson(data.payload)
}

async function eventsReplay(client: AdminClient, argv: string[]): Promise<void> {
  const id = argv[0]
  if (!id) die('usage: relayctl events replay <id>')
  const { data } = await client.post(`/events/${id}/replay`)
  printJson(data)
}

async function eventsReplayParked(client: AdminClient): Promise<void> {
  const { data } = await client.post('/events/replay-parked')
  printJson(data)
}
