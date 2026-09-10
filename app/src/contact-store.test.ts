import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, randomBytes } from '@noble/hashes/utils'
import { buildCard, buildLinkCard, cardLink } from 'nostr-contact-card'
import { memoryDeviceStore } from './device-store.js'
import {
  CONTACT_PREFIX, MAX_CONTACTS, STEP_WORDS, addContactFromCard, circleRelays, contactFor, contacts,
  forgetContact, myRendezvousSecret, refreshContactBox, rotateRendezvous,
} from './contact-store.js'

const require = createRequire(import.meta.url)
interface Vectors {
  now: number
  cases: { name: string; expect: { ok: boolean; step?: number }; encoded: string }[]
  refresh: { pinnedNodeId: string; later: number; cases: { name: string; card: string; expect: { ok: boolean }; highestSerial?: number; pinnedNodeId?: string }[] }
}
const vectors = require('nostr-contact-card/vectors/contact-card.json') as Vectors

const NOW = 1_800_000_000
const WEEK = 7 * 24 * 3600
const xonly = (sk: Uint8Array) => bytesToHex(schnorr.getPublicKey(sk))

/** A person with one box, as a card. */
function person(name: string, relays: string[], boxRelays: string[], serial = 1, nodeSecret = randomBytes(32)) {
  const identity = randomBytes(32), node = nodeSecret, boxKey = randomBytes(32)
  const link = buildLinkCard({ nodeSecret: node, issuedAt: NOW - 60, expiresAt: NOW + 6 * 24 * 3600, serial, relays: boxRelays })
  const box = { p: xonly(boxKey), claim: 'c1'.repeat(32), card: Buffer.from(link).toString('base64url') }
  const card = buildCard({ identityPrivateKey: identity, rz: xonly(randomBytes(32)), ephemeralPrivateKey: randomBytes(32), name, relays, boxes: [box], now: () => NOW, ttlSeconds: WEEK })
  return { identity, node, boxKey, box, card, link: cardLink('https://kithmoot.test/j/', card) }
}

describe('the contact book reads cards exactly as the draft does', () => {
  for (const c of vectors.cases) {
    it(`vector ${c.name}`, () => {
      const store = memoryDeviceStore()
      const r = addContactFromCard(store, c.encoded, vectors.now)
      expect(r.ok).toBe(c.expect.ok)
      if (!r.ok) {
        expect(r.step).toBe(c.expect.step)
        expect(r.words).toBe(STEP_WORDS[r.step])
        expect(contacts(store)).toEqual([])
      } else {
        expect(contacts(store).length).toBe(1)
      }
    })
  }
})

