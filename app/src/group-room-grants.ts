/**
 * What this device holds of its room's storage grants (phase S5b).
 *
 * The room's keeper signs a grant for each of this device's keys at each group
 * node and hands them over on the control channel. The receiver keeps the ones
 * addressed to this device, and the revocations and resets it should carry to
 * a node. A grant is a permission the keeper signed, not a secret, but it is
 * also this device's way in, so it is kept under the room and goes with it
 * when the room is forgotten.
 *
 * What is stored is only what the receiver says it holds, and the receiver
 * checks every event again when it is rebuilt: a row altered on the device is
 * dropped, never trusted for having been stored.
 *
 * No DOM and no clock.
 */
import { storageNodeServer } from '@forgesworn/fold-kit'
import { GrantReceiver } from '../../src/group-grants.js'

export const STORAGE_GRANTS_PREFIX = 'kithmoot.storage-grants.v1.'
/** A grant this close to its end, with no renewal, is worth telling the person about. */
export const GRANT_WARNING_SECONDS = 7 * 86_400

interface ReadableStore { getItem(key: string): string | null }
interface WritableStore extends ReadableStore { setItem(key: string, value: string): void; removeItem(key: string): void }

const ROOM = /^[0-9a-f]{64}$/

/** The receiver for a room: rebuilt from what was kept, or empty. */
export function loadGrantReceiver(store: ReadableStore, roomId: string, who: { authority: string; device: string }): GrantReceiver {
  const opts = { authority: who.authority, roomId, device: who.device }
  if (!ROOM.test(roomId)) return new GrantReceiver(opts)
  try {
    const raw = store.getItem(STORAGE_GRANTS_PREFIX + roomId)
    if (raw === null) return new GrantReceiver(opts)
    return GrantReceiver.restore(opts, JSON.parse(raw))
  } catch { return new GrantReceiver(opts) }
}

/** False when the device could not keep it: the grants still apply for this visit. A receiver that holds nothing leaves no row, so a room with no group storage keeps nothing here. */
export function saveGrantReceiver(store: WritableStore, roomId: string, receiver: GrantReceiver): boolean {
  if (!ROOM.test(roomId)) return false
  try {
    const snapshot = receiver.snapshot()
    if (!snapshot.events.length) { store.removeItem(STORAGE_GRANTS_PREFIX + roomId); return true }
    store.setItem(STORAGE_GRANTS_PREFIX + roomId, JSON.stringify(snapshot))
    return true
  } catch { return false }
}

export function forgetGrantReceiver(store: WritableStore, roomId: string): void {
  if (!ROOM.test(roomId)) return
  try { store.removeItem(STORAGE_GRANTS_PREFIX + roomId) } catch { /* Nothing held there. */ }
}

/**
 * When the keeper has gone quiet: this device holds a grant at one or more of
 * the room's nodes, and the newest at every one of them ends within a week.
 * Returns when group files stop working, the latest of those ends (unix
 * seconds). Nothing when any node still has a grant good for longer, or when
 * the device holds none at all (that is a missing grant, not an expiring one).
 */
export function grantsEndingSoon(receiver: GrantReceiver, nodes: readonly string[], now: number): number | undefined {
  let latest = 0
  let held = 0
  for (const base of nodes) {
    const server = storageNodeServer(base)
    if (!server) continue
    const grants = receiver.grantsFor(server, now)
    if (!grants.length) continue
    held++
    const end = Math.max(...grants.map(g => g.expiration))
    if (end - now > GRANT_WARNING_SECONDS) return undefined
    latest = Math.max(latest, end)
  }
  return held > 0 ? latest : undefined
}

/** Whether this device holds an active grant at any of the listed nodes. */
export function holdsAnyGrant(receiver: GrantReceiver, nodes: readonly string[], now: number): boolean {
  return nodes.some(base => {
    const server = storageNodeServer(base)
    return server !== undefined && receiver.grantsFor(server, now).length > 0
  })
}

/** The warning's words. `date` is unix seconds. */
export function grantsEndingWords(date: number, locale?: string): string {
  const day = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(date * 1000))
  return `The group’s keeper has not been online for a while. Group files stop working on ${day} unless it comes back.`
}
