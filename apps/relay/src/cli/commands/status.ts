import type { AdminClient } from '../client.js'
import { printJson } from '../io.js'

export async function statusCommand(client: AdminClient): Promise<void> {
  const { data } = await client.get<Record<string, unknown>>('/status')
  // Human-readable summary first; full JSON with --json via caller if we add it later.
  const mode = data.mode
  const kill = data.killswitch as { global?: string } | undefined
  const queue = data.queue as Record<string, number> | undefined
  const hash = data.config_hash
  const storage = data.storage as { persistent?: boolean | null; db_path?: string } | undefined

  console.log(`mode:        ${mode}`)
  console.log(`version:     ${data.version}`)
  console.log(`killswitch:  ${kill?.global ?? '?'}`)
  console.log(`config:      ${hash ?? '(none)'}`)
  if (data.config_error) console.log(`config_err:  ${data.config_error}`)
  console.log(`db:          ${storage?.db_path ?? '?'}`)
  console.log(
    `persistent:  ${storage?.persistent === true ? 'yes' : storage?.persistent === false ? 'NO — ephemeral' : 'unknown'}`,
  )
  if (queue && Object.keys(queue).length) {
    console.log('queue:')
    for (const [k, v] of Object.entries(queue).sort()) {
      console.log(`  ${k}: ${v}`)
    }
  }
  const routes = data.routes as { id: string; paused: boolean; counts?: Record<string, number> }[] | undefined
  if (routes?.length) {
    console.log('routes:')
    for (const r of routes) {
      const counts = r.counts
        ? Object.entries(r.counts)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')
        : ''
      console.log(`  ${r.id}${r.paused ? ' (paused)' : ''}${counts ? '  ' + counts : ''}`)
    }
  }
}

export async function statusJsonCommand(client: AdminClient): Promise<void> {
  const { data } = await client.get('/status')
  printJson(data)
}
