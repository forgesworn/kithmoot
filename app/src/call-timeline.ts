/**
 * A rolling, redacted timeline of what happened during a call, and a
 * per-pair health summary, both meant for one destination only: pasted into
 * a chat as part of a bug report (see `collectDiagnostics` in `main.ts`).
 *
 * Because of that destination, this module never records and never accepts
 * for recording: SDP bodies, ICE candidate strings, message content, room
 * or participant names, or any key/id longer than an 8-hex short id. Every
 * timeline entry is a timestamp, a short kind, and at most one 8-hex device
 * id plus a handful of words of free text - and the free text is itself
 * checked and truncated before it is kept. When in doubt, a caller's value
 * is dropped rather than passed through.
 */

/** What a timeline entry can be about. Kept short and closed so a caller
 *  cannot smuggle a sentence into what is meant to be a one-word kind. */
export type TimelineKind =
  | 'signal-sent'
  | 'signal-received'
  | 'signal-retransmitted'
  | 'signal-dropped-as-stale'
  | 'signal-dropped-as-old'
  | 'signal-publish-failed'
  | 'signal-handling-failed'
  | 'renegotiation-stalled'
  | 'pair-ladder'
  | 'ice-restart'
  | 'connection-state-change'
  | 'route-tier-change'
  | 'track-added'
  | 'track-removed'
  | 'advert-change'
  | 'tile-bound'
  | 'tile-orphaned'
  | 'autoplay-blocked'
  | 'autoplay-resumed'
  | 'relay-reconnected'
  | 'relay-resubscribed'
  | 'call-tab-lock'
  | 'probe-failed'

export interface TimelineEntry {
  /** Milliseconds since this timeline was created (in practice, since
   *  joining the call - never wall-clock time, which would be one more
   *  thing to think about before pasting the report anywhere). */
  atMs: number
  kind: TimelineKind
  /** An 8-hex short device id, or absent. Never a full pubkey. */
  device?: string
  /** A handful of words. Never SDP, a candidate, message content or a
   *  name - see `sanitiseDetail`. */
  detail?: string
}

/** Newest-last, capped at whichever of these is reached first. */
export const MAX_ENTRIES = 400
export const MAX_AGE_MS = 10 * 60 * 1000

const SHORT_ID_RE = /^[0-9a-f]{8}$/
/** Sixteen or more contiguous hex characters is a full id or a key, on any
 *  reading; nothing this module keeps is ever that long. */
const LONG_HEX_RE = /[0-9a-f]{16,}/i
/** Enough of an SDP or candidate line's own vocabulary to catch a body
 *  passed in by mistake, without trying to fully parse one. */
const SDP_MARKERS = ['v=0', 'm=audio', 'm=video', 'a=candidate', 'a=fingerprint', 'candidate:', 'ice-ufrag', 'ice-pwd']
const MAX_DETAIL_LENGTH = 80

/** An 8-hex short id, or undefined if `value` is not (or cannot be
 *  shortened to) one. Longer hex is truncated only when it is *already*
 *  hex all the way through - a device pubkey shortened the usual way -
 *  never accepted verbatim. */
export function sanitiseDevice(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim().toLowerCase()
  if (SHORT_ID_RE.test(trimmed)) return trimmed
  if (/^[0-9a-f]+$/.test(trimmed) && trimmed.length > 8) return trimmed.slice(0, 8)
  return undefined
}

/** Free text for a timeline entry, stripped of anything that looks like a
 *  key, an id, or an SDP/candidate fragment, and capped to a few words. */
export function sanitiseDetail(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  let text = value.trim()
  if (text === '') return undefined
  if (LONG_HEX_RE.test(text)) return undefined
  const lower = text.toLowerCase()
  if (SDP_MARKERS.some((marker) => lower.includes(marker))) return undefined
  if (text.length > MAX_DETAIL_LENGTH) text = `${text.slice(0, MAX_DETAIL_LENGTH)}...`
  return text
}

export class CallTimeline {
  readonly #now: () => number
  readonly #startedAt: number
  #entries: TimelineEntry[] = []

  constructor(now: () => number = Date.now) {
    this.#now = now
    this.#startedAt = now()
  }

