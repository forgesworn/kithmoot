import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2'
import { schnorr } from '@noble/curves/secp256k1.js'
import { KINDS } from './kinds.js'
import { withExpiration } from './expiration.js'
import { verifyDeviceCredential } from './credential.js'
import { verifyEventUncached } from './verify.js'
import { hexEquals, normaliseHex } from './hex.js'
import { sanitiseDisplayName } from './display-name.js'
import { sanitiseAssistOffer } from './peer-assist.js'
import { inspectAgentOwnershipSignature, normaliseAgentOwnership, verifyAgentOwnership } from './ownership.js'
import type { RosterEntry, CallMembership, TrackAdvert, TrackRole } from './types.js'
import { readLiveRecordingState, recordingProfile } from './live-recording.js'
import { sanitiseSpryKey } from './spry-key.js'

export interface EncodeRosterOptions {
  roomId: string
  roomKey: Uint8Array
  deviceSk: Uint8Array
  /** The epoch to publish in: its id is the `d` tag and its key the cipher.
   *  Omit for epoch 0, where both are the room's own. See `epoch.ts`. */
  epoch?: { id: string; key: Uint8Array }
  /** A conference room's end, in unix seconds: carried as a NIP-40
   *  expiration (see `withExpiration`). Omit for a room with no end. */
  expiresAt?: number
  /** Reader-first privacy codec only. Older clients cannot read envelope 2;
   * sessions keep writing the legacy envelope until a separate rollout. */
  envelope?: 2
}

export const ROSTER_ENVELOPE_2 = 'kithmoot/v1/roster-envelope-2'
/** Maximum UTF-8 wire size, checked before signature verification or decryption. */
export const MAX_ROSTER_EVENT_BYTES = 131_072

/** Bind the exact JSON bytes to this room, epoch, outer author and timestamp. */
export function rosterEnvelope2Digest(roomId: string, d: string, outer: string, createdAt: number, body: string): Uint8Array {
  return sha256(new TextEncoder().encode(`${ROSTER_ENVELOPE_2}:${normaliseHex(roomId)}:${normaliseHex(d)}:${normaliseHex(outer)}:${createdAt}:${body}`))
}

/** Bound every signed field before hashing it, and refuse ambiguous routing. */
function boundedRosterEvent(event: Event): boolean {
  if (typeof event.content !== 'string' || event.content.length > MAX_ROSTER_EVENT_BYTES) return false
  if (!Number.isSafeInteger(event.created_at) || event.created_at < 0) return false
  if (typeof event.id !== 'string' || !/^[0-9a-f]{64}$/i.test(event.id) ||
      typeof event.pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(event.pubkey) ||
      typeof event.sig !== 'string' || !/^[0-9a-f]{128}$/i.test(event.sig)) return false
  if (!Array.isArray(event.tags) || event.tags.length > 32) return false
  const seen = new Set<string>()
  let tagCharacters = 0
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.length < 2 || tag.length > 16) return false
    for (const value of tag) {
      if (typeof value !== 'string' || value.length > MAX_ROSTER_EVENT_BYTES) return false
      tagCharacters += value.length
      if (tagCharacters > MAX_ROSTER_EVENT_BYTES) return false
    }
    if (!tag[0] || seen.has(tag[0])) return false
    seen.add(tag[0])
    if (tag[0] === 'd' && (tag.length !== 2 || !/^[0-9a-f]{64}$/i.test(tag[1]!))) return false
    if (tag[0] === 'expiration' && (tag.length !== 2 || !/^(0|[1-9][0-9]*)$/.test(tag[1]!) || !Number.isSafeInteger(Number(tag[1])))) return false
  }
  if (!seen.has('d')) return false
  // Serialise only wire fields, never an untrusted object's extra properties.
  const wire = JSON.stringify({ id: event.id, pubkey: event.pubkey, sig: event.sig,
    kind: event.kind, created_at: event.created_at, tags: event.tags, content: event.content })
  return wire.length <= MAX_ROSTER_EVENT_BYTES && new TextEncoder().encode(wire).length <= MAX_ROSTER_EVENT_BYTES
}

