import { finalizeEvent, generateSecretKey, getPublicKey, getEventHash, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { verifyEventUncached as verifyEvent } from './verify.js'
import { KINDS } from './kinds.js'
import { SIGNAL_MAX_AGE_SECONDS } from './signal-guard.js'

// Re-exported here because this is where the staleness rule is applied, even
// though it sits with the other two NIP-AC rules in `signal-guard.ts`.
export { SIGNAL_MAX_AGE_SECONDS }
import { hexEquals, normaliseHex } from './hex.js'
import type { TrackAdvert, TrackRole } from './types.js'

export interface AnnotationPoint { x: number; y: number }
export interface ScreenAnnotation {
  op: 'stroke' | 'clear'
  /** The advertised screen track id: stable across every viewer's layout. */
  shareId: string
  /** Unique within one sending device. Empty only for a clear operation. */
  strokeId: string
  /** Coordinates in the shared image, from zero to one. */
  points?: AnnotationPoint[]
}

export interface SignalBody {
  /**
   * `assist` is not a negotiation step: it is one member asking another to
   * carry a pair it cannot reach directly, and the answer to that request.
   * It rides the same wrap as the rest of signalling because it is exactly as
   * sensitive - it names two devices and says they could not reach each other
   * - and because a second signalling path would be a second set of
   * staleness, dedup and rate-limit rules to get right.
   */
  /**
   * `ack`, `health` and `sync` are profile 2 (see `docs/protocol.md`
   * "Profile 2 additions"): a standalone acknowledgement, a report that one
   * pairwise media slot is dead on an otherwise healthy transport, and "my
   * current generation is this" respectively. An old reader rejects all
   * three exactly as it rejects any other unrecognised type, which is what
   * keeps them addressed only to peers already known to speak profile 2.
   */
  type: 'offer' | 'answer' | 'ice' | 'assist' | 'annotation' | 'ack' | 'health' | 'sync'
  roomId: string
  sdp?: string
  candidate?: string
  trackHints?: TrackAdvert[]
  /** For an `assist` signal: the far end of the pair being asked about. The
   *  sender is the near end, so the pair is fully named without a second
   *  field, and neither end can ask about a pair it is not part of. */
  assist?: string
  /**
   * For an offer: which rung of the route ladder the offerer is on.
   *
   * The two ends of a pair walk the ladder on their own clocks. One that
   * reaches TURN builds a connection with relay candidates and offers on
   * it; the other, still on the direct rung, answered from a connection
   * with no relay candidates, then tore it down on its own timer, and the
   * two chased each other round the ladder without ever meeting. Saying
   * which rung an offer comes from lets the far end hop to the same rung
   * before it answers. Optional and additive: a client that does not send
   * it is answered as before, and one that does not read it behaves as
   * before.
   */
  tier?: 'direct' | 'assist' | 'forwarder' | 'turn'
  /** For an `assist` signal: present on the reply and absent on the request.
   *  A refusal is an ordinary answer - a volunteer with no slots left - and
   *  saying so at once is what lets the asker fall to the next rung rather
   *  than waiting out a timeout. */
  accept?: boolean
  /** Temporary screen-share markup. It uses signalling because that path is
   * encrypted, live and already addressed to every room device. */
  annotation?: ScreenAnnotation

  // --- Profile 2 (docs/protocol.md "Profile 2 additions") ------------------
  // All additive and optional, ignored by an old reader's JSON.parse. See
  // `validSignalExtensions` for the decode-time shape rules.

  /** The pair generation this signal belongs to. Monotonic per pair, never
   *  reused. On every profile-2 signal. */
  gen?: number
  /** The sender's connection instance id, fresh per `RTCPeerConnection`. 16
   *  lower-case hex. On every profile-2 signal. */
  conn?: string
  /** The connection the sender believes it is addressing, when known. 16
   *  lower-case hex. */
  peerConn?: string
  /** Per `conn`, from 1, gapless. On an offer, answer or ice. */
  seq?: number
  /** First seq covered by a batched `ice` signal. */
  first?: number
  /** Batched ICE candidates for a batched `ice` signal. `candidate` stays on
   *  the wire for profile-1 peers. */
  candidates?: string[]
  /** Highest contiguous seq received from `peerConn`, piggybacked wherever
   *  possible. On any type. */
  ack?: number
  /** Seq of the offer an `answer` answers. */
  re?: number
  /** This offer carries an ICE restart inside the current generation. */
  restart?: true
  /** A generation-opening offer's slot map: transceiver mid to the role it
   *  carries. Exactly four entries - mic, camera, screen, screen-audio -
   *  each exactly once. */
  slots?: Record<string, TrackRole>
  /** On a `health` signal: what the sender is receiving from the recipient,
   *  per slot. At least one entry, each role at most once. */
  rx?: Partial<Record<TrackRole, 'ok' | 'dead'>>
}

/** Relay retention hint; local acceptance still uses the signed inner time. */
export const SIGNAL_EXPIRATION_SECONDS = 60
/** Bound attacker-controlled input before signature verification or decryption. */
export const MAX_SIGNAL_WRAP_LENGTH = 131_072
export const SIGNAL_PROFILE = '1'

export interface WrapOptions {
  /** The sending device's secret key. Signs the inner event. */
  senderSk: Uint8Array
  recipientPubkey: string
}

/**
 * Wrap a signal for exactly one peer.
 *
 * An SDP names the sender's network addresses, so it must never sit readable
 * on a public relay. The inner event is signed by the sending device and then
 * wrapped under a fresh random key, so the relay sees neither the payload nor
 * who sent it - only that someone sent something to the recipient.
 */
export function wrapSignal(body: SignalBody, opts: WrapOptions): Event {
  // One captured instant for both layers. Sampling twice can straddle a Unix
  // second: the outer event then appears newer than the signed inner signal,
  // which makes boundary staleness checks nondeterministic.
  const createdAt = Math.floor(Date.now() / 1000)
  const inner = finalizeEvent(
    {
      kind: KINDS.SIGNAL,
      created_at: createdAt,
      tags: [['p', opts.recipientPubkey], ['call-id', body.roomId], ['alt', 'KithMoot call signalling'], ['kithmoot', SIGNAL_PROFILE]],
      content: JSON.stringify(body),
    },
    opts.senderSk,
  )

  const ephemeralSk = generateSecretKey()
  const conversationKey = nip44.v2.utils.getConversationKey(ephemeralSk, opts.recipientPubkey)

  return finalizeEvent(
    {
      kind: KINDS.SIGNAL_WRAP,
      created_at: createdAt,
      tags: [['p', opts.recipientPubkey], ['expiration', String(createdAt + SIGNAL_EXPIRATION_SECONDS)]],
      content: nip44.v2.encrypt(JSON.stringify(inner), conversationKey),
    },
    ephemeralSk,
  )
}

export interface UnwrapOptions {
  recipientSk: Uint8Array
  roomId: string
  /** Unix seconds. Defaults to the real clock; injectable so a test - or a
   *  vector, which is stamped with a fixed time - is not at the mercy of one. */
  now?: number
  /** How far either side of `now` a signal may be stamped before it is
   *  refused. See `SIGNAL_MAX_AGE_SECONDS`. */
  maxAgeSeconds?: number
}

export const MAX_ANNOTATION_POINTS = 128

/** Validate the bounded, normalised shape before a drawing reaches UI code. */
export function validScreenAnnotation(value: unknown): value is ScreenAnnotation {
  if (!value || typeof value !== 'object') return false
  const annotation = value as Partial<ScreenAnnotation>
  if (annotation.op !== 'stroke' && annotation.op !== 'clear') return false
  if (typeof annotation.shareId !== 'string' || annotation.shareId.length < 1 || annotation.shareId.length > 128) return false
  if (typeof annotation.strokeId !== 'string' || annotation.strokeId.length > 128) return false
  if (annotation.op === 'clear') return annotation.strokeId === '' && annotation.points === undefined
  if (annotation.strokeId.length < 1 || !Array.isArray(annotation.points) || annotation.points.length < 2 || annotation.points.length > MAX_ANNOTATION_POINTS) return false
  return annotation.points.every(point =>
    point !== null && typeof point === 'object' &&
    Number.isFinite(point.x) && Number.isFinite(point.y) &&
    point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1,
  )
}

const HEX16_RE = /^[0-9a-f]{16}$/i
const TRACK_ROLES: readonly TrackRole[] = ['camera', 'mic', 'screen', 'screen-audio']
/** Bounds a batched `ice` signal: generous for a single negotiation's
 *  trickle, nowhere near the per-sender rate-limit budget. */
export const MAX_BATCHED_CANDIDATES = 64
export const MAX_CANDIDATE_LENGTH = 2048
const MAX_MID_LENGTH = 16

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}
function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}
function isHex16(value: unknown): value is string {
  return typeof value === 'string' && HEX16_RE.test(value)
}

