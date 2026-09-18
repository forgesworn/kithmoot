/**
 * Fixed media slots: the sender half of D1, section 3.1 of the call
 * reliability design.
 *
 * A profile-1 connection carries as many m-lines as it has ever carried
 * tracks. `addTrack` can only reuse a transceiver whose sender has never sent
 * anything, so a camera turned off and on again costs a fresh m-line, a fresh
 * offer and a fresh answer - and one lost answer in that exchange leaves the
 * pair blind for the rest of the call. That is H1, and it is not a bug in the
 * negotiation: it is what track-shaped negotiation costs.
 *
 * So a profile-2 connection has four `sendrecv` transceivers for its whole
 * life, in a fixed order, whether or not anything is attached to them, and a
 * camera toggle becomes `replaceTrack` - no SDP, no signal, nothing to lose.
 * This module owns nothing but those four: it does not negotiate, does not
 * know what a generation is and never touches the wire.
 *
 * Amendment A1 is the one rule that has to be obeyed from outside: **only the
 * side that opens the generation creates them**. JSEP lets an incoming m-line
 * adopt an unassociated transceiver only when that transceiver came from
 * `addTrack`, so four slots opened with `addTransceiver` on the answering side
 * cannot absorb the offerer's four m-lines. The browser makes four more, and
 * the pair ends up with eight. `open()` is therefore the offerer's call and
 * `bind()` the answerer's, and there is deliberately no method that does both.
 */

import type { RtpTransceiverLike, RTCPeerConnectionLike } from './peer.js'
import type { TrackRole } from './types.js'

/**
 * The slot order, and it is a wire fact rather than a preference: it is the
 * order the m-lines appear in, and both ends read the same offer's `slots`
 * map, so the order only has to be stable, not meaningful. Audio first so a
 * pair whose video is refused still bundles its microphone on m-line zero.
 */
export const SLOT_ORDER: readonly TrackRole[] = ['mic', 'camera', 'screen', 'screen-audio']

/** Which kind of m-line each slot is. Fixed for the life of the connection:
 *  a slot never changes kind, which is why `replaceTrack` can never fail for
 *  a reason the caller could have avoided. */
export const SLOT_KINDS: Readonly<Record<TrackRole, 'audio' | 'video'>> = {
  mic: 'audio',
  camera: 'video',
  screen: 'video',
  'screen-audio': 'audio',
}

/** A connection that can open and enumerate slots. Every real
 *  `RTCPeerConnection` can; a test double or a Node adapter written before
 *  any of this existed cannot, which is why they are optional on
 *  `RTCPeerConnectionLike` and checked for here. */
export interface SlotConnection extends RTCPeerConnectionLike {
  addTransceiver(kind: 'audio' | 'video', init?: { direction?: RTCRtpTransceiverDirection }): RtpTransceiverLike
  getTransceivers(): readonly RtpTransceiverLike[]
}

/** Whether this connection can carry fixed slots at all. */
export function supportsSlots(pc: RTCPeerConnectionLike): pc is SlotConnection {
  return typeof pc.addTransceiver === 'function' && typeof pc.getTransceivers === 'function'
}

/**
 * How a caller says which of its tracks is which slot.
 *
 * The application knows - it publishes a `TrackAdvert` with exactly this role
 * on it - so the honest interface is to ask rather than to guess. `inferRoles`
 * is the fallback for a caller that has not been taught to say yet, and it is
 * a fallback and not a design: two cameras, or a screen share with no camera,
 * are both shapes it gets wrong.
 */
export type RoleResolver = (track: MediaStreamTrack) => TrackRole | undefined

/**
 * Guess a role per track from kind and order: first audio is the microphone,
 * first video the camera, second video the screen, second audio the screen's
 * audio. The same order `SLOT_ORDER` uses, and the order the app happens to
 * publish in today.
 */
export function inferRoles(tracks: readonly MediaStreamTrack[]): Map<MediaStreamTrack, TrackRole> {
  const roles = new Map<MediaStreamTrack, TrackRole>()
  let audio = 0
  let video = 0
  for (const track of tracks) {
    if (track.kind === 'audio') roles.set(track, audio++ === 0 ? 'mic' : 'screen-audio')
    else roles.set(track, video++ === 0 ? 'camera' : 'screen')
  }
  return roles
}

/** What a slot is doing, per section 3.1's table. `unbound` is not modelled
 *  as a value because a `SlotSet` only exists once its transceivers do. */
export type SlotState = 'idle' | 'sending' | 'broken'

/**
 * The four slots of one connection.
 *
 * Nothing here emits a signal, and that is the whole point: every state
 * transition in section 3.1 is a `replaceTrack`, which changes no m-line, no
 * mid and no direction, and so gives the far end nothing to renegotiate.
 */
export class SlotSet {
  readonly #byRole = new Map<TrackRole, RtpTransceiverLike>()
  readonly #attached = new Map<TrackRole, MediaStreamTrack | null>()
  readonly #broken = new Set<TrackRole>()
  /** The answerer's map, as the offer stated it. The offerer reads its own
   *  transceivers instead, so this stays empty there until `map()` is
   *  called. */
  #mids = new Map<string, TrackRole>()

  private constructor() {}

  /**
   * Open four idle slots on a connection that is about to offer.
   *
   * Called before `createOffer`, so the offer describes all four; the mids
   * are not real until `setLocalDescription` has been applied, which is why
   * `map()` refuses to answer before then.
   */
  static open(pc: SlotConnection): SlotSet {
    const set = new SlotSet()
    for (const role of SLOT_ORDER) {
      const transceiver = pc.addTransceiver(SLOT_KINDS[role], { direction: 'sendrecv' })
      transceiver.direction = 'sendrecv'
      set.#byRole.set(role, transceiver)
      set.#attached.set(role, null)
    }
    return set
  }

