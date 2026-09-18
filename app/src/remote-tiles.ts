import type { TrackAdvert, TrackRole } from '../../src/types.js'

/**
 * Which remote receiver belongs on which tile, and when a tile is over.
 *
 * The old answer was the sender's track id: a tile was `device|trackId`, and
 * a receiver went wherever an advert named the same id. That is not an
 * identity at all. Chromium takes the receiver's id from the remote `a=msid`
 * appdata, so it usually matches and sometimes does not; Firefox mints its
 * own id that never matches; `replaceTrack` does not update the msid either
 * way. Worse, a sender the far end removed leaves a receiver that stays
 * `live` and muted for ever, and the id-matching fallback would drop that
 * dead receiver into whichever advert slot was free and keep it there - so
 * the genuinely live receiver found the slot taken, fell back to its own
 * browser id, matched no advert, and was taken down as an orphan while its
 * packets were still arriving.
 *
 * The role is the identity instead. A device has at most one camera, one
 * microphone, one screen and one screen sound, the roster already says so,
 * and a role survives `replaceTrack`, a renegotiation, a rebuild and a move
 * to TURN without anybody publishing a new field. `trackId` stays on the
 * wire, but only as the annotation `shareId` and as a hint when matching a
 * receiver here.
 *
 * Nothing in here touches the DOM or the clock, so the whole mapping can be
 * tested without a browser.
 */

export type MediaKind = 'audio' | 'video'

/**
 * The roles a device may send of each kind, best guess first.
 *
 * The order is the tiebreak for a receiver with nothing to go on - a track
 * that arrived ahead of its own advert, which is ordinary on a slow relay.
 * A lone picture is somebody's face far more often than it is their screen.
 */
export const ROLES_BY_KIND: Record<MediaKind, readonly TrackRole[]> = {
  video: ['camera', 'screen'],
  audio: ['mic', 'screen-audio'],
}

export function kindOfRole(role: TrackRole): MediaKind {
  return role === 'mic' || role === 'screen-audio' ? 'audio' : 'video'
}

export function kindOf(kind: string): MediaKind {
  return kind === 'audio' ? 'audio' : 'video'
}

/** The name a tile is held under: the device, and what it is showing. */
export function tileKey(device: string, role: TrackRole): string {
  return `${device}|${role}`
}

export function tileDevice(key: string): string {
  const bar = key.indexOf('|')
  return bar < 0 ? key : key.slice(0, bar)
}

export function tileRole(key: string): TrackRole | undefined {
  const role = key.slice(key.indexOf('|') + 1)
  return role === 'camera' || role === 'mic' || role === 'screen' || role === 'screen-audio' ? role : undefined
}

/**
 * Whether this transceiver is one we are actually receiving on.
 *
 * `sendonly` and `inactive` are precisely the stale receiver above: the far
 * end removed its sender, so the direction it negotiated no longer carries
 * media towards us, but the receiver object and its track live on. `null`
 * means the transceiver has never been negotiated at all. Supported since
 * Chromium 69, Firefox 59 and Safari 12.1, which is every browser this app
 * runs in.
 */
export function isReceiving(direction: string | null | undefined): boolean {
  return direction === 'sendrecv' || direction === 'recvonly'
}

/** The little of a `MediaStreamTrack` this module needs, so tests need no DOM. */
export interface TrackLike {
  readonly id: string
  readonly kind: string
  readonly readyState: string
}

/** One receiver of one remote device, as the page currently sees it. */
export interface ReceiverFacts {
  readonly track: TrackLike
  /** `RTCRtpTransceiver.currentDirection` for the transceiver this receiver sits on. */
  readonly direction: string | null | undefined
  /** Whether inbound RTP for this receiver has moved recently. */
  readonly progressing?: boolean
}

export interface BindInput {
  kind: MediaKind
  /** Every advert this device is publishing; roles of other kinds are ignored. */
  adverts: readonly TrackAdvert[]
  /** Every receiver this page holds for the device, of any kind. */
  receivers: readonly ReceiverFacts[]
  /** What each tile of this kind is showing now, so a working binding holds. */
  bound?: ReadonlyMap<TrackRole, TrackLike>
  /**
   * A track that must be given a role if any is free, whatever its
   * transceiver says. This is the `ontrack` case: the browser has just
   * handed the track over, so it is receiving by definition, and the
   * transceiver may not be findable from the app's side yet.
   */
  prefer?: TrackLike
}

/**
 * Decide which receiver holds each role for one device and one kind.
 *
 * Scored rather than sequential, because every hint is a hint and none of
 * them is proof: an advert whose id matches is the strongest, the binding a
 * tile already has is next - a picture that is playing must not be moved -
 * then a receiver whose packets are moving beats one whose are not, which is
 * the rule that keeps a dead receiver out of a live slot, and finally an
 * advertised role beats an unadvertised one.
 */