function validCandidateBatch(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BATCHED_CANDIDATES) return false
  return value.every((c) => typeof c === 'string' && c.length > 0 && c.length <= MAX_CANDIDATE_LENGTH)
}

/**
 * A generation-opening offer's slot map: exactly the four fixed roles
 * (`docs/protocol.md`, section 3.1), each exactly once, keyed by mid. This
 * is the one place the codec can check "kinds matching the m-lines" without
 * seeing the actual SDP - the wire shape itself must name all four roles
 * with no gaps and no repeats.
 */
function validSlotMap(value: unknown): value is Record<string, TrackRole> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length !== TRACK_ROLES.length) return false
  const rolesSeen = new Set<TrackRole>()
  for (const [mid, role] of entries) {
    if (typeof mid !== 'string' || mid.length < 1 || mid.length > MAX_MID_LENGTH) return false
    if (typeof role !== 'string' || !TRACK_ROLES.includes(role as TrackRole)) return false
    if (rolesSeen.has(role as TrackRole)) return false
    rolesSeen.add(role as TrackRole)
  }
  return rolesSeen.size === TRACK_ROLES.length
}

/** A `health` signal's `rx`: at least one slot, each role reported at most once. */
function validRx(value: unknown): value is Partial<Record<TrackRole, 'ok' | 'dead'>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length < 1 || entries.length > TRACK_ROLES.length) return false
  const seen = new Set<string>()
  for (const [role, verdict] of entries) {
    if (!TRACK_ROLES.includes(role as TrackRole)) return false
    if (verdict !== 'ok' && verdict !== 'dead') return false
    if (seen.has(role)) return false
    seen.add(role)
  }
  return true
}

