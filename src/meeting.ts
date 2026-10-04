import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { schnorr } from '@noble/curves/secp256k1.js'

/**
 * A moderated meeting, and a recording everybody knows about.
 *
 * A room has no operator, so nothing in the middle can mute anybody. What a
 * room does have is an authority: the key pinned in its link, held by the
 * device that made the room (or by its keeper). That key signs two records
 * here, both carried on the control channel exactly as the room's relay
 * list is - versioned, newest wins, and any member may repost one, because
 * the signature is what counts and not whoever sent it.
 *
 * **The meeting policy** says whether the room is in meeting mode and who
 * the speakers are. In meeting mode a person not on the list has their
 * microphone and camera locked by their own app, and - the half that does
 * not depend on their app being honest - every other app in the room
 * refuses to play what they send anyway. A modified client can still
 * transmit; nobody running an honest one hears or sees it. See
 * `docs/decisions.md`, "A meeting is moderated by the room's authority".
 *
 * **The recording notice** says a recording is running, and who may not
 * pretend otherwise: an honest app records only after its notice is out,
 * and every app shows the notice for as long as it stands. Nothing here can
 * stop a screen recorder outside the app, and the interface says so.
 */

/** More speakers than this is not a meeting with a stage, it is a call. */
export const MAX_MEETING_SPEAKERS = 64

/** How often a running recording's notice is posted again. A notice is
 *  state, not a one-shot request: a member who arrives mid-recording reads
 *  it from the control channel's history, and a repost keeps it there. Not
 *  more often: that history holds the newest 500 messages, and a heartbeat
 *  every minute would push the signed admin and channel lists out of it in
 *  an afternoon. */
export const RECORDING_REPOST_SECONDS = 5 * 60

/** A notice not reposted for this long is shown as unconfirmed rather than
 *  taken down: an app that crashed mid-recording may still have recorded,
 *  and the honest failure is to keep saying so. */
export const RECORDING_STALE_SECONDS = 3 * RECORDING_REPOST_SECONDS

/** A notice not reposted for this long is about a recording that ended
 *  without saying so - an app closed mid-call - and is no longer shown. The
 *  room's authority takes such a notice down sooner, on its next visit. */
export const RECORDING_FORGET_SECONDS = 12 * 60 * 60

/** A raised hand older than this has been forgotten by whoever raised it. */
export const HAND_TTL_SECONDS = 15 * 60

const HEX64 = /^[0-9a-f]{64}$/
const RECORDING_ID = /^[0-9a-f]{32}$/

export interface MeetingPolicy {
  /** Meeting mode: microphones and cameras off for everybody but speakers. */
  on: boolean
  /** Participant pubkeys who may talk and show video. Canonical: lower-case,
   *  deduplicated, sorted. Kept while the mode is off, so turning it back on
   *  restores the stage as it was. */
  speakers: string[]
  /** Newest wins. Unix milliseconds of the change is the natural choice. */
  version: number
}

export interface RecordingNotice {
  /** Whether a recording is running. */
  on: boolean
  /** 16 random bytes, lower-case hex: which recording this is about, so a
   *  stop for one never ends the notice for the next. */
  id: string
  /** Newest wins, as for the policy. */
  version: number
}

/** Canonical speaker list: lower-case, deduplicated, sorted. Throws on
 *  anything that is not a participant pubkey, or on more than the cap. */
export function canonicalSpeakers(speakers: readonly string[]): string[] {
  const out = [...new Set(speakers.map(s => s.toLowerCase()))].sort()
  if (!out.every(s => HEX64.test(s))) throw new Error('a speaker is a 64-character hex pubkey')
  if (out.length > MAX_MEETING_SPEAKERS) throw new Error(`a meeting can have at most ${MAX_MEETING_SPEAKERS} speakers`)
  return out
}

function requireRoomId(roomId: string): string {
  if (!/^[0-9a-f]{64}$/i.test(roomId)) throw new Error('room id must be 64 hex characters')
  return roomId.toLowerCase()
}

function requireVersion(version: number): number {
  if (!Number.isSafeInteger(version) || version < 0) throw new Error('version must be a non-negative integer')
  return version
}

function digest(text: string): Uint8Array {
  return sha256(new TextEncoder().encode(text))
}

function meetingMessage(roomId: string, policy: MeetingPolicy): Uint8Array {
  return digest(`kithmoot/v1/meeting:${requireRoomId(roomId)}:${requireVersion(policy.version)}:${policy.on ? 1 : 0}:${JSON.stringify(policy.speakers)}`)
}

function recordingMessage(roomId: string, notice: RecordingNotice): Uint8Array {
  if (!RECORDING_ID.test(notice.id)) throw new Error('a recording id is 32 lower-case hex characters')
  return digest(`kithmoot/v1/recording:${requireRoomId(roomId)}:${requireVersion(notice.version)}:${notice.id}:${notice.on ? 1 : 0}`)
}

