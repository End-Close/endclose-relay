import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// AES-256-GCM with a per-row random IV. Ciphertext layout: <ciphertext><16-byte auth tag>.
const ALGO = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

export function encrypt(key: Buffer, plaintext: Buffer): { ciphertext: Buffer; iv: Buffer } {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  return { ciphertext, iv }
}

export function decrypt(key: Buffer, ciphertext: Buffer, iv: Buffer): Buffer {
  const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES)
  const body = ciphertext.subarray(0, ciphertext.length - TAG_BYTES)
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}
