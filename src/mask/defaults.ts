import { REDACTED } from './engine.js'

// Hard denylist: applied in every mode, not configurable. If one of these patterns fires
// on data a customer legitimately needs, the answer is a deliberate code change here —
// never a config override.

const SENSITIVE_KEY_RE =
  /(^|_|\b)(cvv2?|cvc|cid|pin|password|passwd|secret|api[-_]?key|private[-_]?key|access[-_]?token|refresh[-_]?token|ssn|social[-_]?security|routing[-_]?number|account[-_]?number)($|_|\b)/i

export function keyNameIsSensitive(key: string): boolean {
  // Split camelCase so e.g. RoutingNumber / accountNumber match the snake/word patterns.
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  return SENSITIVE_KEY_RE.test(normalized)
}

const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g
// Digit runs (allowing space/dash separators) long enough to be a PAN.
const PAN_CANDIDATE_RE = /\b\d(?:[ -]?\d){12,18}\b/g

function luhnValid(digits: string): boolean {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/** Redact SSN patterns and Luhn-passing PANs inside string values. Returns the input unchanged when clean. */
export function hardDenyValue(value: string): string {
  let out = value.replace(SSN_RE, REDACTED)
  out = out.replace(PAN_CANDIDATE_RE, (candidate) => {
    const digits = candidate.replace(/[ -]/g, '')
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return REDACTED
    return candidate
  })
  return out
}
