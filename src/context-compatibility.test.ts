import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { ContextVault } from './context.js'
import { ContextVault as PortableContextVault } from '@forgesworn/context'
import { createNostrIdentity } from '@forgesworn/context/nostr'

const fixture = JSON.parse(readFileSync(new URL('../test/fixtures/context-v1/cache.json', import.meta.url), 'utf8'))
const identity = createNostrIdentity(new Uint8Array(32).fill(1))

it('opens the pre-extraction cache and preserves its signed heads, records and agent grants', async () => {
  const vault = new ContextVault({ identity, now: () => fixture.now, fetch: async () => { throw new Error('Unexpected network access') } })
  await vault.restore(fixture.cache)
  expect(vault.read(fixture.shared.id)).toEqual(fixture.shared)
  expect(vault.read(fixture.personal.id)).toEqual(fixture.personal)
  const before = vault.grants(fixture.personal.id)
  expect(before[0].agent?.principal).toBe(identity.pubkey)
  const next = await vault.append(fixture.shared.id, fixture.shared.head, {
    kind: 'fact', text: 'The extracted library read the old cache.', source: 'fixture://extraction', observedAt: fixture.now,
  })
  expect(next.revision).toBe(fixture.shared.revision + 1)
  expect(next.records[0]).toEqual(fixture.shared.records[0])
  const saved = await vault.save()
  const restored = new ContextVault({ identity, now: () => fixture.now })
  await restored.restore(saved)
  expect(restored.read(next.id)).toEqual(next)
  expect(restored.grants(fixture.personal.id)).toEqual(before)
})

it('fails closed on a legacy agent proof when the KithMoot adapter is absent', async () => {
  const vault = new PortableContextVault({ identity, now: () => fixture.now })
  await expect(vault.restore(fixture.cache)).rejects.toThrow('ownership proof')
  expect(vault.list()).toEqual([])
})
