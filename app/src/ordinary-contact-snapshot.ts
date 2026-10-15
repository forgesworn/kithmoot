import { base64urlnopad } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils'
import { cleanBond, isGoodName, isRelayUrl, verifyLinkCard, MAX_AGE_SECONDS, MAX_RELAYS, MAX_BOXES } from 'nostr-contact-card'
import { sanitiseDisplayName } from '../../src/display-name.js'
import { CONTACT_PREFIX, RENDEZVOUS_KEY, MAX_CONTACTS } from './contact-store.js'
import { VERIFIED_PREFIX, MAX_VERIFIED } from './verified-store.js'
import { OrdinaryStateHold, ORDINARY_VALUE_UNITS } from './ordinary-state-codec.js'

const HEX = /^[0-9a-f]{64}$/
function hold(): never { throw new OrdinaryStateHold() }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      required.some(name => !Object.hasOwn(value,name)) ||
      Reflect.ownKeys(value).some(name => typeof name !== 'string' || !required.includes(name) && !optional.includes(name))) hold()
}
function hex(value: unknown): asserts value is string { if (typeof value !== 'string' || !HEX.test(value)) hold() }
function participant(value: unknown): asserts value is string {
  hex(value); try { schnorr.utils.lift_x(BigInt('0x' + value)) } catch { hold() }
}
function parsed(raw: string): unknown {
  let value: unknown; try { value = JSON.parse(raw) } catch { hold() }
  if (JSON.stringify(value) !== raw) hold()
  return value
}
function relays(value: unknown, max: number): asserts value is string[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => !isRelayUrl(item))) hold()
  // The actual pinned parser permits duplicates, URL queries and spelling
  // that differs from URL.toString(). Never rewrite the retained hints.
}
function bond(value: unknown): void {
  object(value, ['v','pubkey','nonce'], ['displayName','personas'])
  if (Object.hasOwn(value,'personas')) {
    if (!Array.isArray(value.personas)) hold()
    for (const persona of value.personas) object(persona,['pubkey'],['label'])
  }
  if (JSON.stringify(cleanBond(value)) !== JSON.stringify(value)) hold()
}
function box(value: unknown, readAt: number): boolean {
  object(value, ['p','claim','nodeId','highestSerial','relays','onions','linkExpiresAt','source'], ['card','carriers','refreshedAt'])
  hex(value.p); hex(value.claim); hex(value.nodeId)
  if (!integer(value.highestSerial) || !integer(value.linkExpiresAt) || !['card','refreshed'].includes(value.source as string)) hold()
  relays(value.relays,16)
  if (!Array.isArray(value.onions) || value.relays.length + value.onions.length > 16 ||
      value.onions.some(item => typeof item !== 'string' || !/^[a-z2-7]{56}\.onion:[1-9][0-9]{0,4}$/.test(item) || Number(item.split(':')[1]) > 65535)) hold()
  if (Object.hasOwn(value,'carriers') && (!Array.isArray(value.carriers) || value.carriers.length < 1 || value.carriers.length > 8 ||
      value.carriers.some(item => typeof item !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(item)))) hold()
  if (value.source === 'card' && value.linkExpiresAt <= readAt) hold()
  if (value.source === 'refreshed' ? !integer(value.refreshedAt) || value.linkExpiresAt <= value.refreshedAt : Object.hasOwn(value,'refreshedAt')) hold()
  // Older releases retained no card bytes, including refreshed boxes. Keep
  // their pins as inert cache state; they supply no signed discovery evidence.
  if (!Object.hasOwn(value,'card')) return false
  if (typeof value.card !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value.card)) hold()
  let bytes: Uint8Array | undefined
  try {
    bytes = base64urlnopad.decode(value.card)
    if (base64urlnopad.encode(bytes) !== value.card || bytes.length < 126 || bytes.length > 4096) hold()
    // Use the retained card's own embedded lifetime. A new lower/equal-serial
    // endorsement can preserve these bytes but replace the row's hints/time.
    const expires = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getBigUint64(45)
    const historical = Number(expires > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : expires) - 1
    const verified = verifyLinkCard(bytes,historical)
    if (!verified.ok || verified.card.nodeId !== value.nodeId || verified.card.serial !== value.highestSerial) hold()
    if (value.source === 'refreshed') {
      const current = verifyLinkCard(bytes,value.refreshedAt as number)
      if (!current.ok || current.card.expiresAt !== value.linkExpiresAt ||
          JSON.stringify(current.card.relays) !== JSON.stringify(value.relays) || JSON.stringify(current.card.onions) !== JSON.stringify(value.onions)) hold()
    }
    return true
  } finally { bytes?.fill(0) }
}
export interface OrdinaryContactSnapshot {
  readonly contacts: readonly { readonly participant: string; readonly retainedBoxCards: number }[]
  readonly rendezvous: boolean
  readonly observations: readonly { readonly participant: string; readonly observer?: string }[]
}
/** Strict offline custody only. Original signed contact events were omitted
 * by the writer: cached identities, endorsements, claims and observations are
 * not verified authority, even when a retained Link signature is valid.
 * No Contact/BoxDiscovery objects, dial permission, pruning or key generation
 * escape this validator. Production restoration/effects require separate proof.
 * Unscoped observations remain unattributed; no inferred account conversion. */
