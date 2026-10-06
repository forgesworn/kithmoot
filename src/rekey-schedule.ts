import { sha256 } from '@noble/hashes/sha2'
import { utf8ToBytes } from '@noble/hashes/utils'
import type { Event } from 'nostr-tools/pure'

/**
 * When a keeper turns a room's key over on a schedule, and who it seals the
 * new key to. Pure: the keeper (`RoomAgent`) asks, and does the rekey.
 *
 * A scheduled rekey is due once the room has been at one epoch for the
 * period plus a jitter, and somebody other than the keeper has said
 * something since the epoch began. A room nobody talks in keeps its key:
 * turning it over would only make every member's device do work, and would
 * move a quiet room's watches on for nothing. The jitter is a hash of the
 * epoch's id, so it needs no state and every restart computes the same
 * moment, and rooms made together do not all rekey in the same minute.
 *
 * A keeper that was offline does one rekey when it is back, if one is
 * overdue; it never makes up the weeks it missed, and no client assumes a
 * regular cadence. See `docs/2026-10-05-phase-2a-plan.md`, step 6.
 */

/** The jitter's range: a scheduled rekey lands up to six hours after the
 *  period is up. */
export const REKEY_JITTER_SECONDS = 6 * 3600

/** How often a keeper with a cadence checks whether a rekey is due. */
export const REKEY_CHECK_INTERVAL_MS = 3_600_000

/** The largest rekey a keeper publishes, as the relay frame
 *  `["EVENT", event]` in UTF-8 bytes: the size relays commonly refuse
 *  above. Sealing to the window's devices is what pushes a rekey towards
 *  it; see `capRecipients`. */
export const MAX_REKEY_EVENT_BYTES = 64 * 1024

/** The jitter for one epoch: `sha256(epochId)`, read as a number, modulo
 *  `REKEY_JITTER_SECONDS`. Deterministic. */
export function rekeyJitter(epochId: string): number {
  const hash = sha256(utf8ToBytes(epochId.toLowerCase()))
  // Six bytes is 48 bits, inside a safe integer.
  let n = 0
  for (let i = 0; i < 6; i++) n = n * 256 + hash[i]!
  return n % REKEY_JITTER_SECONDS
}

/** When the room's epoch is old enough to turn over: `epochAt + period +
 *  jitter`, in unix seconds. */
export function rekeyDueAt(epochAt: number, periodSeconds: number, epochId: string): number {
  return epochAt + periodSeconds + rekeyJitter(epochId)
}

/** A message as the due check reads one: who sent it, and when. */
export interface SpokenMessage {
  participant: string
  sentAt: number
}

/** Whether anybody but `keeper` has said anything after `since`. */
export function spokeSince(messages: Iterable<SpokenMessage>, since: number, keeper: string): boolean {
  const self = keeper.toLowerCase()
  for (const m of messages) if (m.sentAt > since && m.participant.toLowerCase() !== self) return true
  return false
}

export interface RekeyDueInput {
  /** Unix seconds. */
  now: number
  /** When the current epoch began: the rekey into it, else what the keeper
   *  kept. */
  epochAt: number
  /** The cadence. Zero or less means never. */
  periodSeconds: number
  /** The current epoch's id (its `d` tag root), which seeds the jitter. */
  epochId: string
  /** The keeper's own participant key: what it says does not count. */
  keeper: string
  /** Every message the keeper can read, across the main chat and every
   *  named channel. */
  messages: Iterable<SpokenMessage>
}

/** Whether a scheduled rekey is due now. */
export function rekeyDue(input: RekeyDueInput): boolean {
  if (!(input.periodSeconds > 0) || !Number.isFinite(input.periodSeconds)) return false
  if (input.now < rekeyDueAt(input.epochAt, input.periodSeconds, input.epochId)) return false
  return spokeSince(input.messages, input.epochAt, input.keeper)
}

/** A device a rekey may be sealed to. */
export interface RecipientCandidate {
  device: string
}

/**
 * The order a scheduled rekey's recipients are kept in when it has to be
 * cut: the devices in the roster now first, in the order given, then every
 * other device seen within the window, most recently seen first. Each
 * device once.
 */
export function orderRecipients<T extends RecipientCandidate>(
  online: readonly T[],
  recent: readonly (T & { seen: number })[],
): T[] {
  const out: T[] = []
  const had = new Set<string>()
  for (const r of online) {
    const d = r.device.toLowerCase()
    if (had.has(d)) continue
    had.add(d)
    out.push(r)
  }
  for (const r of [...recent].sort((a, b) => b.seen - a.seen)) {
    const d = r.device.toLowerCase()
    if (had.has(d)) continue
    had.add(d)
    out.push(r)
  }
  return out
}

/** The bytes a relay is sent for `event`. */
export function eventFrameBytes(event: Event): number {
  return utf8ToBytes(JSON.stringify(['EVENT', event])).length
}

/**
 * Encode a rekey for as many of `ordered` as fit in `maxBytes`, keeping
 * those at the front. A device cut off asks the keeper's desk for the epoch
 * when it is next online, as every device not sealed to always has.
 *
 * Nothing is cut when even no recipients would not fit (a member list too
 * long for one event): cutting would only lose copies without making the
 * event publishable, and that limit is the rekey-split work of phase 4.
 */
export function capRecipients<T>(
  ordered: readonly T[],
  encode: (recipients: readonly T[]) => Event,
  maxBytes = MAX_REKEY_EVENT_BYTES,
): { event: Event; kept: number } {
  let n = ordered.length
  let event = encode(ordered)
  let size = eventFrameBytes(event)
  if (size <= maxBytes || n === 0) return { event, kept: n }
  const base = eventFrameBytes(encode([]))
  if (base > maxBytes) return { event, kept: n }
  while (size > maxBytes && n > 0) {
    // What each copy costs, measured from this encoding; at least one cut
    // per round, so it ends.
    const each = Math.max(1, (size - base) / n)
    n = Math.max(0, n - Math.max(1, Math.ceil((size - maxBytes) / each)))
    event = encode(ordered.slice(0, n))
    size = eventFrameBytes(event)
  }
  return { event, kept: n }
}
