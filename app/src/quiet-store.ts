/**
 * What a quiet room keeps on this device between visits: the drop-key
 * counters this device has spent in the current epoch, so a reload inside
 * the hour cannot draw one twice, and the messages queued for a slot that
 * had not come when the page went away, so the person is not told they
 * were sent when they were not. See `src/quiet.ts`.
 *
 * Pure functions over the injected store, like `device-store.ts`.
 */
import type { Event } from 'nostr-tools/pure'
import type { QuietUsedState } from '../../src/quiet.js'
import type { DeviceStore } from './device-store.js'

export const QUIET_PREFIX = 'kithmoot.quiet.v1.'
/** A queued message older than this is not re-queued: the epoch it was
 *  written for has long moved on, and a day-old message sent as new says
 *  something the person did not mean to say now. */
export const QUIET_QUEUE_MAX_AGE_SECONDS = 24 * 3600

export interface QuietState {
  used?: QuietUsedState
  /** The epoch the queued events were written for. */
  epoch?: number
  queued: Event[]
  /** Unix seconds of the last write. */
  at: number
}

const ROOM_ID = /^[0-9a-f]{64}$/

function keyFor(roomId: string): string {
  return QUIET_PREFIX + roomId
}

function validEvent(e: unknown): e is Event {
  if (!e || typeof e !== 'object') return false
  const x = e as Record<string, unknown>
  return typeof x.id === 'string' && typeof x.pubkey === 'string' && typeof x.sig === 'string' &&
    typeof x.kind === 'number' && typeof x.created_at === 'number' && typeof x.content === 'string' && Array.isArray(x.tags)
}

export function loadQuietState(store: DeviceStore, roomId: string, now: number): QuietState {
  const empty: QuietState = { queued: [], at: now }
  if (!ROOM_ID.test(roomId)) return empty
  let raw: unknown
  try { raw = JSON.parse(store.get(keyFor(roomId)) ?? '') } catch { return empty }
  if (!raw || typeof raw !== 'object') return empty
  const v = raw as Partial<QuietState>
  const at = typeof v.at === 'number' ? v.at : 0
  const fresh = now - at <= QUIET_QUEUE_MAX_AGE_SECONDS
  const used = v.used && typeof v.used === 'object' ? (v.used as QuietUsedState) : undefined
  const queued = fresh && Array.isArray(v.queued) ? v.queued.filter(validEvent) : []
  return { ...(used ? { used } : {}), ...(typeof v.epoch === 'number' ? { epoch: v.epoch } : {}), queued, at }
}

export function storeQuietState(store: DeviceStore, roomId: string, state: Omit<QuietState, 'at'>, now: number): void {
  if (!ROOM_ID.test(roomId)) return
  if (!state.used && state.queued.length === 0) { store.remove(keyFor(roomId)); return }
  store.set(keyFor(roomId), JSON.stringify({ ...state, at: now }))
}

export function forgetQuietState(store: DeviceStore, roomId: string): void {
  if (!ROOM_ID.test(roomId)) return
  store.remove(keyFor(roomId))
}