function openRosterEnvelope(raw: unknown): { body: string; sig: string } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('malformed roster payload')
  const value = raw as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(value, 'v')) return null
  const keys = Object.keys(value).sort()
  if (value.v !== 2 || keys.length !== 3 || keys[0] !== 'body' || keys[1] !== 'sig' || keys[2] !== 'v' ||
      typeof value.body !== 'string' || value.body.length > MAX_ROSTER_EVENT_BYTES ||
      typeof value.sig !== 'string' || !/^[0-9a-f]{128}$/.test(value.sig)) throw new Error('malformed roster envelope')
  return { body: value.body, sig: value.sig }
}

/**
 * Encode a roster entry as an event encrypted to the room key.
 *
 * The room key is supplied directly as NIP-44's conversation key, which reuses
 * its audited AEAD rather than inventing a symmetric scheme. Everything
 * identifying in the body is encrypted. Legacy outer authors expose the
 * device key; envelope 2 replaces that author with a fresh throwaway key.
 * Both envelopes still expose the shared room/epoch selector and timing.
 */
export function encodeRosterEvent(entry: RosterEntry, opts: EncodeRosterOptions): Event {
  if (opts.envelope !== undefined && opts.envelope !== 2) throw new Error('unsupported roster envelope')
  // The name is sanitised on the way out as well as on the way in. Out, so
  // this implementation never publishes something another client has to
  // defuse; in (see `decodeRosterEvent`), because no other implementation
  // is obliged to have done so. `name: undefined` is dropped by
  // JSON.stringify, so an entry that never carried one produces exactly the
  // bytes it did before names existed.
  // The assist offer is sanitised on the way out for the same reason the name
  // is: this implementation never publishes something another client has to
  // defuse. Both fields are `undefined` when absent, which JSON.stringify
  // drops, so an entry that carries neither produces exactly the bytes it did
  // before either existed.
  // `left` is written only as an honest `true`: a farewell is the one entry
  // that removes somebody from a room, so it is never published by accident
  // of a truthy value, and every entry that is not one stays byte-identical.
  // An ownership proof rides only on an agent's entry, in its one honest
  // shape: it is the principal's signed bytes, and anything else is not it.
  const supplied = entry.agent === true && entry.owner ? normaliseAgentOwnership(entry.owner) ?? undefined : undefined
  const owner = supplied && verifyAgentOwnership(supplied, { agent: entry.participant, now: entry.updatedAt }).ok ? supplied : undefined
  const historical = !owner && supplied && inspectAgentOwnershipSignature(supplied, { agent: entry.participant, now: entry.updatedAt }).ok ? supplied : undefined
  const claimed = entry.agent === true && !owner && entry.ownerClaim ? normaliseAgentOwnership(entry.ownerClaim) ?? undefined : undefined
  const ownerClaim = historical ?? (claimed && inspectAgentOwnershipSignature(claimed, { agent: entry.participant, now: entry.updatedAt }).ok ? claimed : undefined)
  const plaintext = JSON.stringify({
    ...entry,
    name: sanitiseDisplayName(entry.name),
    // Same rule as the name and the assist offer, and for the same reason:
    // never publish something another client has to defuse. `undefined` is
    // dropped by JSON.stringify, so an entry without a page-session id is
    // byte-identical to one written before the field existed.
    sid: sanitiseSid(entry.sid),
    callProfile: sanitiseCallProfile(entry.callProfile),
    spryKey: sanitiseSpryKey(entry.spryKey),
    recordingProfile: recordingProfile(entry.recordingProfile),
    liveRecording: entry.recordingProfile === 3 || entry.recordingProfile === 4 ? readLiveRecordingState(entry.liveRecording) : undefined,
    assist: sanitiseAssistOffer(entry.assist),
    left: entry.left === true ? true : undefined,
    agent: entry.agent === true ? true : undefined,
    requestReceipts: entry.agent === true && entry.requestReceipts === true ? true : undefined,
    owner,
    ownerClaim,
  })
  const root = opts.epoch ?? { id: opts.roomId, key: opts.roomKey }
  if (opts.envelope === 2) {
    if (!hexEquals(getPublicKey(opts.deviceSk), entry.device)) throw new Error('a roster entry is signed by the device it names')
    const outerSk = generateSecretKey()
    try {
      const outer = getPublicKey(outerSk)
      const sig = bytesToHex(schnorr.sign(rosterEnvelope2Digest(opts.roomId, root.id, outer, entry.updatedAt, plaintext), opts.deviceSk))
      const event = finalizeEvent({
        kind: KINDS.ROSTER,
        created_at: entry.updatedAt,
        tags: withExpiration([['d', root.id]], opts.expiresAt),
        content: nip44.v2.encrypt(JSON.stringify({ v: 2, body: plaintext, sig }), root.key),
      }, outerSk)
      if (!boundedRosterEvent(event)) throw new Error('roster event exceeds wire bounds')
      return event
    } finally {
      outerSk.fill(0)
    }
  }
  const content = nip44.v2.encrypt(plaintext, root.key)
  return finalizeEvent(
    {
      kind: KINDS.ROSTER,
      created_at: entry.updatedAt,
      tags: withExpiration([['d', root.id]], opts.expiresAt),
      content,
    },
    opts.deviceSk,
  )
}

