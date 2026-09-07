import { describe, expect, it } from 'vitest'
import { isDbPathPersistent, parseMountPersistence } from '../src/db/persistence.js'

// Trimmed real-world mountinfo shapes. Fields: id parent major:minor root mountpoint
// options... - fstype source superopts

const CONTAINER_NO_VOLUME = `
896 767 0:105 / / rw,relatime master:227 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/ABC,upperdir=/var/lib/docker/overlay2/x/diff,workdir=/var/lib/docker/overlay2/x/work
897 896 0:107 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
902 896 0:106 / /tmp rw,nosuid,nodev,relatime - tmpfs tmpfs rw
`.trim()

const CONTAINER_WITH_VOLUME = `
896 767 0:105 / / rw,relatime master:227 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/ABC,upperdir=/var/lib/docker/overlay2/x/diff,workdir=/var/lib/docker/overlay2/x/work
897 896 0:107 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
903 896 254:1 /docker/volumes/endclose-relay-data/_data /var/lib/endclose-relay rw,relatime - ext4 /dev/vda1 rw
`.trim()

const K8S_WITH_PV = `
1580 1462 0:214 / / rw,relatime - overlay overlay rw,lowerdir=/var/lib/containerd/x,upperdir=/y,workdir=/z
1601 1580 259:5 / /var/lib/endclose-relay rw,relatime - xfs /dev/nvme2n1 rw,attr2
`.trim()

describe('parseMountPersistence', () => {
  it('data dir on the overlay root = ephemeral', () => {
    expect(parseMountPersistence(CONTAINER_NO_VOLUME, '/var/lib/endclose-relay')).toBe(false)
  })

  it('docker named volume = persistent', () => {
    expect(parseMountPersistence(CONTAINER_WITH_VOLUME, '/var/lib/endclose-relay')).toBe(true)
  })

  it('kubernetes PV (xfs) = persistent', () => {
    expect(parseMountPersistence(K8S_WITH_PV, '/var/lib/endclose-relay')).toBe(true)
  })

  it('nested data dir under a volume mount = persistent', () => {
    expect(parseMountPersistence(CONTAINER_WITH_VOLUME, '/var/lib/endclose-relay/sub')).toBe(true)
  })

  it('picks the longest matching mount (volume wins over root)', () => {
    // both / (overlay) and the volume match; the deeper mount decides
    expect(parseMountPersistence(CONTAINER_WITH_VOLUME, '/var/lib/endclose-relay')).toBe(true)
    expect(parseMountPersistence(CONTAINER_WITH_VOLUME, '/var/lib/other')).toBe(false)
  })

  it('decodes octal-escaped mount paths', () => {
    const escaped = `903 896 254:1 / /data\\040dir rw - ext4 /dev/vda1 rw`
    expect(parseMountPersistence(escaped, '/data dir')).toBe(true)
  })

  it('returns null when nothing matches', () => {
    expect(parseMountPersistence('', '/var/lib/endclose-relay')).toBeNull()
  })
})

describe('isDbPathPersistent', () => {
  it(':memory: makes no claim', () => {
    expect(isDbPathPersistent(':memory:')).toBeNull()
  })
})