describe('the contact book', () => {
  it('keeps a person, their relays, their rendezvous material and their box with the node id pinned', () => {
    const store = memoryDeviceStore()
    const ada = person('Ada', ['wss://relay.example'], ['wss://box.ada.example'], 7)
    const r = addContactFromCard(store, ada.link, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.replaced).toBe(false)
    expect(r.contact.name).toBe('Ada')
    expect(r.contact.p).toBe(ada.card.p)
    expect(r.contact.rz).toBe(ada.card.rz)
    expect(r.contact.eph).toBe(ada.card.eph)
    expect(r.contact.relays).toEqual(['wss://relay.example'])
    expect(r.contact.boxes).toEqual([{
      p: ada.box.p, claim: ada.box.claim, nodeId: expect.stringMatching(/^[0-9a-f]{64}$/), highestSerial: 7,
      relays: ['wss://box.ada.example'], onions: [], linkExpiresAt: NOW + 6 * 24 * 3600, source: 'card', card: ada.box.card,
    }])
    expect(contactFor(store, ada.card.p.toUpperCase())).toEqual(r.contact)
    expect(store.keys()).toEqual([CONTACT_PREFIX + ada.card.p])
    forgetContact(store, ada.card.p)
    expect(contacts(store)).toEqual([])
  })

  it('contact cards cannot grant sheltered status to Link transport relay hints', () => {
    const store = memoryDeviceStore()
    const ada = person('Ada', [], ['wss://box.ada.example', 'wss://Box.Ada.Example/'])
    const rowan = person('Rowan', [], ['wss://box.rowan.example'])
    addContactFromCard(store, ada.link, NOW)
    addContactFromCard(store, rowan.link, NOW + 1)
    const circle = circleRelays(store)
    expect([...circle.keys()]).toEqual([])
    expect(contacts(store)).toHaveLength(2)
    expect(circle.get('wss://box.ada.example/')).toBeUndefined()
    // Reopening the existing stored cards grants no relay ownership either.
    expect(circleRelays(store).size).toBe(0)
    forgetContact(store, ada.card.p)
    expect([...circleRelays(store).keys()]).toEqual([])
  })

  it('a second card from the same person replaces the first, keeping the serial reached for an unchanged node and starting afresh for a new one', () => {
    const store = memoryDeviceStore()
    const node = randomBytes(32)
    const first = person('Ada', [], ['wss://one.example'], 9, node)
    addContactFromCard(store, first.link, NOW)
    // Same person, same box key, same node, a lower serial on the new card: the pin keeps 9.
    const secondLink = buildLinkCard({ nodeSecret: node, issuedAt: NOW - 30, expiresAt: NOW + 3 * 24 * 3600, serial: 4, relays: ['wss://two.example'] })
    const secondCard = buildCard({ identityPrivateKey: first.identity, rz: first.card.rz, ephemeralPrivateKey: randomBytes(32), name: 'Ada L', relays: [], boxes: [{ ...first.box, card: Buffer.from(secondLink).toString('base64url') }], now: () => NOW + 10, ttlSeconds: WEEK })
    const r = addContactFromCard(store, cardLink('https://kithmoot.test/j/', secondCard), NOW + 10)
    expect(r.ok && r.replaced).toBe(true)
    const held = contactFor(store, first.card.p)!
    expect(held.name).toBe('Ada L')
    expect(held.boxes[0]!.highestSerial).toBe(9)
    expect(held.boxes[0]!.relays).toEqual(['wss://two.example'])
    // A new node id under the same box key is a new pin.
    const thirdLink = buildLinkCard({ nodeSecret: randomBytes(32), issuedAt: NOW - 30, expiresAt: NOW + 3 * 24 * 3600, serial: 2, relays: ['wss://three.example'] })
    const thirdCard = buildCard({ identityPrivateKey: first.identity, rz: first.card.rz, ephemeralPrivateKey: randomBytes(32), name: 'Ada', relays: [], boxes: [{ ...first.box, card: Buffer.from(thirdLink).toString('base64url') }], now: () => NOW + 20, ttlSeconds: WEEK })
    addContactFromCard(store, cardLink('https://kithmoot.test/j/', thirdCard), NOW + 20)
    expect(contactFor(store, first.card.p)!.boxes[0]!.highestSerial).toBe(2)
    expect(contacts(store).length).toBe(1)
  })

  it('refreshes a box only under the pinned node id and above the serial reached, and says the box is now dialled on a refreshed card', () => {
    const store = memoryDeviceStore()
    const node = randomBytes(32)
    const ada = person('Ada', [], ['wss://old.example'], 5, node)
    addContactFromCard(store, ada.link, NOW)
    const later = NOW + 8 * 24 * 3600
    const stale = buildLinkCard({ nodeSecret: node, issuedAt: later - 60, expiresAt: later + WEEK - 120, serial: 5, relays: ['wss://stale.example'] })
    expect(refreshContactBox(store, ada.card.p, ada.box.p, stale, later)).toEqual({ ok: false, reason: expect.stringMatching(/serial/) })
    const other = buildLinkCard({ nodeSecret: randomBytes(32), issuedAt: later - 60, expiresAt: later + WEEK - 120, serial: 6, relays: ['wss://other.example'] })
    expect(refreshContactBox(store, ada.card.p, ada.box.p, other, later)).toEqual({ ok: false, reason: 'node id is not the endorsed one' })
    const fresh = buildLinkCard({ nodeSecret: node, issuedAt: later - 60, expiresAt: later + WEEK - 120, serial: 6, relays: ['wss://fresh.example'] })
    const r = refreshContactBox(store, ada.card.p, ada.box.p, fresh, later)
    expect(r.ok).toBe(true)
    const held = contactFor(store, ada.card.p)!.boxes[0]!
    expect(held.source).toBe('refreshed')
    expect(held.highestSerial).toBe(6)
    expect(held.relays).toEqual(['wss://fresh.example'])
    expect(held.refreshedAt).toBe(later)
    expect(circleRelays(store).has('wss://fresh.example/')).toBe(false)
    expect(refreshContactBox(store, ada.card.p, 'f'.repeat(64), fresh, later)).toEqual({ ok: false, reason: 'this contact endorses no such box' })
    expect(refreshContactBox(store, 'f'.repeat(64), ada.box.p, fresh, later)).toEqual({ ok: false, reason: 'no such contact' })
  })

  it('refresh agrees with the draft\'s vectors', () => {
    for (const c of vectors.refresh.cases) {
      const store = memoryDeviceStore()
      // A contact whose box is the vector's node, pinned as the vector pins it.
      const pinned = c.pinnedNodeId ?? vectors.refresh.pinnedNodeId
      const contactP = 'a'.repeat(64), boxP = 'b'.repeat(64)
      store.set(CONTACT_PREFIX + contactP, JSON.stringify({
        p: contactP, rz: 'c'.repeat(64), eph: 'd'.repeat(64), relays: [], issued: 0, expires: 1, readAt: 0,
        boxes: [{ p: boxP, claim: '', nodeId: pinned, highestSerial: c.highestSerial ?? 0, relays: [], onions: [], linkExpiresAt: 0, source: 'card' }],
      }))
      const r = refreshContactBox(store, contactP, boxP, new Uint8Array(Buffer.from(c.card, 'base64url')), vectors.refresh.later)
      expect(r.ok, c.name).toBe(c.expect.ok)
    }
  })

  it('a malformed entry is not a contact, and the book has a ceiling', () => {
    const store = memoryDeviceStore()
    store.set(CONTACT_PREFIX + 'e'.repeat(64), JSON.stringify({ p: 'e'.repeat(64), rz: 'nope', eph: 'x', relays: [], boxes: [{ p: 'y' }], issued: 0, expires: 1, readAt: 0 }))
    expect(contacts(store)).toEqual([])
    expect(contactFor(store, 'e'.repeat(64))).toBeUndefined()
    for (let i = 0; i < MAX_CONTACTS; i++) {
      const p = i.toString(16).padStart(64, '0')
      store.set(CONTACT_PREFIX + p, JSON.stringify({ p, rz: 'c'.repeat(64), eph: 'd'.repeat(64), relays: [], boxes: [], issued: 0, expires: 1, readAt: i }))
    }
    const ada = person('Ada', [], [])
    const r = addContactFromCard(store, ada.link, NOW)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.words).toMatch(/at most/)
  })

  it('this browser\'s rendezvous secret is made once, kept, and rotates by being replaced', () => {
    const store = memoryDeviceStore()
    const first = myRendezvousSecret(store, () => new Uint8Array(32).fill(1))
    expect(myRendezvousSecret(store, () => new Uint8Array(32).fill(2))).toEqual(first)
    rotateRendezvous(store)
    expect(myRendezvousSecret(store, () => new Uint8Array(32).fill(2))).toEqual(new Uint8Array(32).fill(2))
    expect(() => myRendezvousSecret(memoryDeviceStore(), () => new Uint8Array(31))).toThrow(/32 bytes/)
  })
})
