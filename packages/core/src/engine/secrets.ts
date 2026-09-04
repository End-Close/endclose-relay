// Secret resolution for the engine. Route configs reference secrets by NAME only (the
// `secret_env` field); the host decides where the value comes from. The appliance uses the
// process environment; an embedding application may use a static map loaded from its
// secret manager at startup.
//
// Resolution is synchronous by design: it sits on the webhook verification hot path, and
// secrets should be materialised once at boot rather than fetched per request.

export interface SecretResolver {
  /** The secret value for `ref`, or undefined when it is not available. */
  resolve(ref: string): string | undefined
  /** Whether `ref` is currently available (defaults to `resolve(ref) !== undefined`). */
  has?(ref: string): boolean
}

export class SecretUnavailableError extends Error {
  constructor(readonly ref: string) {
    super(`missing required secret env var: ${ref}`)
  }
}

/** Resolve from an environment-shaped record; empty strings count as unset. */
export function envSecrets(env: Record<string, string | undefined> = process.env): SecretResolver {
  return {
    resolve: (ref) => {
      const v = env[ref]
      return v ? v : undefined
    },
  }
}

export function staticSecrets(map: Record<string, string>): SecretResolver {
  return { resolve: (ref) => map[ref] }
}

export function toSecretResolver(s: SecretResolver | Record<string, string>): SecretResolver {
  return typeof (s as SecretResolver).resolve === 'function'
    ? (s as SecretResolver)
    : staticSecrets(s as Record<string, string>)
}

export function hasSecret(resolver: SecretResolver, ref: string): boolean {
  return resolver.has ? resolver.has(ref) : resolver.resolve(ref) !== undefined
}

/** Resolve or throw `SecretUnavailableError`. */
export function requireSecret(resolver: SecretResolver, ref: string): string {
  const v = resolver.resolve(ref)
  if (v === undefined) throw new SecretUnavailableError(ref)
  return v
}