  /**
   * Adopt the transceivers `setRemoteDescription` has just created, by the
   * offer's slot map.
   *
   * Called between `setRemoteDescription(offer)` and `createAnswer`, which is
   * the only window in which the direction can still be widened to
   * `sendrecv`: a remote offer creates its transceivers `recvonly`, and an
   * answer can only ever narrow what it describes, so a slot left alone here
   * is a slot this side can never send on for the life of the generation.
   */
  static bind(pc: SlotConnection, slots: Record<string, TrackRole>): SlotSet {
    const set = new SlotSet()
    const byMid = new Map<string, RtpTransceiverLike>()
    for (const transceiver of pc.getTransceivers()) {
      if (transceiver.mid !== null) byMid.set(transceiver.mid, transceiver)
    }
    for (const [mid, role] of Object.entries(slots)) {
      const transceiver = byMid.get(mid)
      if (!transceiver) continue
      transceiver.direction = 'sendrecv'
      set.#byRole.set(role, transceiver)
      set.#attached.set(role, null)
      set.#mids.set(mid, role)
    }
    return set
  }

  /** How many slots were actually found. Four is the only healthy answer;
   *  fewer means the offer named a mid the connection did not create, which
   *  is a far end that is not speaking this profile. */
  get size(): number {
    return this.#byRole.size
  }

  /** The slot a mid belongs to - the whole of receive-side role resolution
   *  (section 4). Never a track id: a receiver's track id does not match the
   *  sender's in a slot, in any browser measured. */
  roleOf(mid: string | null | undefined): TrackRole | undefined {
    if (mid === null || mid === undefined) return undefined
    const stated = this.#mids.get(mid)
    if (stated !== undefined) return stated
    for (const [role, transceiver] of this.#byRole) if (transceiver.mid === mid) return role
    return undefined
  }

  /**
   * The `slots` map for a generation-opening offer.
   *
   * Returns null until every slot has a mid, because a map with a hole in it
   * would tell the far end to bind three transceivers and invent the fourth -
   * and half a slot map is worse than none, since the far end would answer
   * happily and then never send on the slot it could not find.
   */
  map(): Record<string, TrackRole> | null {
    const map: Record<string, TrackRole> = {}
    for (const role of SLOT_ORDER) {
      const mid = this.#byRole.get(role)?.mid
      if (mid === null || mid === undefined) return null
      map[mid] = role
    }
    return map
  }

  /** What each slot currently holds. Diagnostics and tests. */
  state(role: TrackRole): SlotState {
    if (this.#broken.has(role)) return 'broken'
    return this.#attached.get(role) ? 'sending' : 'idle'
  }

  /** The track a slot is sending, if any. */
  track(role: TrackRole): MediaStreamTrack | null {
    return this.#attached.get(role) ?? null
  }

  /**
   * Detach and re-attach one slot's track, without renegotiating anything.
   *
   * §3.4's repair for the one case the transport cannot explain: the far end
   * says this slot is dead while every other slot on the pair is arriving, so
   * the fault is the encoder or the sender rather than the path. Swapping the
   * track out and back in is what makes a browser start a fresh encode and
   * send a keyframe, and it costs no SDP, no signal and no glare.
   *
   * `ended` is reported rather than repaired: a track whose source has gone -
   * a camera another application took, a microphone that was unplugged - is
   * the application's to replace, and re-attaching a dead one would only make
   * the slot look busy.
   */
  async refresh(role: TrackRole): Promise<'ok' | 'empty' | 'ended' | 'broken'> {
    const transceiver = this.#byRole.get(role)
    const track = this.#attached.get(role) ?? null
    if (!transceiver || !track) return 'empty'
    if (track.readyState === 'ended') return 'ended'
    try {
      await transceiver.sender.replaceTrack(null)
      await transceiver.sender.replaceTrack(track)
      this.#broken.delete(role)
      return 'ok'
    } catch {
      this.#attached.set(role, null)
      this.#broken.add(role)
      return 'broken'
    }
  }

  /**
   * Put this set of tracks in their slots, and empty every slot they do not
   * fill.
   *
   * This is every media change there is on a profile-2 connection: a camera
   * turned on, a share stopped, the mic pipeline swapping its processed track
   * for the raw one, and audience narrowing - which arrives here as an empty
   * list, holds `null` in every slot, and so sends that participant nothing
   * at all, exactly as removing the senders used to.
   *
   * Returns the roles whose `replaceTrack` was rejected. There should never
   * be any: it is the only path in section 3.1 where a slot change still
   * costs a negotiation, and the caller's answer to it is a rebuild.
   */
  async apply(tracks: readonly MediaStreamTrack[], roles: RoleResolver): Promise<TrackRole[]> {
    const wanted = new Map<TrackRole, MediaStreamTrack>()
    for (const track of tracks) {
      const role = roles(track)
      if (role === undefined) continue
      // One advert per role per device is a decode rule on the wire
      // (section 2.1); here it is simply the first writer, because a second
      // track for a slot has nowhere to go.
      if (!wanted.has(role)) wanted.set(role, track)
    }

    const broken: TrackRole[] = []
    for (const [role, transceiver] of this.#byRole) {
      const next = wanted.get(role) ?? null
      if (this.#attached.get(role) === next) continue
      try {
        await transceiver.sender.replaceTrack(next)
        this.#attached.set(role, next)
        this.#broken.delete(role)
      } catch {
        // Never swallowed silently: a slot that will not take a track is the
        // one case a rebuild is the answer to, and the caller decides that.
        this.#broken.add(role)
        broken.push(role)
      }
    }
    return broken
  }
}
