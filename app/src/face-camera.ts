/**
 * One picture per person, however many of their devices are on the call.
 *
 * A person on a laptop and a phone at once can have a camera running on
 * both: the Android client does it on purpose, and a laptop left open on
 * the desk keeps filming after its owner has picked up the phone. Shown
 * as it arrives, that is two pictures of one person - one of them an empty
 * chair - and on their own screen a tile inside a tile. What the people on
 * the call want is the face, so each person is given ONE camera here, and
 * the others are kept playing out of sight, ready for the moment the
 * answer changes.
 *
 * Nothing in here is on the wire. Every device still publishes what it
 * publishes; this is only which of it a page puts on screen.
 *
 * The rule, in order:
 *
 *   1. The device holding this person's microphone, if it has a camera.
 *      The microphone is where they are talking, and that is where they
 *      are sitting - the mic role already follows them from device to
 *      device (see `ParticipantView.mic`).
 *   2. Otherwise the camera most recently started, as far as this page has
 *      seen. A camera somebody has just turned on is the one they meant.
 *   3. Otherwise - two cameras first seen together, typically on joining a
 *      call where both were already running - the lower device id. Arbitrary,
 *      but the same answer on every page, and the same answer twice.
 *
 * Screen shares are never part of this: a share from any device is
 * somebody's work, not their face, and always shows.
 *
 * Pure, and the clock is the caller's, so it is tested without a browser.
 */

/** One camera of one person that this page could show. */
export interface CameraCandidate {
  device: string
  /** When this page first saw this camera running, on any clock that only
   *  goes forward. Absent when it never had the chance to say. */
  since?: number
}

export interface FaceCameraInput {
  /** The device holding this person's microphone, if any. */
  mic?: string
  /** Their cameras with a picture on this page right now. */
  cameras: readonly CameraCandidate[]
}

/** The device whose camera shows this person, or nothing when they have no
 *  camera to show. */
export function faceCamera({ mic, cameras }: FaceCameraInput): string | undefined {
  if (cameras.length === 0) return undefined
  if (mic !== undefined && cameras.some(camera => camera.device === mic)) return mic
  let best = cameras[0]!
  for (const camera of cameras.slice(1)) {
    const a = camera.since ?? -Infinity, b = best.since ?? -Infinity
    if (a > b || (a === b && camera.device < best.device)) best = camera
  }
  return best.device
}

/**
 * When this page first saw each camera, which is the only "most recently
 * started" there is: an advert carries no time, and a heartbeat restating
 * it is not a camera starting. A camera turned off and on again comes back
 * with a new track id, so it is a new camera here and the newest one.
 */
export class CameraClock {
  readonly #seen = new Map<string, number>()

  /** When `device`'s camera `trackId` was first seen, noting it as seen
   *  `now` if it never was. */
  since(device: string, trackId: string, now: number): number {
    const key = `${device}|${trackId}`
    let at = this.#seen.get(key)
    if (at === undefined) { at = now; this.#seen.set(key, at) }
    return at
  }

  /** Forget every camera not among `live`, as `device|trackId` pairs, so a
   *  long call does not keep every camera it ever saw. */
  retain(live: Iterable<readonly [device: string, trackId: string]>): void {
    const keep = new Set<string>()
    for (const [device, trackId] of live) keep.add(`${device}|${trackId}`)
    for (const key of [...this.#seen.keys()]) if (!keep.has(key)) this.#seen.delete(key)
  }
}
