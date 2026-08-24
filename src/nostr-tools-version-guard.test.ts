import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// Versions >=2.23.11 <2.24.2 silently killed long-lived subscriptions
// (nbd-wtf/nostr-tools#539): with `enablePing: true`, the pool's internal
// forced-ping subscription corrupted the in-use counter, and an idle timer
// then tore down every live subscription at roughly `29s * subs + 20s`. A
// conference room is nothing but long-lived subscriptions, so this range
// was exactly the one nostr-tools we could not run.
//
// That issue was closed on 2026-07-29 and verified fixed here on
// 2026-08-24 with a 110-second soak against wss://nos.lol and
// wss://relay.primal.net, publishing every 20s: with `enablePing: true`
// events still arrived on schedule (4, 25, 44, 65, 86, 106s) and every
// subscription survived the full run, well past the ~70s window where they
// used to die. We now depend on 2.25.0 (`^2.25.0` - no exact pin) and no
// longer avoid `enablePing`, but this guard stays so nobody drifts back
// into the broken range without noticing.

// Compares dotted numeric versions (no pre-release/build metadata, which
// nostr-tools releases don't use) component by component.
function compareVersions(a: string, b: string): number {
  const as = a.split('.').map(Number)
  const bs = b.split('.').map(Number)
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const diff = (as[i] ?? 0) - (bs[i] ?? 0)
    if (diff !== 0) return Math.sign(diff)
  }
  return 0
}

function isInBrokenRange(version: string): boolean {
  return compareVersions(version, '2.23.11') >= 0 && compareVersions(version, '2.24.2') < 0
}

describe('nostr-tools version guard', () => {
  it('does not resolve into the known-broken range (nbd-wtf/nostr-tools#539)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../node_modules/nostr-tools/package.json', import.meta.url), 'utf8'))
    expect(isInBrokenRange(pkg.version)).toBe(false)
  })

  it('resolves a single installed copy of nostr-tools', () => {
    const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
    const copies = Object.keys(lock.packages).filter(
      (path) => path === 'node_modules/nostr-tools' || path.endsWith('/node_modules/nostr-tools'),
    )
    expect(copies).toEqual(['node_modules/nostr-tools'])
  })
})
