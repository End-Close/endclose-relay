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

export function checkRequiredEnv(
  env: NodeJS.ProcessEnv = process.env,
  secretsFileError?: string,
): EnvCheck[] {
  const missing: EnvCheck[] = []
  // A broken strict-mode secrets file is the likeliest cause of everything else being
  // missing — name it first so the setup page explains the situation.
  if (secretsFileError) missing.push({ name: 'RELAY_SECRETS_FILE', problem: secretsFileError })
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

export interface SetupStorageInfo {
  dbPath: string
  /** From isDbPathPersistent — false means the data dir is on the ephemeral layer. */
  persistent: boolean | null
}

export function buildSetupServer(missing: EnvCheck[], storage?: SetupStorageInfo): FastifyInstance {
  const app = Fastify({ logger: false })

  app.get('/', async (_req, reply) =>
    reply.header('content-type', 'text/html').send(setupPage(missing, storage)),
  )
  // Liveness must succeed in setup mode: Distr's autoheal sidecar restarts unhealthy
  // containers, and a failing healthcheck here would restart-loop the relay while the
  // operator is reading this very page.
  app.get('/healthz', async () => ({ ok: true, mode: 'env-setup' }))
  // Anything else (probes, the UI's API calls) gets an unambiguous "not configured".
  app.setNotFoundHandler(async (_req, reply) =>
    reply.code(503).send({ error: 'relay is not configured', missing: missing.map((m) => m.name) }),
  )

  return app
}

function setupPage(missing: EnvCheck[], storage?: SetupStorageInfo): string {
  const rows = missing
    .map((m) => `<tr><td><code>${m.name}</code></td><td>${m.problem}</td></tr>`)
    .join('')
  // Surface a missing data volume here too, so env and storage get fixed in ONE
  // redeploy instead of discovering the volume problem on the next screen.
  const storageWarning =
    storage?.persistent === false
      ? `<p class="warn"><strong>Also: no persistent volume detected.</strong> The data
directory (<code>${storage.dbPath}</code>) is on the container's ephemeral filesystem —
configuration and buffered webhooks would be lost on every restart. Attach a volume at
that path (Docker volume / Kubernetes PersistentVolume) in the same redeploy that fixes
the variables above.</p>`
      : ''
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
${storageWarning}
<p>Provide them as environment variables on the relay container — through whatever
mechanism you manage secrets with (see <code>relay.example.yaml</code> for what each one
does) — then recreate it:</p>
<pre>docker compose up -d --force-recreate relay</pre>
<p><code>RELAY_DATA_KEY</code> (encrypts buffered webhooks at rest) and
<code>MASKING_HMAC_KEY</code> (keys the deterministic <code>hash</code> transform) are
random strings you generate once, at least 32 characters — for example:</p>
<pre>openssl rand -hex 32    # run twice: one value per key</pre>
<p><strong>Back both up</strong> (they never leave this machine, and data at rest is
unreadable without them), and use a distinct value for each. For
<code>ADMIN_BASIC_AUTH</code>, pick a username and a strong password:
<code>admin:$(openssl rand -base64 18)</code>.</p>
<p>Only universally required variables are checked here. Secrets referenced by your
configuration (e.g. <code>ENDCLOSE_API_KEY</code>, processor webhook secrets) can't be
known before a configuration exists — they're validated in the admin UI once it does,
and missing ones show as a warning banner rather than stopping the relay.</p>
<p>This page is intentionally unauthenticated — it appears only while the relay is
unconfigured and reveals nothing but variable names.</p>`
}
