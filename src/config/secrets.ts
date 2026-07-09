import { readFileSync } from 'node:fs'

// Optional strict mode for secrets: when RELAY_SECRETS_FILE is set, load KEY=VALUE
// pairs from that file into the environment. Exists for customers whose policy forbids
// secrets on third-party infrastructure (the default Distr flow stores env values in
// the hub database) — they mount a host file instead and leave the Distr values blank.
//
// Precedence: a file value fills an env var that is unset OR empty. Empty matters:
// Distr passes blank template values through as "" and those must not shadow the file.

export interface SecretsFileResult {
  loaded: string[]
  error?: string
}

export function loadSecretsFile(env: NodeJS.ProcessEnv = process.env): SecretsFileResult {
  const path = env.RELAY_SECRETS_FILE
  if (!path) return { loaded: [] }

  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    return {
      loaded: [],
      error: `RELAY_SECRETS_FILE is set but unreadable: ${path} (${(err as Error).message})`,
    }
  }

  const loaded: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    if (env[key] === undefined || env[key] === '') {
      env[key] = value
      loaded.push(key)
    }
  }
  return { loaded }
}
