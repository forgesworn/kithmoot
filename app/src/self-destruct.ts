/**
 * A room that self-destructs: when it ends, every member's device deletes
 * what it wrote there and forgets the room. This module is what the app
 * decides about one without a browser: the countdown's stage and words, and
 * the tombstone rows a destroyed room leaves in the rooms list.
 *
 * The flag itself rides inside the room's encrypted group invitation and its
 * closing rekey (fold-kit 0.9.0, `destruct`); `rooms-store.ts` keeps it on
 * the saved room so a device that was offline at the end still acts on it
 * the next time it starts. What the tidy-up does is `room-tidy-up.ts`.
 */
import type { DeviceStore } from './device-store.js'
import { formatConferenceEnd } from './conference.js'

/** green, amber, red, then the final minute; `gone` once the end has come. */
export type CountdownStage = 'green' | 'amber' | 'red' | 'final' | 'gone'

/** The last stretch, whatever the room's lifetime: a banner across the chat. */
export const FINAL_SECONDS = 60

/**
 * Where amber and red start, in seconds before the end. They scale with the
 * room's lifetime so a one-day room is not amber from the start: amber is
 * the smaller of a day and a quarter of the lifetime, red the smaller of an
 * hour and a twentieth. A lifetime that is not known (a room joined late, on
 * a device that never saw it made) is taken as long, which gives a day and
 * an hour.
 */
export function countdownThresholds(lifetime: number | undefined): { amber: number; red: number } {
  const life = lifetime !== undefined && Number.isFinite(lifetime) && lifetime > 0 ? lifetime : Number.POSITIVE_INFINITY
  return { amber: Math.min(86_400, life / 4), red: Math.min(3_600, life / 20) }
}