export function bindRoles({ kind, adverts, receivers, bound, prefer }: BindInput): Map<TrackRole, TrackLike> {
  const roles = ROLES_BY_KIND[kind]
  // At most one advert per role, first wins: the decode rule of the spec,
  // applied here so a device publishing two cameras cannot open two slots.
  const advertFor = new Map<TrackRole, TrackAdvert>()
  for (const advert of adverts) {
    if (!roles.includes(advert.role)) continue
    if (!advertFor.has(advert.role)) advertFor.set(advert.role, advert)
  }

  /**
   * The direction decides, and packets are the last resort.
   *
   * Two failures, a day apart, and the rule has to answer both. A pair can
   * settle with one end at `sendonly` while the other goes on sending: then
   * the only receiver of its kind says it is not receiving, its packets
   * arrive anyway, and a tile that believed the direction gave that person's
   * microphone no element at all - never decoded, never heard, no way back.
   * But a far end that toggles its camera leaves a receiver behind, and for
   * the grace window after the toggle that stale receiver still reports RTP
   * moving; admitted beside the live one it took the second video slot, and
   * Firefox - whose receiver ids match no advert, ever - put two elements on
   * that person's tile, both showing nothing.
   *
   * So a receiver whose direction does not say it is receiving is admitted
   * ONLY when no receiver of its kind says it is. Not scored against the
   * live one, not ranked below it: rejected outright while a live one
   * exists, because a stale receiver has no business holding any slot. The
   * lying-direction case is exactly the case where there is nothing else.
   */
  const receiving: TrackLike[] = []
  const arrivingOnly: TrackLike[] = []
  for (const facts of receivers) {
    if (kindOf(facts.track.kind) !== kind) continue
    if (facts.track === prefer) continue
    if (facts.track.readyState === 'ended') continue
    if (isReceiving(facts.direction)) receiving.push(facts.track)
    else if (facts.progressing === true) arrivingOnly.push(facts.track)
  }
  const eligible = receiving.length > 0 ? receiving : arrivingOnly
  // `ontrack` is proof in itself: the browser has just handed this track
  // over, so it is receiving whatever a transceiver the app cannot find yet
  // would have said.
  if (prefer && kindOf(prefer.kind) === kind) eligible.unshift(prefer)

  const progressing = new Set<TrackLike>()
  for (const facts of receivers) if (facts.progressing) progressing.add(facts.track)

  const pairs: { role: TrackRole; roleAt: number; trackAt: number; track: TrackLike; score: number }[] = []
  roles.forEach((role, roleAt) => {
    eligible.forEach((track, trackAt) => {
      let score = 0
      if (advertFor.get(role)?.trackId === track.id) score += 8
      if (bound?.get(role) === track) score += 4
      if (progressing.has(track)) score += 2
      if (advertFor.has(role)) score += 1
      pairs.push({ role, roleAt, trackAt, track, score })
    })
  })
  pairs.sort((a, b) => b.score - a.score || a.roleAt - b.roleAt || a.trackAt - b.trackAt)

  const binding = new Map<TrackRole, TrackLike>()
  const placed = new Set<TrackLike>()
  for (const pair of pairs) {
    if (binding.has(pair.role) || placed.has(pair.track)) continue
    binding.set(pair.role, pair.track)
    placed.add(pair.track)
  }
  return binding
}

/**
 * Checks a tile may go without the roster naming its role before the advert
 * half of the liveness rule is satisfied. Three, at the one-second poll: a
 * track that lands ahead of its own advert gets a slow relay's worth of time
 * for the advert to arrive.
 */
export const ORPHAN_CHECKS = 3

/**
 * How long a tile with no advert is kept while its packets keep arriving.
 *
 * The roster stopped being the sole truth about whether media is on. It can
 * be wrong in both directions: a second tab of the same device key publishes
 * presence with no tracks and overwrites the entry, and a heartbeat can be
 * twenty seconds stale. Packets arriving are not an opinion, so a tile is
 * taken down only when the advert has gone AND nothing has arrived for this
 * long.
 */
export const RTP_GRACE_MS = 6000

/**
 * When a tile's element comes down.
 *
 * Holds one counter and one timestamp per tile and no more; the caller owns
 * the clock and the elements. `progressed` is the RTP half of the rule and
 * `gone` is the advert half plus the verdict.
 */
export class TileLiveness {
  readonly #unadvertised = new Map<string, number>()
  readonly #progressedAt = new Map<string, number>()

  /** Inbound RTP for this tile moved at `at`. */
  progressed(key: string, at: number): void {
    this.#progressedAt.set(key, at)
  }

  /** Whether packets for this tile have arrived inside the grace window. */
  progressing(key: string, at: number): boolean {
    const last = this.#progressedAt.get(key)
    return last !== undefined && at - last < RTP_GRACE_MS
  }

  /**
   * Whether this tile should be taken down now. `advertised` is undefined
   * when the roster has nothing to say about the device at all - a device
   * between heartbeats is not a device that has turned everything off.
   */
  gone(key: string, advertised: boolean | undefined, at: number): boolean {
    if (advertised !== false) {
      this.#unadvertised.delete(key)
      return false
    }
    const checks = Math.min((this.#unadvertised.get(key) ?? 0) + 1, ORPHAN_CHECKS)
    this.#unadvertised.set(key, checks)
    if (checks < ORPHAN_CHECKS) return false
    if (this.progressing(key, at)) return false
    this.forget(key)
    return true
  }

  forget(key: string): void {
    this.#unadvertised.delete(key)
    this.#progressedAt.delete(key)
  }

  /** Drop what is remembered about every tile not in `keys`. */
  retain(keys: Iterable<string>): void {
    const live = new Set(keys)
    for (const key of [...this.#unadvertised.keys()]) if (!live.has(key)) this.#unadvertised.delete(key)
    for (const key of [...this.#progressedAt.keys()]) if (!live.has(key)) this.#progressedAt.delete(key)
  }
}
