import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey, verifiedSymbol, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { deriveRoom } from './room.js'
import { createDeviceCredential } from './credential.js'
import { encodeRosterEvent, decodeRosterEvent, MAX_FUTURE_SKEW_SECONDS } from './roster.js'
import type { RosterEntry } from './types.js'
import { localIdentity } from './identity.js'
import { sanitiseDisplayName, MAX_DISPLAY_NAME_LENGTH } from './display-name.js'

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

describe('roster display names', () => {
  it('carries a name through the encrypted round trip', async () => {
    const { roomId, roomKey, deviceSk, entry } = await fixture()
    const named = { ...entry, name: 'Darren' }
    const event = encodeRosterEvent(named, { roomId, roomKey, deviceSk })
    expect(decodeRosterEvent(event, { roomId, roomKey, now: NOW })!.name).toBe('Darren')
  })

  it('keeps the name inside the ciphertext, where the participant pubkey already is', async () => {
    const { roomId, roomKey, deviceSk, entry } = await fixture()
    const event = encodeRosterEvent({ ...entry, name: 'Darren' }, { roomId, roomKey, deviceSk })
    // A relay learning who is in a room by name would be worse than a relay
    // learning their pubkey, not better.
    expect(JSON.stringify(event)).not.toContain('Darren')
  })

  it('has no name at all when none was set, so the wire is unchanged for anyone who never types one', async () => {
    const { roomId, roomKey, deviceSk, entry } = await fixture()
    const withUndefined = encodeRosterEvent({ ...entry, name: undefined }, { roomId, roomKey, deviceSk })
    const decoded = decodeRosterEvent(withUndefined, { roomId, roomKey, now: NOW })
    expect(decoded).not.toHaveProperty('name')
  })

  it('carries a farewell as `left: true`, and nothing else on the wire changes', async () => {
    // Departure is a first-class fact, not a guess made from an empty track
    // list: a device with everything switched off looks the same as one on
    // its way out, and only one of them should vanish from the room.
    const { roomId, roomKey, deviceSk, entry } = await fixture()
    const farewell: RosterEntry = { ...entry, tracks: [], claims: {}, reply: true, left: true }
    const event = encodeRosterEvent(farewell, { roomId, roomKey, deviceSk })
    const decoded = decodeRosterEvent(event, { roomId, roomKey, now: NOW })
    expect(decoded?.left).toBe(true)
    // An entry that is not a farewell has no `left` at all - byte-identical
    // to what every client published before departures existed.
    const staying = encodeRosterEvent(entry, { roomId, roomKey, deviceSk })
    expect(JSON.parse(nip44.v2.decrypt(staying.content, roomKey))).not.toHaveProperty('left')
  })

  it('accepts only an honest `true` for `left`; anything else is not a departure', async () => {
    // A truthy string or a 1 from a looser implementation must not read as
    // a farewell, because a farewell removes somebody from the room.
    const { roomId, roomKey, deviceSk, entry } = await fixture()
    for (const hostile of ['yes', 1, {}, [], 'true']) {
      const event = encodeRosterEvent({ ...entry, left: hostile } as unknown as RosterEntry, { roomId, roomKey, deviceSk })
      const decoded = decodeRosterEvent(event, { roomId, roomKey, now: NOW })
      expect(decoded, `left=${JSON.stringify(hostile)}`).not.toBeNull()
      expect(decoded, `left=${JSON.stringify(hostile)}`).not.toHaveProperty('left')
    }
  })

  it('neutralises a hostile name on the way in, whatever the sender did on the way out', async () => {
    const { roomId, roomKey, deviceSk, entry } = await fixture()
    // Published by a client that never sanitised anything: an RTL override,
    // a smuggled newline, a zero-width space, and far too many characters.
    const hostile = `‮nerrad\nadmin​${'x'.repeat(200)}`
    const event = encodeRosterEvent(
      { ...entry, name: hostile } as RosterEntry,
      { roomId, roomKey, deviceSk },
    )
    // Sanitised twice over: encode will not put it on the wire, and decode
    // will not accept it if some other implementation did.
    const raw = JSON.parse(nip44.v2.decrypt(event.content, roomKey)) as RosterEntry
    expect(raw.name).toBe(sanitiseDisplayName(hostile))

    const decoded = decodeRosterEvent(event, { roomId, roomKey, now: NOW })!
    // The override is gone, the newline became a space, the zero-width
    // space closed up, and what is left is capped.
    expect(decoded.name).toBe(`nerrad admin${'x'.repeat(MAX_DISPLAY_NAME_LENGTH - 'nerrad admin'.length)}`)
    expect(decoded.name).not.toMatch(/\p{C}/u)
    expect([...decoded.name!].length).toBeLessThanOrEqual(MAX_DISPLAY_NAME_LENGTH)
  })

  it('drops a name that is not a string, rather than rendering whatever it is', async () => {
    const { roomId, roomKey, deviceSk, entry } = await fixture()
    const event = encodeRosterEvent(
      { ...entry, name: { toString: () => 'Darren' } } as unknown as RosterEntry,
      { roomId, roomKey, deviceSk },
    )
    expect(decodeRosterEvent(event, { roomId, roomKey, now: NOW })).not.toHaveProperty('name')
  })

  it('never lets a name stand in for the pubkey it is decoded alongside', async () => {
    const { roomId, roomKey, deviceSk, entry } = await fixture()
    const event = encodeRosterEvent({ ...entry, name: 'Darren' }, { roomId, roomKey, deviceSk })
    const decoded = decodeRosterEvent(event, { roomId, roomKey, now: NOW })!
    // The credential still decides who this is. A name is a label on it.
    expect(decoded.participant).toBe(entry.participant)
    expect(decoded.device).toBe(entry.device)
  })
})
