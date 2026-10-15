import { applyProjection, emptyContactsState, pairingFromAck, parsePairingAckV2, parseProjection, projectionByteLength, MAX_WIRE_BYTES,
  type ContactProjectionV2 } from '@forgesworn/signet-contacts'
import { BASIC_CONTACT_SCOPES } from './granted-contacts-client.js'
import { OrdinaryStateHold, ORDINARY_NAME_UNITS, ORDINARY_VALUE_UNITS } from './ordinary-state-codec.js'

const FAMILY = 'kithmoot.contacts'
const KEY = /^kithmoot\.contacts\.v2\.([0-9a-f]{64})\.(pairing|signet-contacts:(state|pending):([0-9a-f]{32}))$/
const HEX = /^[0-9a-f]{64}$/
const PAIRING_SCOPES = [...BASIC_CONTACT_SCOPES, 'signet.contacts.read:tier', 'signet.contacts.read:checks', 'signet.contacts.read:check-records']
function hold(): never { throw new OrdinaryStateHold() }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) hold()
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => same(item, b[i]))
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right, key) && same(left[key], right[key]))
}
function projection(value: unknown, grant: string): ContactProjectionV2 {
  object(value, ['v', 'grantId', 'scopes', 'frontier', 'issuedAt', 'expiresAt', 'contacts'], ['revoked', 'truncated'])
  object(value.frontier, ['maxClock', 'opCount', 'publishedAt', 'deviceId'])
  if (value.grantId !== grant || !integer(value.issuedAt) || !integer(value.expiresAt) ||
      !integer(value.frontier.maxClock) || !integer(value.frontier.opCount) || !integer(value.frontier.publishedAt)) hold()
  // The primary parser enforces consent and item caps, but can drop, cap or
  // sanitise fields. Equality makes every such change a HOLD. The aggregate
  // plaintext ceiling is separate: an over-cap body could never be sealed.
  const parsed = parseProjection(JSON.stringify(value))
  if (!parsed || !same(parsed, value) || parsed.scopes.some(scope => !PAIRING_SCOPES.includes(scope))) hold()
  if (projectionByteLength(parsed) > MAX_WIRE_BYTES) hold()
  return parsed
}

/** Offline custody, never a granted directory, pairing confirmation, block
 * policy or replay authority. Original signed carriers were not retained.
 * Old/orphan grants remain in their physical owner;
 * no current pairing assignment, expiry pruning, signing or decryption occurs.
 * The mandatory complete composite must classify all other private families. */
export function validateOrdinaryGrantedContactSnapshot(records: ReadonlyMap<string, string>, _migrated: boolean,
  options: { kind: 'browser' | 'tab' }): Readonly<{ pairings: number; states: number; pendingLists: number }> {
  if (!['browser', 'tab'].includes(options.kind)) hold()
  const counts = { pairings: 0, states: 0, pendingLists: 0 }
  try {
    for (const [name, raw] of records) {
      if (name.startsWith('kithmoot.account.') && name.includes('.' + FAMILY)) hold()
      if (name !== FAMILY && !name.startsWith(FAMILY + '.')) continue
      const key = KEY.exec(name)
      if (!key || options.kind !== 'browser' || name.length > ORDINARY_NAME_UNITS || typeof raw !== 'string' || raw.length > ORDINARY_VALUE_UNITS) hold()
      const value: unknown = JSON.parse(raw)
      if (JSON.stringify(value) !== raw) hold()
      if (key[2] === 'pairing') {
        if (raw.length > 8192) hold()
        object(value, ['grantId', 'railPubkey', 'projectionTag', 'proposalTag', 'relay', 'grantedCapabilities', 'maxStalenessSeconds', 'pairedAt'])
        if (!integer(value.pairedAt) || value.railPubkey === key[1]) hold()
        // A synthetic challenge only checks the saved shape; it cannot prove
        // the omitted original acknowledgment, consent or human comparison.
        const ack = parsePairingAckV2(JSON.stringify({ ...value, v: 2, challenge: 'stored' }), 'stored')
        if (!ack || !same(pairingFromAck(ack, value.pairedAt), value)) hold()
        if (BASIC_CONTACT_SCOPES.some(scope => !ack.grantedCapabilities.includes(scope)) ||
            ack.grantedCapabilities.some(scope => !PAIRING_SCOPES.includes(scope))) hold()
        counts.pairings++
      } else if (key[3] === 'state') {
        object(value, ['grantId', 'projection', 'receivedAt', 'blockedPubkeys', 'revoked'])
        const grant = key[4]!
        if (value.grantId !== grant || !integer(value.receivedAt) || typeof value.revoked !== 'boolean' ||
            !Array.isArray(value.blockedPubkeys) || value.blockedPubkeys.some(item => typeof item !== 'string' || !HEX.test(item)) ||
            new Set(value.blockedPubkeys).size !== value.blockedPubkeys.length) hold()
        // persistState is reached only after accepting a real projection. A
        // null projection is a loader recovery/default, not a saved writer cut.
        const saved = projection(value.projection, grant)
        if (value.revoked !== (saved.revoked === true)) hold()
        if (value.revoked) {
          if (saved.contacts.length !== 0) hold()
          // Revocation preserves prior sticky blocks and may preserve a newer
          // prior frontier. Neither is reconstructible from this tombstone.
        } else if (!same(applyProjection(emptyContactsState(), saved, value.receivedAt).blockedPubkeys, value.blockedPubkeys)) hold()
        counts.states++
      } else {
        if (!Array.isArray(value) || value.length !== 0) hold()
        // A physical [] is real: reconciliation writes empty pending lists.
        // KithMoot never calls SDK.propose, including its historical clients.
        // SDK-valid nonempty/legacy proposals have no proved app producer and
        // hold intact. Adding proposal UI requires its own reviewed extension.
        counts.pendingLists++
      }
    }
    return Object.freeze(counts)
  } catch { return hold() }
}
