import { writeFileSync, mkdtempSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadSecretsFile } from '../src/config/secrets.js'

function fileWith(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'relay-secrets-')), 'relay.env')
  writeFileSync(path, content)
  return path
}

describe('secrets file loader (strict mode)', () => {
  it('is a no-op when RELAY_SECRETS_FILE is unset or empty', () => {
    expect(loadSecretsFile({})).toEqual({ loaded: [] })
    expect(loadSecretsFile({ RELAY_SECRETS_FILE: '' })).toEqual({ loaded: [] })
  })

  it('parses KEY=VALUE with comments, blank lines, and quotes', () => {
    const env: NodeJS.ProcessEnv = {
      RELAY_SECRETS_FILE: fileWith(
        [
          '# the five relay secrets',
          '',
          'ENDCLOSE_API_KEY=ec_live_abc',
          'ADMIN_BASIC_AUTH="admin:with=equals:and:colons"',
          "MASKING_HMAC_KEY='single quoted value'",
          'not a valid line',
          '=novalue',
        ].join('\n'),
      ),
    }
    const res = loadSecretsFile(env)
    expect(res.error).toBeUndefined()
    expect(res.loaded).toEqual(['ENDCLOSE_API_KEY', 'ADMIN_BASIC_AUTH', 'MASKING_HMAC_KEY'])
    expect(env.ENDCLOSE_API_KEY).toBe('ec_live_abc')
    expect(env.ADMIN_BASIC_AUTH).toBe('admin:with=equals:and:colons')
    expect(env.MASKING_HMAC_KEY).toBe('single quoted value')
  })

  it('fills unset AND empty-string env vars, but never overrides real values', () => {
    // Distr passes blank template values through as "" — those must not shadow the file.
    const env: NodeJS.ProcessEnv = {
      RELAY_SECRETS_FILE: fileWith('A=from-file\nB=from-file\nC=from-file'),
      A: '',
      B: 'from-env',
    }
    const res = loadSecretsFile(env)
    expect(res.loaded).toEqual(['A', 'C'])
    expect(env.A).toBe('from-file')
    expect(env.B).toBe('from-env')
    expect(env.C).toBe('from-file')
  })

  it('reports an unreadable file as an error without throwing', () => {
    const res = loadSecretsFile({ RELAY_SECRETS_FILE: '/nonexistent/relay.env' })
    expect(res.loaded).toEqual([])
    expect(res.error).toContain('/nonexistent/relay.env')
  })
})
