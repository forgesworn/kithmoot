import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

describe('nostr-tools version pin', () => {
  it('is pinned to exactly 2.23.9 with no range prefix', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const spec = pkg.dependencies['nostr-tools']
    // Versions >=2.23.11 silently kill long-lived subscriptions (nbd-wtf/nostr-tools#539).
    // A conference room is nothing but long-lived subscriptions.
    expect(spec).toBe('2.23.9')
  })

  it('resolves a single installed copy at 2.23.9', () => {
    const installed = JSON.parse(
      readFileSync(new URL('../node_modules/nostr-tools/package.json', import.meta.url), 'utf8'),
    )
    expect(installed.version).toBe('2.23.9')
  })
})
