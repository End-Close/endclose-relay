import Fastify, { type FastifyInstance } from 'fastify'

// Setup mode: when required environment is missing, the relay can't run (nothing can be
// encrypted / the admin plane can't be protected), but crash-looping with a log line is
// a poor operator experience. Instead we serve a plain warning page naming exactly
// what's missing. Deliberately unauthenticated: it exists precisely because
// ADMIN_BASIC_AUTH may be missing, and it exposes only env-var *names*.

export interface EnvCheck {
  name: string
  problem: string
}

export function checkRequiredEnv(env: NodeJS.ProcessEnv = process.env): EnvCheck[] {
  const missing: EnvCheck[] = []
  for (const name of ['RELAY_DATA_KEY', 'MASKING_HMAC_KEY'] as const) {
    if (!env[name]) missing.push({ name, problem: 'not set' })
    else if (env[name].length < 16) missing.push({ name, problem: 'too short (min 16 chars)' })
  }
  if (!env.ADMIN_BASIC_AUTH) missing.push({ name: 'ADMIN_BASIC_AUTH', problem: 'not set' })
  else if (!env.ADMIN_BASIC_AUTH.includes(':')) {
    missing.push({ name: 'ADMIN_BASIC_AUTH', problem: 'must be user:password' })
  }
  return missing
}

export function buildSetupServer(missing: EnvCheck[]): FastifyInstance {
  const app = Fastify({ logger: false })

  app.get('/', async (_req, reply) =>
    reply.header('content-type', 'text/html').send(setupPage(missing)),
  )
  // Anything else (probes, the UI's API calls) gets an unambiguous "not configured".
  app.setNotFoundHandler(async (_req, reply) =>
    reply.code(503).send({ error: 'relay is not configured', missing: missing.map((m) => m.name) }),
  )

  return app
}

function setupPage(missing: EnvCheck[]): string {
  const rows = missing
    .map((m) => `<tr><td><code>${m.name}</code></td><td>${m.problem}</td></tr>`)
    .join('')
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>endclose-relay — setup required</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 2rem auto; max-width: 44rem; padding: 0 1rem; }
  h1 { font-size: 1.2rem; } .warn { color: #e65100; }
  table { border-collapse: collapse; margin: 1rem 0; }
  td { padding: .3rem .8rem .3rem 0; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
  pre { background: color-mix(in srgb, currentColor 6%, transparent); padding: .8rem; border-radius: 6px; overflow-x: auto; }
</style>
<h1>endclose-relay <span class="warn">— setup required</span></h1>
<p>The relay refused to start because required environment variables are missing or
invalid. <strong>No webhooks are being accepted or forwarded.</strong></p>
<table>${rows}</table>
<p>Provide them as environment variables on the relay container — through whatever
mechanism you manage secrets with (see <code>relay.example.yaml</code> for what each one
does) — then recreate it:</p>
<pre>docker compose up -d --force-recreate relay</pre>
<p>This page is intentionally unauthenticated — it appears only while the relay is
unconfigured and reveals nothing but variable names.</p>`
}
