/**
 * The contact book: people this browser holds a contact card for.
 *
 * A contact card (`nostr-contact-card`, the profile's draft) is one link
 * or QR that makes a stranger a contact, names their box and starts a
 * bond. Reading one needs nothing from the network and yields: the
 * person's key and name, their public relays, their rendezvous key and a
 * fresh ephemeral for deriving private rendezvous material later, and
 * each box they endorse, with the Link address card inside it verified
 * and its node id pinned from this first read on. What this module keeps
 * is exactly that, per person, per browser, never published: a card is a
 * capability to reach a box and to derive keys with a person, and it is
 * handed to the person it is for.
 *
 * Two things the draft asks of a reader live here and nowhere else. The
 * node id a person endorsed is pinned per box, so a later fresh address
 * from the box is accepted only under that id. And the highest Link card
 * serial accepted per node is kept, because that is what stops an old
 * card of the same node replaying (Link SPEC §2.3 rule 8); without it any
 * unexpired old card would do.
 *
 * A participant whose key matches a card is shown as carrying one. Link
 * relay hints locate the box's transport session; they do not establish
 * ownership of a Nostr message relay. The bond handshake is kept for the
 * ceremony that makes kith; the card alone is ken.
 *
 * Pure functions over the injected store, like the others in this app.
 */
import { readCard, refreshBox, type Card, type Box, type LinkCard, type BondHandshake } from 'nostr-contact-card'
import type { DeviceStore } from './device-store.js'

export const CONTACT_PREFIX = 'kithmoot.contact.v1.'
export const RENDEZVOUS_KEY = 'kithmoot.rendezvous.v1'
/** How many contacts a browser keeps. Generous, because forgetting one
 *  silently turns a known box back into a public relay. */
export const MAX_CONTACTS = 500

const HEX64 = /^[0-9a-f]{64}$/

/** One box a contact endorsed, as this browser holds it. */
export interface ContactBox {
  /** The box's own key. */
  p: string
  claim: string
  /** The Link node id the person endorsed by signing the card; pinned. */
  nodeId: string
  /** The highest Link card serial accepted for this node. */
  highestSerial: number
  relays: string[]
  onions: string[]
  carriers?: string[]
  /** When the Link card this browser last accepted for the box expires. */
  linkExpiresAt: number
  /** Whether the box is dialled on the card's endorsement or on a fresh
   *  Link card fetched from the box; the client shows which. */
  source: 'card' | 'refreshed'
  refreshedAt?: number
}

export interface Contact {
  p: string
  name?: string
  rz: string
  eph: string
  relays: string[]
  boxes: ContactBox[]
  attest?: string
  bond?: BondHandshake
  issued: number
  expires: number
  /** Unix seconds this browser read the card. */
  readAt: number
}

export type AddResult =
  | { ok: true; contact: Contact; replaced: boolean }
  | { ok: false; step: 1 | 2 | 3 | 4 | 5; reason: string; words: string }

/** The sentence a person is shown for each step the draft names. */
export const STEP_WORDS: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: 'This is not a contact card: it does not decode as one.',
  2: 'This card has a field in the wrong shape and cannot be trusted.',
  3: 'This card has expired, or its dates do not make sense.',
  4: 'This card’s signature does not verify under the key it names.',
  5: 'This card endorses a box whose address card does not verify.',
}

function keyFor(p: string): string {
  return CONTACT_PREFIX + p
}

function validBox(b: unknown): b is ContactBox {
  if (!b || typeof b !== 'object') return false
  const x = b as Record<string, unknown>
  return HEX64.test(String(x.p)) && HEX64.test(String(x.nodeId)) && typeof x.claim === 'string' &&
    Number.isSafeInteger(x.highestSerial) && Array.isArray(x.relays) && Array.isArray(x.onions) &&
    typeof x.linkExpiresAt === 'number' && (x.source === 'card' || x.source === 'refreshed')
}

function readStored(store: DeviceStore, p: string): Contact | undefined {
  let raw: unknown
  try { raw = JSON.parse(store.get(keyFor(p)) ?? '') } catch { return undefined }
  if (!raw || typeof raw !== 'object') return undefined
  const c = raw as Partial<Contact>
  // A hand-edited or half-written entry is dropped rather than trusted:
  // this decides which relays are shown as sheltered.
  if (c.p !== p || !HEX64.test(String(c.rz)) || typeof c.eph !== 'string' || !Array.isArray(c.relays) || !Array.isArray(c.boxes)) return undefined
  if (!c.boxes.every(validBox)) return undefined
  if (typeof c.issued !== 'number' || typeof c.expires !== 'number' || typeof c.readAt !== 'number') return undefined
  return c as Contact
}

function write(store: DeviceStore, contact: Contact): void {
  store.set(keyFor(contact.p), JSON.stringify(contact))
}

/** Every contact this browser holds, most recently read first. */
export function contacts(store: DeviceStore): Contact[] {
  const out: Contact[] = []
  for (const key of store.keys()) {
    if (!key.startsWith(CONTACT_PREFIX)) continue
    const p = key.slice(CONTACT_PREFIX.length)
    if (!HEX64.test(p)) continue
    const c = readStored(store, p)
    if (c) out.push(c)
  }
  return out.sort((a, b) => b.readAt - a.readAt)
}