/**
 * How far ahead of our own clock a roster timestamp may be stamped.
 *
 * `updatedAt` decides which of two entries for one device wins, and a
 * singular-role claim time decides which of a participant's devices holds the
 * microphone. Both are chosen by the device that publishes them, so a device
 * stamping the year 3000 pins itself into the roster for good and locks the
 * mic against its owner's other devices - neither can ever be superseded by a
 * genuine later value. The bound has to be loose enough that real clocks,
 * which disagree by seconds, are not refused.
 */
export const MAX_FUTURE_SKEW_SECONDS = 60

export interface DecodeRosterOptions {
  /** The room the entry's credential is checked against. */
  roomId: string
  roomKey: Uint8Array
  /** Unix seconds. */
  now: number
  /** The epoch to read. Omit for epoch 0. An entry from another epoch does
   *  not decode: it is under another `d` tag and another key. */
  epoch?: { id: string; key: Uint8Array }
}

/**
 * Decode and fully verify a roster event.
 *
 * Returns null for anything that does not check out - wrong key, wrong room,
 * bad signature, unauthorised device, expired credential, malformed payload.
 * It never throws, because it runs inside a relay subscription handler where a
 * throw would take down the whole room.
 */
export function decodeRosterEvent(event: Event, opts: DecodeRosterOptions): RosterEntry | null {
  try {
    if (event.kind !== KINDS.ROSTER || !boundedRosterEvent(event)) return null
    const root = opts.epoch ?? { id: opts.roomId, key: opts.roomKey }
    const roomTag = event.tags.find((t) => t[0] === 'd')?.[1]
    if (roomTag === undefined || !hexEquals(roomTag, root.id)) return null
    if (!verifyEventUncached(event)) return null

    const raw: unknown = JSON.parse(nip44.v2.decrypt(event.content, root.key))
    const envelope = openRosterEnvelope(raw)
    const entry = (envelope ? JSON.parse(envelope.body) : raw) as RosterEntry

    // This is the boundary: a roster entry's device/participant/proof
    // fields are attacker- or other-implementation-controlled JSON, with
    // nothing on the wire forcing lower case. Canonicalise them here, once,
    // so every later comparison downstream - `Peer`'s politeness tiebreak,
    // `resolveSingularRoles`' device tiebreak, every Map/Set keyed on a
    // device or participant string - is correct by construction rather than
    // needing its own case-insensitive check. See `hex.ts`'s `normaliseHex`.
    entry.device = normaliseHex(entry.device)
    entry.participant = normaliseHex(entry.participant)

    // The other boundary, and the one that matters: this name was typed by
    // somebody else, on a client that owes us nothing. A name that survives
    // this cannot take a second row, hide part of itself, reverse the
    // direction the line renders in, or run long enough to push a pubkey
    // off the end of it. See `display-name.ts`.
    const name = sanitiseDisplayName(entry.name)
    if (name === undefined) delete entry.name
    else entry.name = name
    // The third boundary, and the one with arithmetic behind it: an assist
    // offer is a claim about somebody else's uplink, published by a client
    // that owes us nothing, and it feeds straight into the sums that decide
    // who carries this room. A NaN uplink or a fan-out claim of a thousand
    // is defused here rather than believed. The entry survives - the person
    // is genuinely in the room - and only the offer is dropped, exactly as a
    // hostile display name costs the name and not the person. See
    // `sanitiseAssistOffer`.
    const assist = sanitiseAssistOffer(entry.assist)
    if (assist === undefined) delete entry.assist
    else entry.assist = assist
    // The page session that published this, if it said which. Bounded hex
    // or nothing: it is a map key at every reader - see `presenceKey` - so
    // an unbounded string from another implementation would be a key of
    // whatever length that implementation chose. A malformed one costs the
    // claim and leaves the entry, which then reads exactly as an entry from
    // a client that has never heard of the field.
    const sid = sanitiseSid(entry.sid)
    if (sid === undefined) delete entry.sid
    else entry.sid = sid
    // The call-profile capability claim: only an honest `2` counts, for the
    // same reason only an honest `true` is a farewell or an agent flag - it
    // decides what wire fields and negotiation shape a peer expects, so a
    // looser reader's `"2"` or `2.0`-that-parsed-oddly must not pass as it.
    const callProfile = sanitiseCallProfile(entry.callProfile)
    if (callProfile === undefined) delete entry.callProfile
    else entry.callProfile = callProfile
    // The Spry key claim: a curve point in 64 hex, or nothing. A malformed
    // one costs the claim, never the entry, as for the call profile.
    const spryKey = sanitiseSpryKey(entry.spryKey)
    if (spryKey === undefined) delete entry.spryKey
    else entry.spryKey = spryKey
    entry.recordingProfile = recordingProfile(entry.recordingProfile)
    if (entry.recordingProfile === 3 || entry.recordingProfile === 4) entry.liveRecording = readLiveRecordingState(entry.liveRecording)
    else delete entry.liveRecording
    // At most one advert per role, and every advert kept must at least look
    // like one - see `dedupeTrackAdverts`. A malformed or repeated advert
    // costs itself, never the entry.
    entry.tracks = dedupeTrackAdverts(entry.tracks)
    // A call membership is a claim like the rest: a bounded id and a time,
    // or nothing. A malformed one costs the claim, never the entry.
    const call = sanitiseCallMembership(entry.call)
    if (call === undefined) delete entry.call
    else entry.call = call
    // A farewell removes somebody from the room, so only an honest `true`
    // is one. A looser implementation's `1` or `"yes"` is not a departure;
    // it is an entry like any other, and the timeout deals with it.
    if (entry.left !== true) delete entry.left
    // Same rule for the agent flag, for the same reason: it decides what a
    // member sends this device, so only an honest `true` is one.
    if (entry.agent !== true) delete entry.agent
    if (entry.agent !== true || entry.requestReceipts !== true) delete entry.requestReceipts
    // Whose agent this is, verified here or not carried at all. A reader
    // that sees `owner` on a decoded entry is looking at a proof this
    // function checked against the participant the entry names, at this
    // moment; one that fails costs the claim, never the entry. On a device
    // that does not say it is an agent there is nothing for a proof to be
    // about, and it goes too.
    const claimed = entry.agent === true ? normaliseAgentOwnership(entry.ownerClaim) : null
    delete entry.ownerClaim
    if (entry.owner !== undefined) {
      const proof = entry.agent === true ? normaliseAgentOwnership(entry.owner) : null
      const verdict = proof ? verifyAgentOwnership(proof, { agent: entry.participant, now: opts.now }) : { ok: false as const }
      if (proof && verdict.ok) entry.owner = proof
      else {
        delete entry.owner
        if (proof && inspectAgentOwnershipSignature(proof, { agent: entry.participant, now: opts.now }).ok) {
          entry.ownerClaim = proof
        }
      }
    }
    if (entry.owner === undefined && entry.ownerClaim === undefined && claimed
      && inspectAgentOwnershipSignature(claimed, { agent: entry.participant, now: opts.now }).ok) entry.ownerClaim = claimed

    if (entry.proof) {
      entry.proof = {
        ...entry.proof,
        issuer: normaliseHex(entry.proof.issuer),
        participant: normaliseHex(entry.proof.participant),
      }
    }

    // A room key and somebody else's credential do not confer that device's
    // signing authority. Envelope 2 moves this proof inside the encryption.
    if (envelope) {
      if (entry.updatedAt !== event.created_at) return null
      if (!schnorr.verify(hexToBytes(envelope.sig),
        rosterEnvelope2Digest(opts.roomId, roomTag, event.pubkey, event.created_at, envelope.body), hexToBytes(entry.device))) return null
    } else if (!hexEquals(entry.device, event.pubkey)) return null

    // A timestamp beyond clock skew is a pin, not a clock - see
    // `MAX_FUTURE_SKEW_SECONDS`. The entry goes; a claim only costs the
    // claim, because a device with one bad claim is still in the room.
    const horizon = opts.now + MAX_FUTURE_SKEW_SECONDS
    if (!Number.isFinite(entry.updatedAt) || entry.updatedAt > horizon) return null
    entry.claims = Object.fromEntries(
      Object.entries(entry.claims ?? {}).filter(
        ([, claimedAt]) => typeof claimedAt === 'number' && Number.isFinite(claimedAt) && claimedAt <= horizon,
      ),
    )

    const verdict = verifyDeviceCredential(entry.credential, {
      roomId: opts.roomId,
      now: opts.now,
    })
    if (!verdict.ok) return null
    if (!hexEquals(verdict.device, entry.device)) return null
    if (!hexEquals(verdict.participant, entry.participant)) return null

    // Deliberately NOT restamping verifiedSymbol onto the credential here.
    // It would be truthful at the moment of writing, but it hands a future
    // caller an object pre-marked verified - the exact footgun
    // `verifyEventUncached` exists to close. Re-hashing a credential is
    // cheap; a signature check that silently does nothing is not.
    return entry
  } catch {
    return null
  }
}

