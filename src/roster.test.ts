import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey, verifiedSymbol, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { deriveRoom } from './room.js'
import { createDeviceCredential } from './credential.js'
import { encodeRosterEvent, decodeRosterEvent, MAX_FUTURE_SKEW_SECONDS } from './roster.js'
import type { RosterEntry } from './types.js'
import { localIdentity } from './identity.js'

const NOW = 1_800_000_000

async function fixture() {
  const secret = new Uint8Array(32).fill(9)
  const { roomId, roomKey } = deriveRoom(secret)
  const participantSk = generateSecretKey()
  const deviceSk = generateSecretKey()
  const device = getPublicKey(deviceSk)
  const credential = await createDeviceCredential({
    identity: localIdentity(participantSk),
    devicePubkey: device,
    roomId,
    expiresAt: NOW + 3600,
  })
  const entry: RosterEntry = {
    participant: getPublicKey(participantSk),
    device,
    credential,
    tracks: [{ trackId: 't1', role: 'screen' }],
    claims: { mic: NOW },
    updatedAt: NOW,
  }
  return { roomId, roomKey, deviceSk, entry }
}

describe('roster events', () => {
  it('round-trips an entry through encryption', async () => {
    const { roomId, roomKey, deviceSk, entry } = await fixture()
    const event = encodeRosterEvent(entry, { roomId, roomKey, deviceSk })
    const decoded = decodeRosterEvent(event, { roomId, roomKey, now: NOW })
    // Compared against the wire shape rather than the fixture object: the
    // ciphertext is JSON, so symbol-keyed properties never survive the trip,
    // and `finalizeEvent` stamps verifiedSymbol on the credential it mints.
    // Everything that actually crosses the wire must come back identical.
    expect(decoded).toEqual(JSON.parse(JSON.stringify(entry)))
  })

  it('hands back a credential that is not pre-marked verified', async () => {
    const { roomId, roomKey, deviceSk, entry } = await fixture()
    const event = encodeRosterEvent(entry, { roomId, roomKey, deviceSk })
    const decoded = decodeRosterEvent(event, { roomId, roomKey, now: NOW })
    // A decoded credential carrying a cached verdict would make any later
    // verifyEvent on it a no-op for whoever we hand it to.
    expect(decoded!.credential[verifiedSymbol]).toBeUndefined()
  })

  it('leaves no participant pubkey readable on the wire', async () => {
    const { roomId, roomKey, deviceSk, entry } = await fixture()
    const event = encodeRosterEvent(entry, { roomId, roomKey, deviceSk })
    const wire = JSON.stringify(event)
    expect(wire).not.toContain(entry.participant)
  })

  it('tags the event with the room id so it is subscribable', async () => {
    const { roomId, roomKey, deviceSk, entry } = await fixture()
    const event = encodeRosterEvent(entry, { roomId, roomKey, deviceSk })
    expect(event.tags).toContainEqual(['d', roomId])
  })

  it('returns null when the room key is wrong', async () => {
    const { roomId, roomKey, deviceSk, entry } = await fixture()
    const event = encodeRosterEvent(entry, { roomId, roomKey, deviceSk })
    const wrongKey = new Uint8Array(32).fill(1)
    expect(decodeRosterEvent(event, { roomId, roomKey: wrongKey, now: NOW })).toBeNull()
  })

  it('returns null when the credential does not authorise the signing device', async () => {
    const { roomId, roomKey, entry } = await fixture()
    const impostorSk = generateSecretKey()
    // The impostor signs the event, but the credential names a different device.
    const event = encodeRosterEvent(entry, { roomId, roomKey, deviceSk: impostorSk })
    expect(decodeRosterEvent(event, { roomId, roomKey, now: NOW })).toBeNull()
  })

  it('returns null when the credential has expired', async () => {
    const { roomId, roomKey, deviceSk, entry } = await fixture()
    const event = encodeRosterEvent(entry, { roomId, roomKey, deviceSk })
    expect(decodeRosterEvent(event, { roomId, roomKey, now: NOW + 999_999 })).toBeNull()
  })

  it('re-verifies the signature even when the event arrives pre-marked verified', async () => {
    const { roomId, roomKey, deviceSk, entry } = await fixture()
    const genuine = encodeRosterEvent(entry, { roomId, roomKey, deviceSk })

    // Everything the decoder checks after decryption still lines up - the
    // device signed it, the credential authorises that device - so the only
    // thing standing between this event and the roster is the signature over
    // the swapped ciphertext. nostr-tools caches verification results on the
    // event object, so an attacker who sets that cache skips the check
    // entirely unless the decoder verifies a stripped copy.
    const forged: Event = {
      ...genuine,
      content: nip44.v2.encrypt(
        JSON.stringify({ ...entry, tracks: [{ trackId: 'forged', role: 'screen' }] }),
        roomKey,
      ),
    }
    forged[verifiedSymbol] = true

    expect(decodeRosterEvent(forged, { roomId, roomKey, now: NOW })).toBeNull()
  })

  it('returns null for malformed ciphertext rather than throwing', async () => {
    const { roomId, roomKey, deviceSk, entry } = await fixture()
    const event = { ...encodeRosterEvent(entry, { roomId, roomKey, deviceSk }), content: 'rubbish' }
    expect(() => decodeRosterEvent(event, { roomId, roomKey, now: NOW })).not.toThrow()
    expect(decodeRosterEvent(event, { roomId, roomKey, now: NOW })).toBeNull()
  })

  it('normalises device and participant to lower case, even when the entry itself names them in upper case', async () => {
    // Nothing on the wire stops a publisher writing its own device/participant
    // fields in upper-case hex - the signature only binds the event, not the
    // case of a string inside its encrypted JSON content. This is the
    // boundary: everything downstream (`Peer`'s tiebreak, `resolveSingularRoles`,
    // every Map/Set keyed on a device string) must see one canonical spelling.
    const { roomId, roomKey, deviceSk, entry } = await fixture()
    const shouted: RosterEntry = { ...entry, device: entry.device.toUpperCase(), participant: entry.participant.toUpperCase() }
    const event = encodeRosterEvent(shouted, { roomId, roomKey, deviceSk })

    const decoded = decodeRosterEvent(event, { roomId, roomKey, now: NOW })

    expect(decoded?.device).toBe(entry.device.toLowerCase())
    expect(decoded?.participant).toBe(entry.participant.toLowerCase())
  })

  it('BUG (M4): refuses an entry stamped further into the future than clock skew allows', async () => {
    // `updatedAt` decides which of two entries for one device wins, so an
    // entry stamped in the year 3000 can never be superseded by a genuine
    // later one - the device pins itself into the roster for good.
    const { roomId, roomKey, deviceSk, entry } = await fixture()
    const event = encodeRosterEvent({ ...entry, updatedAt: 9e15 }, { roomId, roomKey, deviceSk })

    expect(decodeRosterEvent(event, { roomId, roomKey, now: NOW })).toBeNull()
  })

  it('accepts an entry from a device whose clock is a little fast', async () => {
    // Real clocks disagree. The rule has to refuse a pin without refusing a
    // device that is thirty seconds ahead.
    const { roomId, roomKey, deviceSk, entry } = await fixture()
    const ahead = NOW + MAX_FUTURE_SKEW_SECONDS - 1
    const event = encodeRosterEvent({ ...entry, updatedAt: ahead }, { roomId, roomKey, deviceSk })

    expect(decodeRosterEvent(event, { roomId, roomKey, now: NOW })?.updatedAt).toBe(ahead)
  })

  it('BUG (M4): drops a singular-role claim stamped further into the future than clock skew allows', async () => {
    // Most recent claim wins, so a claim stamped in the year 3000 locks the
    // microphone against that participant's own other devices for ever.
    const { roomId, roomKey, deviceSk, entry } = await fixture()
    const event = encodeRosterEvent(
      { ...entry, claims: { mic: 9e15, monitor: NOW } },
      { roomId, roomKey, deviceSk },
    )

    const decoded = decodeRosterEvent(event, { roomId, roomKey, now: NOW })
    // The device stays in the room - a bad claim costs the claim, not the
    // device's presence - but the claim itself is gone.
    expect(decoded).not.toBeNull()
    expect(decoded?.claims.mic).toBeUndefined()
    expect(decoded?.claims.monitor).toBe(NOW)
  })
})