export function contactFor(store: DeviceStore, p: string): Contact | undefined {
  const key = p.toLowerCase()
  if (!HEX64.test(key)) return undefined
  return readStored(store, key)
}

export function forgetContact(store: DeviceStore, p: string): void {
  const key = p.toLowerCase()
  if (!HEX64.test(key)) return
  store.remove(keyFor(key))
}

function boxFrom(box: Box, link: LinkCard, previous: ContactBox | undefined): ContactBox {
  // The same node under a new card from the person keeps the serial this
  // browser reached; a different node id is a new pin and starts afresh.
  const samePin = previous?.nodeId === link.nodeId
  return {
    p: box.p,
    claim: box.claim,
    nodeId: link.nodeId,
    highestSerial: samePin ? Math.max(previous!.highestSerial, link.serial) : link.serial,
    relays: link.relays,
    onions: link.onions,
    ...(box.carriers ? { carriers: box.carriers } : {}),
    linkExpiresAt: link.expiresAt,
    source: 'card',
  }
}

/**
 * Read a card (a link, or the card itself) and keep it. A second card from
 * the same person replaces the first: a new card is how a person endorses
 * a new box, a new rendezvous index or a new name. A box already held
 * keeps the highest serial this browser accepted for its node when the
 * node id is unchanged.
 */
export function addContactFromCard(store: DeviceStore, text: string, now: number): AddResult {
  const r = readCard(text.trim(), now)
  if (!r.ok) return { ok: false, step: r.step, reason: r.reason, words: STEP_WORDS[r.step] }
  const card: Card = r.card
  const previous = readStored(store, card.p)
  if (!previous && contacts(store).length >= MAX_CONTACTS) {
    return { ok: false, step: 2, reason: 'contact book is full', words: `This browser keeps at most ${MAX_CONTACTS} contacts. Forget one to add another.` }
  }
  const boxes = r.boxes.map(({ box, link }) => boxFrom(box, link, previous?.boxes.find((b) => b.p === box.p)))
  const contact: Contact = {
    p: card.p,
    ...(card.name !== undefined ? { name: card.name } : {}),
    rz: card.rz,
    eph: card.eph,
    relays: card.relays,
    boxes,
    ...(card.attest !== undefined ? { attest: card.attest } : {}),
    ...(card.bond !== undefined ? { bond: card.bond } : {}),
    issued: card.issued,
    expires: card.expires,
    readAt: now,
  }
  write(store, contact)
  return { ok: true, contact, replaced: previous !== undefined }
}

/**
 * A fresh Link card from one of a contact's boxes, in whatever shape the
 * box publishes it. Accepted only under the node id the person endorsed
 * and only above the highest serial this browser has accepted for it;
 * then the box's relays move to the fresh card and the box is marked as
 * dialled on a refreshed card rather than on the person's endorsement.
 */
export function refreshContactBox(store: DeviceStore, contactP: string, boxP: string, freshLinkCard: Uint8Array, now: number): { ok: true; box: ContactBox } | { ok: false; reason: string } {
  const contact = contactFor(store, contactP)
  if (!contact) return { ok: false, reason: 'no such contact' }
  const i = contact.boxes.findIndex((b) => b.p === boxP.toLowerCase())
  if (i < 0) return { ok: false, reason: 'this contact endorses no such box' }
  const held = contact.boxes[i]!
  const v = refreshBox(held.nodeId, freshLinkCard, now, held.highestSerial)
  if (!v.ok) return { ok: false, reason: v.reason }
  const box: ContactBox = {
    ...held,
    highestSerial: Math.max(held.highestSerial, v.link.serial),
    relays: v.link.relays,
    onions: v.link.onions,
    linkExpiresAt: v.link.expiresAt,
    source: 'refreshed',
    refreshedAt: now,
  }
  contact.boxes[i] = box
  write(store, contact)
  return { ok: true, box }
}

/** A relay that is a contact's box, and whose. */
export interface CircleRelay {
  url: string
  /** The contact's key. */
  contact: string
  name?: string
  /** The box's key. */
  box: string
  source: 'card' | 'refreshed'
}

/**
 * Contact cards carry Link transport hints, not Nostr storage endpoints.
 * Keep this attribution seam closed until a box's signed status, claim
 * binding and endpoint have been verified. This also prevents cards saved
 * by older clients from upgrading third-party transport relays to sheltered.
 * Explicit circle-box marks in relay settings are independent of the book.
 */
export function circleRelays(_store: DeviceStore): Map<string, CircleRelay> {
  return new Map()
}

/**
 * This browser's rendezvous secret, for the cards it hands out: a fresh
 * 32-byte secret made here and kept here, never the identity key. The
 * profile wants it as a child of a root the signer holds; this browser
 * has no root, so its rendezvous key is its own and rotates by being
 * replaced. Undefined until a card is first made.
 */
export function myRendezvousSecret(store: DeviceStore, make: () => Uint8Array): Uint8Array {
  const raw = store.get(RENDEZVOUS_KEY)
  if (raw && HEX64.test(raw)) return hexToBytes(raw)
  const fresh = make()
  if (fresh.length !== 32) throw new Error('a rendezvous secret is 32 bytes')
  store.set(RENDEZVOUS_KEY, bytesToHex(fresh))
  return fresh
}

/** Rotate: forget the rendezvous secret, so the next card carries a new one. */
export function rotateRendezvous(store: DeviceStore): void {
  store.remove(RENDEZVOUS_KEY)
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}
