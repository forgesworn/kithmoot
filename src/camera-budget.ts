/**
 * What the camera sends in a group call.
 *
 * A call is a full mesh: every connection runs its own encoder, and each
 * one, left to the browser's defaults, climbs towards a ceiling sized for a
 * one-to-one call (about 1.7 Mbit/s for a 640x480 webcam in Chromium). Five
 * other people on camera is then five of those, and what a home uplink can
 * carry runs out well before the call does: every connection's congestion
 * control backs off on its own, nothing shares the link, and the audio on
 * the same uplink queues behind the video. Five full-rate encoders are also
 * the heat on a laptop.
 *
 * So the camera steps down as the call grows, on the same rungs the Android
 * app uses (`VideoLadder` there): two or three recipients get 800 kbit/s at
 * up to 24 frames a second and 540 lines; four or more get 500 kbit/s at up
 * to 15 frames a second and 360 lines. One recipient is a one-to-one call
 * and is left exactly as it was: nothing is set, so the browser's own
 * defaults apply. Every value is a ceiling, never a target - a connection
 * that cannot reach it still backs off - and all of it is applied per
 * sender with `setParameters`, which needs no renegotiation, as people join
 * and leave.
 *
 * Screen shares are not camera video and keep their own budget (see
 * `tuneShareSender`): a track hinted `detail` is never touched here.
 */

export interface CameraRung {
  /** Bits per second, per connection. */
  maxBitrate: number
  maxFramerate: number
  /** Encoded height ceiling; the camera is scaled down to it, never up. */
  maxHeight: number
}

/** Two or three recipients. */
export const CAMERA_RUNG_MEDIUM: Readonly<CameraRung> = Object.freeze({ maxBitrate: 800_000, maxFramerate: 24, maxHeight: 540 })

/** Four or more recipients. */
export const CAMERA_RUNG_SMALL: Readonly<CameraRung> = Object.freeze({ maxBitrate: 500_000, maxFramerate: 15, maxHeight: 360 })

/**
 * The rung for a camera sent on `recipients` connections, or `undefined`
 * for "leave the browser's defaults alone": zero or one recipient is a
 * one-to-one call, or a single connection to a forwarder that fans out on
 * this device's behalf, which uploads one copy and needs no step down.
 */
export function cameraRungFor(recipients: number): Readonly<CameraRung> | undefined {
  if (!Number.isFinite(recipients) || recipients < 2) return undefined
  return recipients <= 3 ? CAMERA_RUNG_MEDIUM : CAMERA_RUNG_SMALL
}

interface ParameterisedSender {
  track?: MediaStreamTrack | null
  getParameters?: () => RTCRtpSendParameters
  setParameters?: (parameters: RTCRtpSendParameters) => Promise<void>
}

/** How far to scale a track down to fit a height ceiling: never up. */
function scaleFor(track: MediaStreamTrack, maxHeight: number): number {
  let height = 0
  try {
    const settings = track.getSettings?.()
    // The short side, so a portrait phone camera is judged like a landscape one.
    height = Math.min(settings?.height ?? 0, settings?.width ?? settings?.height ?? 0)
  } catch { /* a track that hides its size is not scaled */ }
  return height > maxHeight ? height / maxHeight : 1
}

/**
 * Apply a rung (or, with `undefined`, lift one) to one sender, if it is
 * carrying camera video. Returns whether a change was asked of the browser.
 *
 * Only the first encoding is touched, because that is the only one this app
 * makes. A sender whose parameters have no encodings yet (not negotiated, in
 * some engines) is left for a later call; a refusal - a change made during
 * negotiation - is ignored the same way, because the caller applies the rung
 * again once the connection is up. Senders without `setParameters` (Node's
 * WebRTC) are skipped.
 */
export function capCameraSender(sender: unknown, rung: Readonly<CameraRung> | undefined): boolean {
  const s = sender as ParameterisedSender | null
  const track = s?.track
  if (!track || track.kind !== 'video' || track.contentHint === 'detail') return false
  if (typeof s.getParameters !== 'function' || typeof s.setParameters !== 'function') return false
  try {
    const parameters = s.getParameters.call(sender)
    const encoding = parameters.encodings?.[0]
    if (!encoding) return false
    const before = JSON.stringify([encoding.maxBitrate, encoding.maxFramerate, encoding.scaleResolutionDownBy ?? 1])
    if (rung === undefined) {
      delete encoding.maxBitrate
      delete encoding.maxFramerate
      if (encoding.scaleResolutionDownBy !== undefined) encoding.scaleResolutionDownBy = 1
    } else {
      encoding.maxBitrate = rung.maxBitrate
      encoding.maxFramerate = rung.maxFramerate
      encoding.scaleResolutionDownBy = scaleFor(track, rung.maxHeight)
    }
    if (JSON.stringify([encoding.maxBitrate, encoding.maxFramerate, encoding.scaleResolutionDownBy ?? 1]) === before) return false
    void s.setParameters.call(sender, parameters).catch(() => {})
    return true
  } catch {
    return false
  }
}