  /** Record one entry. Never throws: a bad `device` or `detail` is simply
   *  dropped from the entry rather than failing the call that reported it. */
  record(kind: TimelineKind, device?: string, detail?: string): void {
    const atMs = this.#now() - this.#startedAt
    this.#entries.push({ atMs, kind, device: sanitiseDevice(device), detail: sanitiseDetail(detail) })
    this.#prune()
  }

  #prune(): void {
    const cutoff = this.#now() - this.#startedAt - MAX_AGE_MS
    while (this.#entries.length > 0 && this.#entries[0].atMs < cutoff) this.#entries.shift()
    while (this.#entries.length > MAX_ENTRIES) this.#entries.shift()
  }

  /** Newest last, as recorded. */
  entries(): readonly TimelineEntry[] {
    return this.#entries
  }

  /** One line per entry, oldest first (newest last), for the bug report. */
  format(): string[] {
    return this.#entries.map((entry) => {
      const parts = [`+${(entry.atMs / 1000).toFixed(1)}s`, entry.kind]
      if (entry.device) parts.push(entry.device)
      if (entry.detail) parts.push(entry.detail)
      return parts.join(' ')
    })
  }
}

// ---------------------------------------------------------------------------
// Advert tracking
// ---------------------------------------------------------------------------

/** One device's currently advertised roles - `mic`, `camera`, `screen`,
 *  `screen-audio` - never a track id, which is not identity on the wire. */
export interface DeviceRoles {
  device: string
  roles: readonly string[]
}

/**
 * Tracks each device's advertised roles across calls to `update`, and
 * reports only what changed - a role gained or lost - never the full
 * roster, which the caller already has elsewhere.
 */
export class AdvertTracker {
  #previous = new Map<string, Set<string>>()

  /** Roles added or removed since the last call, per device, in the order
   *  given. A device not mentioned this time is treated as having no
   *  roles left, so a device that left the room reports its roles removed
   *  exactly once. */
  update(current: DeviceRoles[]): { device: string; added: string[]; removed: string[] }[] {
    const seen = new Set<string>()
    const changes: { device: string; added: string[]; removed: string[] }[] = []
    for (const { device, roles } of current) {
      seen.add(device)
      const before = this.#previous.get(device) ?? new Set<string>()
      const after = new Set(roles)
      const added = roles.filter((role) => !before.has(role))
      const removed = [...before].filter((role) => !after.has(role))
      if (added.length > 0 || removed.length > 0) changes.push({ device, added, removed })
      this.#previous.set(device, after)
    }
    for (const device of [...this.#previous.keys()]) {
      if (seen.has(device)) continue
      const before = this.#previous.get(device)!
      if (before.size > 0) changes.push({ device, added: [], removed: [...before] })
      this.#previous.delete(device)
    }
    return changes
  }
}

// ---------------------------------------------------------------------------
// Per-pair health summary
// ---------------------------------------------------------------------------

/** One inbound counter this pair is being judged on - `packetsReceived` for
 *  audio, `framesDecoded` for video, one entry per receiving slot. */
export interface PairSlotSample {
  /** A short, stable label for this slot within the pair - e.g. `audio`,
   *  `video`, or `video#2` for a second video receiver. Never a track id. */
  label: string
  counter: number
}

/**
 * What a profile-2 pair's own controller says about itself.
 *
 * This is the half of a bug report that used to be missing entirely. The
 * counters below say whether media is moving; these say what the pair thinks
 * about that and what it is doing next - which generation it is on, where it
 * has got to on the health ladder, which slot it has judged dead in each
 * direction, and how much signalling the far end has never acknowledged.
 * "Ada cannot hear Bob" becomes "Ada's pair with Bob is on generation 4,
 * rebuilding, mic dead inbound, two signals unacked" - which names the fault
 * instead of describing the symptom.
 *
 * Every value here is a short word or a small number. No ids, no SDP, no
 * candidates: the same rule the timeline keeps, for the same reason.
 */
export interface PairProfileSample {
  /** Pair generation. Monotonic per pair, never reused. */
  generation: number
  /** Where the pair is on the health ladder of the call reliability design. */
  ladder: string
  /** Signals sent and not yet acknowledged by the far end. */
  unacked: number
  /** Per slot role, what is arriving from the far end. */
  inbound?: Record<string, string>
  /** Per slot role, what RTCP says the far end is receiving from us. */
  rtcp?: Record<string, string>
  /** `negotiationneeded` on a connection whose slots are fixed: always a
   *  bug, and never otherwise visible. */
  unexpectedNegotiations?: number
}

/** One snapshot of one pair, as `collectDiagnostics` already has the data
 *  to build from its existing `getStats()` pass. */
export interface PairSample {
  /** 8-hex short device id. */
  device: string
  tier?: string
  connectionState?: string
  signalingState?: string
  slots: PairSlotSample[]
  /** Whether a `remote-inbound-rtp` report was present for this pair,
   *  meaning the far end is telling us it is receiving our outbound RTP. */
  outboundAcknowledged: boolean
  /** Absent for a profile-1 pair, which is every pair by default. */
  profile?: PairProfileSample
}

/** A slot map as one short, ordered clause: `mic:ok,camera:dead`. Sorted so
 *  two reports of the same state read identically. */
function slotClause(verdicts: Record<string, string> | undefined): string {
  if (!verdicts) return ''
  const parts = Object.entries(verdicts)
    .filter(([role, verdict]) => SAFE_WORD.test(role) && SAFE_WORD.test(verdict))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([role, verdict]) => `${role}:${verdict}`)
  return parts.join(',')
}