/** A call id is opaque, but it is also a string another implementation
 *  chose, so it is held to 32 lower-case hex characters and nothing else. */
export function sanitiseCallMembership(value: unknown): CallMembership | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { id, since } = value as { id?: unknown; since?: unknown }
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/i.test(id)) return undefined
  if (typeof since !== 'number' || !Number.isFinite(since) || since < 0) return undefined
  return { id: id.toLowerCase(), since: Math.floor(since) }
}

/** A page-session id is opaque, and it is also a string another
 *  implementation chose, so it is held to 8 hex characters and nothing
 *  else. See `RosterEntry.sid`. */
export function sanitiseSid(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}$/i.test(value)) return undefined
  return value.toLowerCase()
}

/** A fresh page-session id: 8 lower-case hex characters. */
export function newSid(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Only the exact number `2` is the profile-2 claim. See `RosterEntry.callProfile`. */
export function sanitiseCallProfile(value: unknown): number | undefined {
  return value === 2 ? 2 : undefined
}

const TRACK_ROLES: readonly TrackRole[] = ['camera', 'mic', 'screen', 'screen-audio']

/**
 * At most one advert per role per device.
 *
 * Already true in practice - a device only ever runs one camera, one mic,
 * one share and one screen-audio track at a time - so this is a decode
 * rule rather than a new constraint: an extra advert for a role already
 * seen is dropped, the first one for that role (in wire order) survives,
 * and the entry itself is always kept. Anything that does not even look
 * like an advert - the wrong shape, an unrecognised role - is dropped the
 * same way a hostile display name costs only the name.
 */
export function dedupeTrackAdverts(value: unknown): TrackAdvert[] {
  if (!Array.isArray(value)) return []
  const seenRoles = new Set<TrackRole>()
  const result: TrackAdvert[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const { trackId, role } = item as Partial<TrackAdvert>
    if (typeof trackId !== 'string' || typeof role !== 'string') continue
    if (!TRACK_ROLES.includes(role as TrackRole)) continue
    if (seenRoles.has(role as TrackRole)) continue
    seenRoles.add(role as TrackRole)
    const muted = sanitiseTrackMuted((item as Partial<TrackAdvert>).muted)
    result.push(muted === undefined ? { trackId, role: role as TrackRole } : { trackId, role: role as TrackRole, muted })
  }
  return result
}

/** Only the exact literal `true` is a mute claim - see `TrackAdvert.muted`.
 *  Anything else (`false`, `1`, `"true"`, `null`) is dropped so the key is
 *  absent, the same rule `sanitiseCallProfile` applies to the profile-2
 *  claim. */
export function sanitiseTrackMuted(value: unknown): true | undefined {
  return value === true ? true : undefined
}

/**
 * The identity a reader holds a roster entry under.
 *
 * `device` alone while the entry names no page session, so an entry from a
 * client that has never heard of `sid` behaves exactly as it always did:
 * one entry per device, last writer wins. `device|sid` once it does, which
 * is what lets two tabs of one browser - one on the call, one just looking -
 * hold two entries instead of overwriting each other. See `RosterEntry.sid`.
 */
export function presenceKey(entry: Pick<RosterEntry, 'device' | 'sid'>): string {
  return entry.sid ? `${entry.device}|${entry.sid}` : entry.device
}

/** Convenience for callers that hold a device secret key rather than a pubkey. */
export function devicePubkeyOf(deviceSk: Uint8Array): string {
  return getPublicKey(deviceSk)
}