/** The stage a room is in, `remaining` seconds before its end. */
export function countdownStage(remaining: number, lifetime: number | undefined): CountdownStage {
  if (remaining <= 0) return 'gone'
  if (remaining <= FINAL_SECONDS) return 'final'
  const { amber, red } = countdownThresholds(lifetime)
  if (remaining <= red) return 'red'
  if (remaining <= amber) return 'amber'
  return 'green'
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** How long is left, as the pill shows it: "4 days", "1 day 5 h",
 *  "5 h 12 m", "12 m", and a live clock ("42:07") once the room is red. */
export function remainingWords(remaining: number, stage: CountdownStage): string {
  const r = Math.max(0, Math.ceil(remaining))
  if (stage === 'red' || stage === 'final' || stage === 'gone') {
    const m = Math.floor(r / 60), s = r % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }
  const days = Math.floor(r / 86_400)
  const hours = Math.floor((r % 86_400) / 3_600)
  const minutes = Math.floor((r % 3_600) / 60)
  if (days >= 2) return plural(days, 'day')
  if (days === 1) return hours ? `1 day ${hours} h` : '1 day'
  if (hours) return `${hours} h ${minutes} m`
  return `${Math.max(1, minutes)} m`
}

/** The same, in words a screen reader says: "5 hours 12 minutes". */
export function remainingSpoken(remaining: number): string {
  const r = Math.max(0, Math.ceil(remaining))
  const days = Math.floor(r / 86_400)
  const hours = Math.floor((r % 86_400) / 3_600)
  const minutes = Math.floor((r % 3_600) / 60)
  const seconds = r % 60
  if (days >= 2) return plural(days, 'day')
  if (days === 1) return hours ? `1 day ${plural(hours, 'hour')}` : '1 day'
  if (hours) return minutes ? `${plural(hours, 'hour')} ${plural(minutes, 'minute')}` : plural(hours, 'hour')
  if (minutes) return seconds && minutes < 5 ? `${plural(minutes, 'minute')} ${plural(seconds, 'second')}` : plural(minutes, 'minute')
  return plural(seconds, 'second')
}

export interface Countdown {
  stage: CountdownStage
  /** The pill's visible words: "Self-destructs in 5 h 12 m", "Ends in 4 days". */
  text: string
  /** Its accessible name: "Self-destructs in 5 hours 12 minutes". */
  spoken: string
  /** True for a room that self-destructs; false for one that ends and
   *  keeps a read-only copy, whose pill is a neutral grey. */
  destruct: boolean
}

/** The countdown for a room that ends at `endsAt`, as of `now`. */
export function countdown(opts: { endsAt: number; startsAt?: number; destruct: boolean; now: number }): Countdown {
  const remaining = opts.endsAt - opts.now
  const lifetime = opts.startsAt !== undefined && opts.startsAt < opts.endsAt ? opts.endsAt - opts.startsAt : undefined
  const stage = countdownStage(remaining, lifetime)
  const verb = opts.destruct ? 'Self-destructs' : 'Ends'
  if (stage === 'gone') {
    const text = opts.destruct ? 'Self-destructed' : 'Ended'
    return { stage, text, spoken: text, destruct: opts.destruct }
  }
  return {
    stage,
    text: `${verb} in ${remainingWords(remaining, stage)}`,
    spoken: `${verb} in ${remainingSpoken(remaining)}`,
    destruct: opts.destruct,
  }
}

/** What a screen reader is told when a self-destructing room enters a
 *  stage: once per stage, never per tick. Undefined for green and gone. */
export function stageAnnouncement(stage: CountdownStage, remaining: number): string | undefined {
  if (stage === 'amber' || stage === 'red') return `This room self-destructs in ${remainingSpoken(remaining)}.`
  if (stage === 'final') return 'This room self-destructs in under a minute. Save anything you need now.'
  return undefined
}

/** The final minute's banner across the chat. */
export function finalBannerText(remaining: number): string {
  return `This room self-destructs in ${remainingWords(remaining, 'final')}. Save anything you need now.`
}

/** The heads-up at the start of red, through the notification settings. */
export function headsUpText(roomLabel: string, remaining: number): string {
  return `${roomLabel} self-destructs in ${remainingSpoken(remaining)}.`
}

/** A message still waiting to leave when the room self-destructs. */
export const WILL_NOT_BE_SENT = 'Will not be sent: the room is self-destructing'

/** Said once, at creation and in the room details, and never more. */
export const DESTRUCT_PROMISE = 'When this room self-destructs, KithMoot deletes it from every member’s devices and asks the relays to delete its messages. '
  + 'Someone could still have kept a copy, and some relays ignore deletion requests.'

// ---------------------------------------------------------------------------
// Tombstone rows
//
// A destroyed room leaves one greyed row in the rooms list, so nobody is left
// wondering where it went. Owner decision D2: the row names no room, and it
// goes when dismissed or after seven days. Kept under one key that names no
// room either, so the wipe that removes every key naming the room cannot
// take it, and nothing here ties a tombstone to the room it was.
// ---------------------------------------------------------------------------

export const DESTRUCTED_KEY = 'kithmoot.destructed.v1'
export const TOMBSTONE_SECONDS = 7 * 86_400
const MAX_TOMBSTONES = 50

export interface Tombstone {
  /** Random, only to dismiss one row. Not the room's id. */
  id: string
  /** Unix seconds the room self-destructed. */
  at: number
}

function readTombstones(store: DeviceStore): Tombstone[] {
  try {
    const parsed = JSON.parse(store.get(DESTRUCTED_KEY) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((t): t is Tombstone => !!t && typeof t === 'object'
      && typeof (t as Tombstone).id === 'string' && /^[0-9a-f]{16,64}$/.test((t as Tombstone).id)
      && typeof (t as Tombstone).at === 'number' && Number.isFinite((t as Tombstone).at))
  } catch {
    return []
  }
}

function writeTombstones(store: DeviceStore, tombstones: Tombstone[]): void {
  if (tombstones.length) store.set(DESTRUCTED_KEY, JSON.stringify(tombstones))
  else store.remove(DESTRUCTED_KEY)
}

/** The rows to show, newest first. Those older than seven days are dropped
 *  on the way through. */
export function tombstones(store: DeviceStore, now: number): Tombstone[] {
  const all = readTombstones(store)
  const live = all.filter(t => t.at + TOMBSTONE_SECONDS > now)
  if (live.length !== all.length) writeTombstones(store, live)
  return live.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1))
}

/** Leave a tombstone row for a room that self-destructed at `at`. */
export function addTombstone(store: DeviceStore, at: number, id: string): void {
  writeTombstones(store, [...tombstones(store, at), { id, at }].sort((a, b) => b.at - a.at).slice(0, MAX_TOMBSTONES))
}

export function dismissTombstone(store: DeviceStore, id: string): void {
  writeTombstones(store, readTombstones(store).filter(t => t.id !== id))
}

/** A tombstone row's words. */
export function tombstoneText(at: number): string {
  return `A room self-destructed · ${formatConferenceEnd(at)}`
}
