import { describe, expect, it } from 'vitest'
import { githubUrl, keepRetired, planRetirement, removablePaths } from './download-retention.mjs'

const sha = n => String(n).padStart(2, '0').repeat(32)
const desktop = (version, n) => ({
  version, published: '2026-11-01',
  files: [
    { os: 'mac', arch: 'arm64', kind: 'app', filename: `KithMoot-${version}-mac-arm64.zip`, url: `/apk/desktop/${version}/KithMoot-${version}-mac-arm64.zip`, bytes: 100 + n, sha256: sha(n) },
    { os: 'linux', arch: 'x64', kind: 'deb', filename: `kithmoot_${version}_amd64.deb`, url: `/apk/desktop/${version}/kithmoot_${version}_amd64.deb`, bytes: 200 + n, sha256: sha(n + 50) },
  ],
})
const android = (version, n) => ({
  version, published: '2026-11-01',
  files: [{ os: 'android', arch: 'any', kind: 'production', filename: `kithmoot-${version}-production.apk`, url: `/apk/kithmoot-${version}-production.apk`, bytes: 300 + n, sha256: sha(n) }],
})
const identical = release => release.files.map(f => ({ name: f.filename, size: f.bytes, digest: `sha256:${f.sha256}` }))

describe('retiring old downloads to GitHub', () => {
  const versions = {
    desktop: [desktop('0.1.12', 12), desktop('0.1.11', 11), desktop('0.1.10', 10), desktop('0.1.9', 9), desktop('0.1.8', 8)],
    android: [android('0.6.3', 3), android('0.6.2', 2), android('0.6.1', 1)],
  }
  const byVersion = new Map([...versions.desktop, ...versions.android].map(r => [r.version, r]))

  it('keeps the newest versions on the server and links older identical ones to GitHub', () => {
    const { versions: next, retired, stays } = planRetirement(versions, { keep: 2, assets: (_p, v) => identical(byVersion.get(v)) })
    expect(retired).toEqual({ desktop: ['0.1.10', '0.1.9', '0.1.8'], android: ['0.6.1'] })
    expect(stays).toEqual({ desktop: [], android: [] })
    expect(next.desktop[0].files[0].url).toBe('/apk/desktop/0.1.12/KithMoot-0.1.12-mac-arm64.zip')
    expect(next.desktop[2].files[0].url).toBe('https://github.com/forgesworn/kithmoot/releases/download/v0.1.10/KithMoot-0.1.10-mac-arm64.zip')
    expect(next.android[2].files[0].url).toBe(githubUrl('android', '0.6.1', 'kithmoot-0.6.1-production.apk'))
    // Sizes and hashes are the server's, unchanged.
    expect(next.desktop[2].files[1]).toMatchObject({ bytes: 210, sha256: sha(60) })
  })

  it('keeps a version on the server when GitHub has no release, a file is missing, or a size or hash differs', () => {
    const assets = (_p, v) => {
      if (v === '0.1.10') return undefined
      const list = identical(byVersion.get(v))
      if (v === '0.1.9') return list.slice(0, 1)
      if (v === '0.1.8') return [{ ...list[0], digest: `sha256:${sha(99)}` }, list[1]]
      if (v === '0.6.1') return [{ ...list[0], size: 1 }]
      return list
    }
    const { versions: next, retired, stays } = planRetirement(versions, { keep: 2, assets })
    expect(retired).toEqual({ desktop: [], android: [] })
    expect(stays).toEqual({ desktop: ['0.1.10', '0.1.9', '0.1.8'], android: ['0.6.1'] })
    expect(next).toEqual(versions)
  })

  it('never retires the version a manifest offers now, and refuses to keep none', () => {
    const { retired } = planRetirement(versions, { keep: 1, assets: (_p, v) => identical(byVersion.get(v)), current: { desktop: '0.1.11', android: '0.6.2' } })
    expect(retired.desktop).not.toContain('0.1.11')
    expect(retired.android).toEqual(['0.6.1'])
    expect(() => planRetirement(versions, { keep: 0, assets: () => [] })).toThrow()
  })

  it('a regenerated list keeps versions already on GitHub that the server no longer holds', () => {
    const { versions: planned } = planRetirement(versions, { keep: 2, assets: (_p, v) => identical(byVersion.get(v)) })
    // The server now lists only what it kept, plus a new release.
    const listed = { desktop: [desktop('0.1.13', 13), desktop('0.1.12', 12), desktop('0.1.11', 11)], android: [android('0.6.3', 3), android('0.6.2', 2)] }
    const merged = keepRetired(listed, planned)
    expect(merged.desktop.map(r => r.version)).toEqual(['0.1.13', '0.1.12', '0.1.11', '0.1.10', '0.1.9', '0.1.8'])
    expect(merged.android.map(r => r.version)).toEqual(['0.6.3', '0.6.2', '0.6.1'])
    // A version the server lost without being sent to GitHub is not invented back.
    expect(keepRetired(listed, versions).desktop.map(r => r.version)).toEqual(['0.1.13', '0.1.12', '0.1.11'])
  })

  it('removes from the server only what the live list sends to GitHub, never the current version', () => {
    const { versions: live } = planRetirement(versions, { keep: 2, assets: (_p, v) => identical(byVersion.get(v)) })
    expect(removablePaths(live, { desktop: '0.1.12', android: '0.6.3' })).toEqual(['desktop/0.1.10', 'desktop/0.1.9', 'desktop/0.1.8', 'kithmoot-0.6.1-production.apk'])
    expect(removablePaths(versions)).toEqual([])
    expect(removablePaths(live, { desktop: '0.1.9' })).not.toContain('desktop/0.1.9')
  })
})
