import { normaliseRelayConfig, MAX_POOL_RELAYS, type RelayConfig } from '../../src/relay-pool.js'
import { isInvitationRelays } from '../../src/persistent-invitation.js'
import { canonicalRoomRelays } from '../../src/room-relays.js'
import { parseRoomStorageRecord, ROOM_STORAGE_PREFIX } from './room-storage-record.js'
import { OrdinaryStateHold, ORDINARY_NAME_UNITS, ordinaryUtf8Length } from './ordinary-state-codec.js'

const families = ['kithmoot.relays', 'kithmoot.circle', 'kithmoot.room-relays-fixed', 'kithmoot.room-relays', 'kithmoot.room-storage']
const ROOM = /^[0-9a-f]{64}$/
function hold(): never { throw new OrdinaryStateHold() }
function object(v: unknown, required: string[], optional: string[] = []): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || required.some(k => !Object.hasOwn(v, k))
    || Object.keys(v).some(k => !required.includes(k) && !optional.includes(k))) hold()
}
function dictionary(v: unknown): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) hold()
}
function json(raw: string): unknown {
  const value: unknown = JSON.parse(raw)
  if (JSON.stringify(value) !== raw) hold()
  return value
}

/** Offline count-only custody; saved URLs, marks, signed flags and signature
 * carriers are not routing or authentication authority. The complete-image
 * consumer verifies added-relay signatures against exact retained inviters
 * and holds fixed signed flags without their lost invitation proof. Runtime
 * consumers must re-establish current permission before any dial. */
export function validateOrdinaryRoutingSnapshot(records: ReadonlyMap<string, string>, _migrated: boolean,
  options: { kind: 'browser' | 'tab' }): Readonly<{ savedLists: number; savedScopes: number; relayChoices: number;
    fixedLists: number; fixedRooms: number; fixedChoices: number; markLists: number; marks: number; roomRecords: number; storageRecords: number }> {
  if (!['browser', 'tab'].includes(options.kind)) hold()
  const counts = { savedLists: 0, savedScopes: 0, relayChoices: 0, fixedLists: 0, fixedRooms: 0,
    fixedChoices: 0, markLists: 0, marks: 0, roomRecords: 0, storageRecords: 0 }
  try {
    for (const [name, raw] of records) {
      if (name.startsWith('kithmoot.account.') && families.some(f => name.includes('.' + f))) hold()
      if (!families.some(f => name === f || name.startsWith(f + '.'))) continue
      if (options.kind !== 'browser' || name.length > ORDINARY_NAME_UNITS || typeof raw !== 'string') hold()
      ordinaryUtf8Length(raw)
      const value = json(raw)
      if (name === 'kithmoot.relays.v1') {
        dictionary(value)
        for (const [scope, entries] of Object.entries(value)) {
          if (scope !== 'default' && !/^(room|inherited):[0-9a-f]{64}$/.test(scope)) hold()
          // The constructor can carry a 16-entry list, read-only choices or
          // an old circle:true into a later save of a different scope. Retain
          // those exact writer-supported rows, never turn the mark into trust.
          if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_POOL_RELAYS) hold()
          for (const entry of entries) {
            object(entry, ['url', 'read', 'write'], ['circle'])
            if (Object.hasOwn(entry, 'circle') && entry.circle !== true) hold()
          }
          const normalized = normaliseRelayConfig(entries as RelayConfig[])
          if (normalized.some((r, i) => r.url !== entries[i].url)) hold()
          counts.savedScopes++; counts.relayChoices += entries.length
        }
        counts.savedLists++
      } else if (name === 'kithmoot.circle.v1') {
        // Existing marks are loaded as arbitrary string Set members and a
        // mark/unmark save preserves them. They remain unverified candidates.
        if (!Array.isArray(value) || value.some(v => typeof v !== 'string') || new Set(value).size !== value.length) hold()
        counts.markLists++; counts.marks += value.length
      } else if (name === 'kithmoot.room-relays-fixed.v1') {
        dictionary(value)
        for (const [room, entry] of Object.entries(value)) {
          if (!ROOM.test(room)) hold()
          object(entry, ['c', 'signed'])
          if (typeof entry.signed !== 'boolean' || !isInvitationRelays(entry.c)) hold()
          // A stored signed boolean carries no signature or current membership.
          counts.fixedRooms++; counts.fixedChoices += entry.c.length
        }
        counts.fixedLists++
      } else if (name.startsWith('kithmoot.room-relays.v1.') && ROOM.test(name.slice('kithmoot.room-relays.v1.'.length))) {
        object(value, ['relays', 'version', 'sig'])
        if (!Array.isArray(value.relays) || value.relays.some(v => typeof v !== 'string')
          || !Number.isSafeInteger(value.version) || (value.version as number) < 0
          || typeof value.sig !== 'string' || !/^[0-9a-f]{128}$/.test(value.sig)) hold()
        const relays = value.relays as string[], urls = canonicalRoomRelays(relays)
        if (urls.length !== relays.length || urls.some((u, i) => u !== relays[i])) hold()
        // The physical row omits the authority key. Checking carrier shape is
        // not verifying this signature; no signature or endpoint escapes.
        counts.roomRecords++
      } else if (name.startsWith(ROOM_STORAGE_PREFIX) && ROOM.test(name.slice(ROOM_STORAGE_PREFIX.length))) {
        // The node list the room's authority last signed, with its version, and
        // the op's signature when it came from one. Carrier shape only: the
        // physical row omits the authority key, and a list is where this
        // device may ask for files, never who may be in the room.
        const record = parseRoomStorageRecord(raw)
        if (!record || JSON.stringify(record) !== raw) hold()
        counts.storageRecords++
      } else hold()
    }
    return Object.freeze(counts)
  } catch { return hold() }
}
