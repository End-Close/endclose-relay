import { describe, expect, it } from 'vitest'
import { isSqliteBusy, withBusyRetry } from '../src/db/busy.js'

function busyErr(): Error & { code: string } {
  const err = new Error('database is locked') as Error & { code: string }
  err.code = 'SQLITE_BUSY'
  return err
}

describe('isSqliteBusy', () => {
  it('detects SQLITE_BUSY and subtypes, not other sqlite errors', () => {
    expect(isSqliteBusy(busyErr())).toBe(true)
    expect(isSqliteBusy(Object.assign(new Error('locked'), { code: 'SQLITE_BUSY_SNAPSHOT' }))).toBe(
      true,
    )
    expect(isSqliteBusy(Object.assign(new Error('table locked'), { code: 'SQLITE_LOCKED' }))).toBe(
      false,
    )
    expect(isSqliteBusy(new Error('database is locked'))).toBe(false)
  })
})

describe('withBusyRetry', () => {
  it('returns on first success', async () => {
    const calls: number[] = []
    const result = await withBusyRetry('op', () => {
      calls.push(1)
      return 7
    })
    expect(result).toBe(7)
    expect(calls).toHaveLength(1)
  })

  it('retries SQLITE_BUSY then succeeds', async () => {
    let n = 0
    const result = await withBusyRetry(
      'claimDue',
      () => {
        n++
        if (n < 3) throw busyErr()
        return 'ok'
      },
      { attempts: 3, delayMs: 1 },
    )
    expect(result).toBe('ok')
    expect(n).toBe(3)
  })

  it('throws after exhausting SQLITE_BUSY retries', async () => {
    let n = 0
    await expect(
      withBusyRetry(
        'insert',
        () => {
          n++
          throw busyErr()
        },
        { attempts: 2, delayMs: 1 },
      ),
    ).rejects.toMatchObject({ message: 'database is locked', code: 'SQLITE_BUSY' })
    expect(n).toBe(2)
  })

  it('does not retry non-busy errors', async () => {
    let n = 0
    await expect(
      withBusyRetry(
        'insert',
        () => {
          n++
          throw new Error('disk I/O error')
        },
        { attempts: 5, delayMs: 1 },
      ),
    ).rejects.toThrow('disk I/O error')
    expect(n).toBe(1)
  })
})
