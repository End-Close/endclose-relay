import { encrypt, decrypt } from '../crypto/at-rest.js'

// How buffered payloads are stored. Rows always hold whatever the codec produced; only the
// dispatcher and an audited operator read path decode. Encryption is chosen explicitly by
// the host — there is no silent plaintext default.

export interface PayloadCodec {
  encode(plain: Buffer): { payload: Buffer; iv: Buffer | null }
  decode(payload: Buffer, iv: Buffer | null): Buffer
}

/** AES-256-GCM under a 32-byte key (see crypto/keys.ts deriveKey). */
export function aesGcmCodec(key: Buffer): PayloadCodec {
  return {
    encode(plain) {
      const { ciphertext, iv } = encrypt(key, plain)
      return { payload: ciphertext, iv }
    },
    decode(payload, iv) {
      if (!iv) throw new Error('encrypted payload has no iv')
      return decrypt(key, payload, iv)
    },
  }
}

/** Stores payloads as-is. Only appropriate when the store itself is encrypted or trusted. */
export const plainCodec: PayloadCodec = {
  encode: (plain) => ({ payload: plain, iv: null }),
  decode: (payload) => payload,
}