function sign(message: Uint8Array, authoritySk: Uint8Array): string {
  if (authoritySk.length !== 32) throw new Error('authority secret key must be 32 bytes')
  return bytesToHex(schnorr.sign(message, authoritySk))
}

function verify(message: () => Uint8Array, sig: string, authority: string): boolean {
  try {
    const bytes = hexToBytes(sig)
    if (bytes.length !== 64 || !HEX64.test(authority.toLowerCase())) return false
    return schnorr.verify(bytes, message(), hexToBytes(authority))
  } catch {
    return false
  }
}

export function signMeetingPolicy(opts: { roomId: string; policy: MeetingPolicy; authoritySk: Uint8Array }): string {
  const policy = { ...opts.policy, speakers: canonicalSpeakers(opts.policy.speakers) }
  return sign(meetingMessage(opts.roomId, policy), opts.authoritySk)
}

/** Never throws: this runs on anything a relay hands over. A list that is
 *  not already canonical is refused rather than mended, so the list a client
 *  verifies is the list it enforces. */
export function verifyMeetingPolicy(opts: { roomId: string; policy: MeetingPolicy; sig: string; authority: string }): boolean {
  try {
    const canonical = canonicalSpeakers(opts.policy.speakers)
    if (canonical.length !== opts.policy.speakers.length || canonical.some((s, i) => s !== opts.policy.speakers[i])) return false
  } catch {
    return false
  }
  return verify(() => meetingMessage(opts.roomId, opts.policy), opts.sig, opts.authority)
}

export function signRecordingNotice(opts: { roomId: string; notice: RecordingNotice; authoritySk: Uint8Array }): string {
  return sign(recordingMessage(opts.roomId, opts.notice), opts.authoritySk)
}

/** Never throws. */
export function verifyRecordingNotice(opts: { roomId: string; notice: RecordingNotice; sig: string; authority: string }): boolean {
  return verify(() => recordingMessage(opts.roomId, opts.notice), opts.sig, opts.authority)
}

export type MeetingMedia = 'audio' | 'video'

/**
 * Whether `participant` may be heard (`audio`) or seen (`video`) under
 * `policy`. The one rule both ends apply: a sender's app locks what this
 * refuses, and a receiver's app will not play it.
 *
 * Speakers may do both; a speaker's camera is their own choice. A screen
 * share is video and its sound is audio, so an attendee cannot share either.
 * No policy, or a policy that is off, refuses nothing.
 */
export function meetingAllows(policy: MeetingPolicy | undefined, participant: string, _media: MeetingMedia): boolean {
  if (!policy?.on) return true
  return policy.speakers.includes(participant.toLowerCase())
}

/** The policy with `participant` added to, or taken off, the stage, and a
 *  new version. The version never goes backwards, even on a clock that did. */
export function withSpeaker(policy: MeetingPolicy, participant: string, speaking: boolean, nowMs: number): MeetingPolicy {
  const others = policy.speakers.filter(s => s !== participant.toLowerCase())
  const speakers = canonicalSpeakers(speaking ? [...others, participant] : others)
  return { on: policy.on, speakers, version: Math.max(nowMs, policy.version + 1) }
}

/** The policy switched on or off, and a new version. */
export function withMeetingMode(policy: MeetingPolicy, on: boolean, nowMs: number): MeetingPolicy {
  return { on, speakers: [...policy.speakers], version: Math.max(nowMs, policy.version + 1) }
}

/** What a recording notice tells the person looking at the room. */
export type RecordingView =
  | { state: 'off' }
  /** Running, and reposted recently. */
  | { state: 'on'; id: string; since: number }
  /** Said to be running, but not reposted for a while. Still shown: the
   *  honest failure for a notice about recording is to keep showing it. */
  | { state: 'unconfirmed'; id: string; since: number; lastHeard: number }

/**
 * What to show, given the newest verified notice, when this device first saw
 * it running (`since`), when it last saw it posted (`lastHeard`), and now -
 * all unix seconds.
 */
export function recordingView(notice: RecordingNotice | undefined, since: number, lastHeard: number, now: number): RecordingView {
  if (!notice?.on || now - lastHeard > RECORDING_FORGET_SECONDS) return { state: 'off' }
  if (now - lastHeard > RECORDING_STALE_SECONDS) return { state: 'unconfirmed', id: notice.id, since, lastHeard }
  return { state: 'on', id: notice.id, since }
}

/** Every wire-format literal this module owns, frozen for `src/labels.test.ts`. */
export const MEETING_LABELS = [
  'kithmoot/v1/meeting:',
  'kithmoot/v1/recording:',
] as const