/**
 * Validate every profile-2 field's own shape, strictly, wherever it is
 * present: ranges, hex shapes and lengths, and the slot/health maps' fixed
 * shapes. A present-but-malformed field rejects the whole body rather than
 * being dropped and the rest kept, because these fields drive `Peer`/`Mesh`
 * state machines that cannot recover from a value that merely looks
 * plausible - unlike a roster display name or assist offer, there is no
 * "the entry is still genuinely someone in the room" to fall back to.
 *
 * Deliberately NOT checked here: whether a field belongs on the `type` it
 * arrived with (a `slots` map on something other than a generation-opening
 * offer, `re` without an outstanding offer, and so on), and generation/
 * connection bookkeeping such as `gen` ordering or `(conn, seq)` dedup.
 * Those depend on protocol state this codec does not hold - they are
 * `Peer`/`Mesh` concerns, per section 3 of `docs/protocol.md`'s source
 * spec, not wire-shape ones.
 */
export function validSignalExtensions(body: SignalBody): boolean {
  if (body.gen !== undefined && !isPositiveInt(body.gen)) return false
  if (body.conn !== undefined && !isHex16(body.conn)) return false
  if (body.peerConn !== undefined && !isHex16(body.peerConn)) return false
  if (body.seq !== undefined && !isPositiveInt(body.seq)) return false
  if (body.first !== undefined && !isPositiveInt(body.first)) return false
  if (body.candidates !== undefined && !validCandidateBatch(body.candidates)) return false
  if (body.ack !== undefined && !isNonNegativeInt(body.ack)) return false
  if (body.re !== undefined && !isPositiveInt(body.re)) return false
  if (body.restart !== undefined && body.restart !== true) return false
  if (body.slots !== undefined && !validSlotMap(body.slots)) return false
  if (body.rx !== undefined && !validRx(body.rx)) return false
  // The two new types that carry no other required field are meaningless
  // without the one field that is their whole point.
  if (body.type === 'sync' && !isPositiveInt(body.gen)) return false
  if (body.type === 'health' && body.rx === undefined) return false
  return true
}