/** A slot role and a verdict are both closed vocabularies. Anything that is
 *  not one is dropped rather than printed, on the same principle as
 *  `sanitiseDetail`: a bug report is pasted into a chat. */
const SAFE_WORD = /^[a-z][a-z-]{0,23}$/

/** The profile-2 clause of a pair's line, or nothing at all. */
export function formatPairProfile(profile: PairProfileSample | undefined): string {
  if (!profile) return ''
  const parts = [
    `gen=${Math.trunc(profile.generation)}`,
    `ladder=${SAFE_WORD.test(profile.ladder) ? profile.ladder : '?'}`,
    `unacked=${Math.trunc(profile.unacked)}`,
  ]
  const inbound = slotClause(profile.inbound)
  if (inbound) parts.push(`in[${inbound}]`)
  const rtcp = slotClause(profile.rtcp)
  if (rtcp) parts.push(`rtcp[${rtcp}]`)
  // Only when it has happened: a zero here would be noise on every line of
  // every report, and the number is only ever interesting above zero.
  if (profile.unexpectedNegotiations) parts.push(`unexpected-negotiations=${Math.trunc(profile.unexpectedNegotiations)}`)
  return ` profile2(${parts.join(' ')})`
}

/**
 * Turns single-snapshot stats into "is this actually moving", by keeping the
 * previous snapshot's counters per pair and per slot. A slot with no
 * previous value is reported as a first sample rather than guessed at.
 */
export class PairHealthSampler {
  #previous = new Map<string, Map<string, number>>()

  /** One line per pair, in the order given. */
  snapshot(pairs: PairSample[]): string[] {
    return pairs.map((pair) => this.#line(pair))
  }

  #line(pair: PairSample): string {
    const previous = this.#previous.get(pair.device) ?? new Map<string, number>()
    const next = new Map<string, number>()
    const progress = pair.slots.map((slot) => {
      next.set(slot.label, slot.counter)
      const before = previous.get(slot.label)
      const state = before === undefined ? 'first-sample' : slot.counter > before ? 'moving' : 'stalled'
      return `${slot.label}:${state}`
    })
    this.#previous.set(pair.device, next)
    const unanswered = pair.signalingState === 'have-local-offer'
    return (
      `${pair.device} tier=${pair.tier ?? '?'} conn=${pair.connectionState ?? '?'} sig=${pair.signalingState ?? '?'}` +
      ` inbound[${progress.join(',')}] outboundAcked=${pair.outboundAcknowledged}${unanswered ? ' unanswered-offer' : ''}` +
      formatPairProfile(pair.profile)
    )
  }
}
