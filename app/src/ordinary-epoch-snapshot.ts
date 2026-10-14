import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { deriveEpoch, MAX_EPOCH, MAX_HISTORY_EPOCHS } from '../../src/epoch.js'
import { ROOM_EPOCH_PREFIX, ROOM_EPOCH_V2_PREFIX } from './room-epoch-store.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'

const HEX = /^[0-9a-f]{64}$/
function hold(): never { throw new OrdinaryStateHold() }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function epoch(value: unknown): value is number { return integer(value) && value <= MAX_EPOCH }
function object(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) hold()
}
function parsed(raw: string): unknown { try { return JSON.parse(raw) } catch { hold() } }
function hex(raw: unknown): asserts raw is string { if (typeof raw !== 'string' || !HEX.test(raw)) hold() }
function members(raw: unknown): string[] {
  if (!Array.isArray(raw)) hold()
  let previous: string | undefined
  for (const member of raw) {
    hex(member)
    if (previous !== undefined && member <= previous) hold()
    previous = member
  }
  return raw as string[]
}
interface Keys { id: string; key: string }
interface Group { roomId: string; account?: string; v1?: Keys & { epoch: number }; v2?: { epoch: number; keys: Map<number, Keys>; secrets: string[] } }
export interface OrdinaryEpochSnapshot {
  readonly rooms: readonly { readonly roomId: string; readonly account?: string; readonly watchedEpoch: number; readonly keptEpoch?: number }[]
}
function derived(n: number, raw: string): Keys {
  const secret = hexToBytes(raw)
  let key: Uint8Array | undefined
  try {
    const keys = deriveEpoch({ epoch: n, secret }); key = keys.key
    return { id: keys.id, key: bytesToHex(key) }
  } catch { return hold() } finally { secret.fill(0); key?.fill(0) }
}
/** Strict custody validation for the two existing epoch-cache formats. Never
 * uses loaders which silently prune malformed history/rosters. A v1-only
 * cache, or v1 ahead of v2 after an older client ran, remains valid custody.
 * No signed rekey/authority evidence is supplied by either cache; the full
 * production inventory and before-transition retention are separate gates. */
export function validateOrdinaryEpochSnapshot(records: ReadonlyMap<string, string>, migrated: boolean): OrdinaryEpochSnapshot {
  const groups = new Map<string, Group>()
  for (const [physical, raw] of records) {
    let name = physical, account: string | undefined
    if (name.startsWith('kithmoot.account.')) {
      const match = /^kithmoot\.account\.([0-9a-f]{64})\.(.+)$/.exec(name)
      if (!match) hold()
      account = match[1]!; name = match[2]!
      if (name.startsWith('kithmoot.account.')) hold()
    }
    if (!name.startsWith('kithmoot.room-epoch.')) continue
    const prefix = [ROOM_EPOCH_PREFIX, ROOM_EPOCH_V2_PREFIX].find(prefix => name.startsWith(prefix))
    if (!prefix || account !== undefined && !migrated) hold()
    const roomId = name.slice(prefix.length)
    if (!HEX.test(roomId)) hold()
    const id = (account ?? 'legacy') + ':' + roomId
    let group = groups.get(id)
    if (!group) { group = { roomId, ...(account ? { account } : {}) }; groups.set(id, group) }
    const value = parsed(raw)
    if (prefix === ROOM_EPOCH_PREFIX) {
      object(value, ['epoch','id','key'])
      if (!epoch(value.epoch) || value.epoch === 0) hold()
      hex(value.id); hex(value.key)
      group.v1 = { epoch: value.epoch, id: value.id, key: value.key }
    } else {
      object(value, ['epoch','secret','past','removed','members'])
      if (!epoch(value.epoch) || value.epoch === 0) hold()
      hex(value.secret)
      if (!Array.isArray(value.past) || value.past.length > MAX_HISTORY_EPOCHS) hold()
      const removed = new Set(members(value.removed))
      if (members(value.members).some(member => removed.has(member))) hold()
      const keys = new Map([[value.epoch, derived(value.epoch, value.secret)]]), secrets = [value.secret]
      let previous = value.epoch
      for (const past of value.past) {
        object(past, ['epoch','secret','leftAt'])
        if (!epoch(past.epoch) || past.epoch >= previous || !integer(past.leftAt)) hold()
        hex(past.secret)
        const kept = derived(past.epoch, past.secret)
        if (past.epoch === 0 && kept.id !== roomId) hold()
        keys.set(past.epoch, kept); secrets.push(past.secret); previous = past.epoch
      }
      group.v2 = { epoch: value.epoch, keys, secrets }
    }
  }
  const scopedRooms = new Set([...groups.values()].filter(group => group.account !== undefined).map(group => group.roomId))
  const ids = new Map<string,string>(), keys = new Map<string,string>(), secrets = new Map<string,string>()
  const claim = (owners: Map<string,string>, value: string, roomId: string) => {
    const prior = owners.get(value)
    if (prior !== undefined && prior !== roomId) hold()
    owners.set(value, roomId)
  }
  const rooms = [...groups.values()].map(group => {
    if (group.account === undefined && scopedRooms.has(group.roomId)) hold()
    const known = group.v1 && group.v2?.keys.get(group.v1.epoch)
    if (known && (known.id !== group.v1!.id || known.key !== group.v1!.key)) hold()
    // Multiple accounts can keep the same room. Two distinct rooms cannot
    // share traffic namespaces or secrets, including retained history.
    for (const value of [...(group.v1 ? [group.v1] : []), ...(group.v2?.keys.values() ?? [])]) {
      claim(ids, value.id, group.roomId); claim(keys, value.key, group.roomId)
    }
    for (const secret of group.v2?.secrets ?? []) claim(secrets, secret, group.roomId)
    return Object.freeze({ roomId: group.roomId, ...(group.account ? { account: group.account } : {}),
      watchedEpoch: Math.max(group.v1?.epoch ?? 0, group.v2?.epoch ?? 0), ...(group.v2 ? { keptEpoch: group.v2.epoch } : {}) })
  })
  rooms.sort((a,b) => a.roomId.localeCompare(b.roomId) || (a.account ?? '').localeCompare(b.account ?? ''))
  return Object.freeze({ rooms: Object.freeze(rooms) })
}