/**
 * Unwrap and verify a signal. Returns null for anything that does not check
 * out, and never throws - this runs inside a subscription handler.
 */
export function unwrapSignalEvent(
  wrap: Event,
  opts: UnwrapOptions,
): { id: string; from: string; body: SignalBody } | null {
  try {
    if (wrap.kind !== KINDS.SIGNAL_WRAP || typeof wrap.content !== 'string' || wrap.content.length > MAX_SIGNAL_WRAP_LENGTH) return null
    if (!Array.isArray(wrap.tags) || wrap.tags.length > 16 || wrap.tags.some(t => !Array.isArray(t) || t.length > 8 || t.some(v => typeof v !== 'string' || v.length > 2048))) return null
    if (!verifyEvent(wrap)) return null

    const conversationKey = nip44.v2.utils.getConversationKey(opts.recipientSk, wrap.pubkey)
    let inner = JSON.parse(nip44.v2.decrypt(wrap.content, conversationKey)) as Event
    if (inner.kind === 13) {
      const seal = inner
      if (!verifyEvent(seal)) return null
      const sealKey = nip44.v2.utils.getConversationKey(opts.recipientSk, seal.pubkey)
      inner = JSON.parse(nip44.v2.decrypt(seal.content, sealKey)) as Event
      // A rumor is unsigned. Its author must be the verified seal author,
      // and its id must be its canonical hash, not an attacker-supplied id.
      if (inner.kind !== KINDS.SIGNAL || !hexEquals(inner.pubkey, seal.pubkey)) return null
      if (getEventHash(inner) !== inner.id) return null
    } else if (inner.kind !== KINDS.SIGNAL || !verifyEvent(inner)) return null

    // Staleness, checked on the *inner* event: it is the one the sending
    // device signed, so its timestamp cannot be restamped by whoever replays
    // the wrap. See `SIGNAL_MAX_AGE_SECONDS` for why the window is symmetric.
    const now = opts.now ?? Math.floor(Date.now() / 1000)
    const maxAge = opts.maxAgeSeconds ?? SIGNAL_MAX_AGE_SECONDS
    if (Math.abs(now - inner.created_at) > maxAge) return null

    const body = JSON.parse(inner.content) as SignalBody
    if (!hexEquals(body.roomId, opts.roomId)) return null
    if (!['offer', 'answer', 'ice', 'assist', 'annotation', 'ack', 'health', 'sync'].includes(body.type)) return null
    if (body.type === 'annotation' && !validScreenAnnotation(body.annotation)) return null
    if (!validSignalExtensions(body)) return null
    // Canonicalise the two connection-id fields the same way every other hex
    // identifier on this wire is canonicalised - see `normaliseHex` - so a
    // later `(conn, seq)` dedup or equality check is correct by construction.
    if (body.conn !== undefined) body.conn = normaliseHex(body.conn)
    if (body.peerConn !== undefined) body.peerConn = normaliseHex(body.peerConn)
    const calls = inner.tags.filter(tag => tag[0] === 'call-id')
    if (calls.length > 1 || (calls.length === 1 && !hexEquals(calls[0]?.[1] ?? '', opts.roomId))) return null

    // The inner event must be addressed to us, not merely wrapped to us.
    const addressed = inner.tags.find((t) => t[0] === 'p')?.[1]
    if (addressed === undefined || !hexEquals(addressed, getPublicKey(opts.recipientSk))) return null

    // `from` is a device pubkey entering the system off the wire - the
    // `Mesh` peer map it gets looked up in is keyed by the same normalised
    // form roster decode produces, so this must match. See `normaliseHex`.
    return { id: inner.id, from: normaliseHex(inner.pubkey), body }
  } catch {
    return null
  }
}

/** Preserve the existing public return shape for callers and legacy vectors. */
export function unwrapSignal(wrap: Event, opts: UnwrapOptions): { from: string; body: SignalBody } | null {
  const event = unwrapSignalEvent(wrap, opts)
  return event ? { from: event.from, body: event.body } : null
}