export function validateOrdinaryContactSnapshot(records: ReadonlyMap<string,string>, _migrated: boolean,
  options: { kind: 'browser' | 'tab' }): OrdinaryContactSnapshot {
  const contacts: { participant: string; retainedBoxCards: number }[] = [], observations: { participant: string; observer?: string }[] = []
  const counts = new Map<string,number>(); let rendezvous = false
  const family = (name: string) => ['contact','rendezvous','verified','checks'].some(part => name === 'kithmoot.' + part || name.startsWith('kithmoot.' + part + '.'))
  if (!['browser','tab'].includes(options.kind)) hold()
  try {
    for (const [physical,raw] of records) {
      let name = physical, wrapped = false
      while (name.startsWith('kithmoot.account.')) {
        const match = /^kithmoot\.account\.[0-9a-f]{64}\.(.+)$/.exec(name)
        if (!match) hold(); name = match[1]!; wrapped = true
      }
      if (!family(name)) continue
      if (wrapped || options.kind !== 'browser' || raw.length > ORDINARY_VALUE_UNITS) hold()
      if (name.startsWith('kithmoot.rendezvous')) {
        if (name !== RENDEZVOUS_KEY) hold(); hex(raw)
        const scalar = hexToBytes(raw)
        try { getPublicKey(scalar) } finally { scalar.fill(0) }
        rendezvous = true; continue
      }
      if (name.startsWith('kithmoot.contact.')) {
        const p = name.slice(CONTACT_PREFIX.length)
        if (!name.startsWith(CONTACT_PREFIX)) hold(); participant(p)
        const value = parsed(raw)
        object(value,['p','rz','eph','relays','boxes','issued','expires','readAt'],['name','attest','bond'])
        if (value.p !== p) hold(); hex(value.rz); hex(value.eph)
        if (Object.hasOwn(value,'name') && !isGoodName(value.name)) hold()
        if (Object.hasOwn(value,'attest') && (typeof value.attest !== 'string' || value.attest.length < 1 || value.attest.length > 512 ||
            value.attest.includes(':') || /[\p{Cc}\p{Cs}\p{Cn}\p{Co}\p{Zl}\p{Zp}\p{Z}\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD\u061C\u180E]/u.test(value.attest))) hold()
        if (Object.hasOwn(value,'bond')) bond(value.bond)
        if (!integer(value.issued) || !integer(value.expires) || !integer(value.readAt) || value.expires <= value.issued ||
            value.expires - value.issued > MAX_AGE_SECONDS || value.issued > value.readAt + 300 || value.readAt >= value.expires) hold()
        relays(value.relays,MAX_RELAYS)
        if (!Array.isArray(value.boxes) || value.boxes.length > MAX_BOXES) hold()
        const retainedBoxCards = value.boxes.filter(item => box(item,value.readAt as number)).length
        contacts.push(Object.freeze({ participant: p, retainedBoxCards }))
        if (contacts.length > MAX_CONTACTS) hold()
      } else {
        const match = /^(?:kithmoot\.checks\.v2\.([0-9a-f]{64})\.)?kithmoot\.verified\.([0-9a-f]{64})$/.exec(name)
        if (!match || !name.startsWith(VERIFIED_PREFIX) && !name.startsWith('kithmoot.checks.v2.')) hold()
        const observer = match[1], p = match[2]!, value = parsed(raw)
        // The verification writer accepts hex shape only, not curve proof.
        object(value,['participant','name','verifiedAt'])
        if (value.participant !== p || typeof value.name !== 'string' || (sanitiseDisplayName(value.name) ?? '') !== value.name || !integer(value.verifiedAt)) hold()
        const namespace = observer ?? 'legacy', count = (counts.get(namespace) ?? 0) + 1; counts.set(namespace,count)
        // An interrupted old set-before-prune or racing oversize image holds
        // intact for recovery rather than discarding the oldest observations.
        if (count > MAX_VERIFIED) hold()
        observations.push(Object.freeze({ participant: p, ...(observer ? { observer } : {}) }))
      }
    }
    contacts.sort((a,b) => a.participant.localeCompare(b.participant)); observations.sort((a,b) => (a.observer ?? '').localeCompare(b.observer ?? '') || a.participant.localeCompare(b.participant))
    return Object.freeze({ contacts: Object.freeze(contacts), rendezvous, observations: Object.freeze(observations) })
  } catch { return hold() }
}
