import { createHash } from 'node:crypto'

// RELAY_DATA_KEY and MASKING_HMAC_KEY are operator-supplied strings (32+ chars of entropy
// recommended). We derive fixed-length keys by hashing so any string works, but refuse
// obviously weak values.
const MIN_KEY_CHARS = 16

export function deriveKey(envName: string, raw: string | undefined): Buffer {
  if (!raw || raw.length < MIN_KEY_CHARS) {
    throw new Error(`${envName} must be set to at least ${MIN_KEY_CHARS} characters`)
  }
  return createHash('sha256').update(raw, 'utf8').digest()
}
