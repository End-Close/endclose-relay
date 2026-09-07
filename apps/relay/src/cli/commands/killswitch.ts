import type { AdminClient } from '../client.js'
import { die, printJson } from '../io.js'

/**
 *   relayctl killswitch              Show global killswitch
 *   relayctl killswitch pause|resume|panic|none
 */
export async function killswitchCommand(client: AdminClient, argv: string[]): Promise<void> {
  const action = argv[0]
  if (!action || action === 'get' || action === 'status') {
    const { data } = await client.get<{
      killswitch: { global: string; routes_paused: string[] }
    }>('/status')
    console.log(`global: ${data.killswitch.global}`)
    if (data.killswitch.routes_paused.length) {
      console.log(`routes_paused: ${data.killswitch.routes_paused.join(', ')}`)
    }
    return
  }

  const map: Record<string, string> = {
    pause: 'pause',
    resume: 'none',
    none: 'none',
    panic: 'panic',
  }
  const state = map[action]
  if (!state) {
    die(`usage: relayctl killswitch [get|pause|resume|panic|none]`)
  }
  const { data } = await client.post('/killswitch', { state })
  printJson(data)
}
