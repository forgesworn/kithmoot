import { expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'
import type { SignetSigner } from 'signet-login'
import type { RelayTransport } from '../../src/relay-pool.js'
import { memoryDeviceStore } from './device-store.js'
import { SpryAccountSync } from './spry-account-sync.js'

function actor(secret = generateSecretKey()) {
  const pubkey = getPublicKey(secret)
  const signer: SignetSigner = { pubkey, method: 'nip07', capabilities: { canSignEvents: true, hasNip44: true }, close: async () => {},
    signEvent: async event => finalizeEvent(event, secret), nip44: {
      encrypt: async (peer, text) => encrypt(text, getConversationKey(secret, peer)),
      decrypt: async (peer, text) => decrypt(text, getConversationKey(secret, peer)),
    } }
  return signer
}
const pair = () => ({ v: 1 as const, endpoint: 'https://relay.example:3744', id: 'a'.repeat(43), secretKey: 'b'.repeat(64) })
function harness(signer = actor(), store = memoryDeviceStore()) {
  const events: Event[] = [], adopted: unknown[] = []
  let live = true, fail = false
  const relay: RelayTransport = { publish: vi.fn(async event => { if (fail) throw Error('offline'); events.push(event) }),
    subscribe: () => () => {}, close: () => {} }
  const sync = new SpryAccountSync(store, signer, relay, value => adopted.push(value), () => {}, () => live)
  sync.start()
  return { sync, signer, store, relay, events, adopted, changeAccount: () => { live = false }, offline: (value: boolean) => { fail = value } }
}

it('shares the account pairing encrypted to self, including a later signed-in device', async () => {
  const a = harness(), b = harness(a.signer), stranger = harness()
  expect(await a.sync.save(pair())).toBe(true)
  const event = a.events[0]
  expect(JSON.stringify(event)).not.toContain(pair().secretKey)
  expect(JSON.stringify(event.tags)).not.toContain('relay.example')
  await b.sync.receive(event)
  expect(b.adopted).toEqual([pair()])
  await stranger.sync.receive(event)
  expect(stranger.adopted).toEqual([])
  const later = harness(a.signer, b.store)
  await vi.waitFor(() => expect(later.adopted).toEqual([pair()]))
  for (const h of [a, b, stranger, later]) h.sync.close()
})

it('a tombstone removes the account pairing and old relay copies cannot restore it', async () => {
  const a = harness(), b = harness(a.signer)
  await a.sync.save(pair())
  const old = a.events[0]
  await b.sync.receive(old)
  await a.sync.save(null)
  await b.sync.receive(a.events[1])
  await b.sync.receive(old)
  expect(b.adopted).toEqual([pair(), null])
  a.sync.close(); b.sync.close()
})

it('keeps an encrypted outbox after refusal and retries it after restart', async () => {
  const a = harness()
  a.offline(true)
  expect(await a.sync.save(pair())).toBe(false)
  expect(a.events).toHaveLength(0)
  expect(a.store.keys().map(k => a.store.get(k)).join('')).not.toContain(pair().secretKey)
  a.sync.close()
  const restarted = harness(a.signer, a.store)
  await vi.waitFor(() => expect(restarted.events).toHaveLength(1))
  const b = harness(a.signer)
  await b.sync.receive(restarted.events[0])
  expect(b.adopted).toEqual([pair()])
  restarted.sync.close(); b.sync.close()
})

it('does not publish a late signer result after the account changes', async () => {
  const a = harness()
  let release!: (value: string) => void
  a.signer.nip44!.encrypt = () => new Promise(resolve => { release = resolve })
  const saving = a.sync.save(pair())
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  a.changeAccount(); release('late result')
  expect(await saving).toBe(false)
  expect(a.events).toHaveLength(0)
  a.sync.close()
})

it('retains account removal intent when the signer refuses, then retries after restart', async () => {
  const identity = actor(), a = harness({ ...identity, nip44: { ...identity.nip44! } })
  await a.sync.save(pair())
  a.signer.nip44!.encrypt = async () => { throw Error('signer unavailable') }
  expect(await a.sync.save(null)).toBe(false)
  a.sync.close()
  const restarted = harness(identity, a.store)
  await vi.waitFor(() => expect(restarted.events).toHaveLength(1))
  const value = JSON.parse(await identity.nip44!.decrypt(identity.pubkey, restarted.events[0].content))
  expect(value.pairing).toBeNull()
  expect(restarted.adopted).toEqual([null])
  restarted.sync.close()
})

it('does not adopt a late decryption after closing or changing accounts', async () => {
  const a = harness(), b = harness({ ...a.signer, nip44: { ...a.signer.nip44! } })
  await a.sync.save(pair())
  let release!: (value: string) => void
  const original = b.signer.nip44!.decrypt
  b.signer.nip44!.decrypt = () => new Promise(resolve => { release = resolve })
  const receiving = b.sync.receive(a.events[0])
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  b.changeAccount(); b.sync.close()
  release(await original(a.signer.pubkey, a.events[0].content))
  await receiving
  expect(b.adopted).toEqual([])
  a.sync.close()
})

it('rejects forged, misaddressed and oversized events before decryption', async () => {
  const a = harness(), b = harness({ ...a.signer, nip44: { ...a.signer.nip44!, decrypt: vi.fn(a.signer.nip44!.decrypt) } })
  await a.sync.save(pair())
  const event = a.events[0]
  for (const bad of [{ ...event, sig: '0'.repeat(128) }, { ...event, content: 'x'.repeat(16001) }, { ...event, tags: [['d', 'another-record']] }, { ...event, created_at: Math.floor(Date.now() / 1000) + 61 }]) await b.sync.receive(bad)
  expect(b.signer.nip44!.decrypt).not.toHaveBeenCalled()
  expect(b.adopted).toEqual([])
  a.sync.close(); b.sync.close()
})

it('produces a real self-encrypted browser record for independent client interop', async () => {
  const signer = actor(new Uint8Array(32).fill(1)), events: Event[] = []
  const relay: RelayTransport = { publish: async event => { events.push(event) }, subscribe: () => () => {}, close: () => {} }
  const now = 1789000000
  const sync = new SpryAccountSync(memoryDeviceStore(), signer, relay, () => {}, () => {}, () => true, () => now)
  expect(await sync.save(pair())).toBe(true)
  const plain = JSON.parse(await signer.nip44!.decrypt(signer.pubkey, events[0].content))
  expect(plain).toEqual({ v: 1, at: now, pairing: pair() })
  if (process.env.SPRY_ACCOUNT_INTEROP_OUT) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(process.env.SPRY_ACCOUNT_INTEROP_OUT, JSON.stringify({ _fixture: 'Synthetic signer: every private-key byte is 1. Not production credentials.', now, event: events[0], expectedPairing: pair() }, null, 2) + '\n')
  }
  if (process.env.SPRY_ANDROID_INTEROP_IN) {
    const { readFileSync } = await import('node:fs')
    const other = JSON.parse(readFileSync(process.env.SPRY_ANDROID_INTEROP_IN, 'utf8'))
    const adopted: unknown[] = []
    const reader = new SpryAccountSync(memoryDeviceStore(), signer, relay, value => adopted.push(value), () => {}, () => true, () => now + 60)
    await reader.receive(other.paired); await reader.receive(other.removed); await reader.receive(other.paired)
    expect(adopted).toEqual([pair(), null])
    reader.close()
  }
  sync.close()
})
