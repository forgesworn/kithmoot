import { afterEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2'
import { schnorr } from '@noble/curves/secp256k1.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { createFakeFactory } from '../test/fake-rtc.js'
import { issueKindredProof } from './access.js'
import { createDeviceCredential } from './credential.js'
import { localIdentity } from './identity.js'
import { KINDS } from './kinds.js'
import { decodeRosterEvent, encodeRosterEvent } from './roster.js'
import { deriveRoom } from './room.js'
import { RoomSession } from './session.js'
import type { RosterEntry } from './types.js'

const NOW = 1_800_000_000
const SECRET = new Uint8Array(32).fill(94)
const ROOT = deriveRoom(SECRET)
const opened: RoomSession[] = []
const relays: SimRelay[] = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map(session => session.leave()))
  for (const relay of relays.splice(0)) relay.close()
  vi.clearAllTimers()
  vi.useRealTimers()
})

async function fixture() {
  vi.useFakeTimers()
  vi.setSystemTime(NOW * 1000)
  const relay = new SimRelay()
  relays.push(relay)
  const factory = createFakeFactory()
  const hostSk = generateSecretKey()
  const identity = localIdentity(generateSecretKey())
  const policy = { tier: 'kith' as const, admitted: [getPublicKey(hostSk)] }
  const observer = new RoomSession({ transport: new SimTransport(relay), secret: SECRET,
    identity, deviceSk: generateSecretKey(), factory,
    now: () => Math.floor(Date.now() / 1000), announceJitterMs: 0, policy,
    proof: issueKindredProof({ hostSk, participant: identity.pubkey, tier: 'kith',
      roomId: ROOT.roomId, expiresAt: NOW + 3600 }),
    timing: { heartbeatIntervalMs: 1000, sweepIntervalMs: 1000 },
  })
  opened.push(observer)
  await observer.join([], {})
  const remoteIdentity = localIdentity(generateSecretKey())
  const deviceSk = generateSecretKey()
  const credential = await createDeviceCredential({ identity: remoteIdentity,
    devicePubkey: getPublicKey(deviceSk), roomId: ROOT.roomId, expiresAt: NOW + 3600 })
  const entry: RosterEntry = { participant: remoteIdentity.pubkey, device: getPublicKey(deviceSk),
    credential, tracks: [{ trackId: 'remote-camera', role: 'camera' }], claims: {}, updatedAt: NOW,
    proof: issueKindredProof({ hostSk, participant: remoteIdentity.pubkey, tier: 'kith',
      roomId: ROOT.roomId, expiresAt: NOW + 3600 }) }
  return { relay, factory, hostSk, observer, deviceSk, entry }
}

/** Independent publisher with a literal domain, allowing a stolen credential
 * or a wrong signing key without going through the honest writer's checks. */
function hostileEnvelope(entry: RosterEntry, signer: Uint8Array) {
  const outerSk = generateSecretKey()
  const outer = getPublicKey(outerSk)
  const body = JSON.stringify(entry)
  const digest = sha256(new TextEncoder().encode(
    `kithmoot/v1/roster-envelope-2:${ROOT.roomId}:${ROOT.roomId}:${outer}:${NOW}:${body}`))
  const sig = bytesToHex(schnorr.sign(digest, signer))
  return finalizeEvent({ kind: KINDS.ROSTER, created_at: NOW, tags: [['d', ROOT.roomId]],
    content: nip44.v2.encrypt(JSON.stringify({ v: 2, body, sig }), ROOT.roomKey) }, outerSk)
}

describe('RoomSession roster envelope 2 admission', () => {
  it('admits a valid encrypted device identity to a call peer while continuing to publish legacy presence', async () => {
    const f = await fixture()
    const event = encodeRosterEvent(f.entry, { ...ROOT, deviceSk: f.deviceSk, envelope: 2 })
    expect(event.pubkey).not.toBe(f.entry.device)
    f.relay.publish(event)
    await vi.advanceTimersByTimeAsync(0)

    expect(f.observer.participants().find(view => view.participant === f.entry.participant)?.devices).toEqual([f.entry.device])
    expect(f.factory.instances).toHaveLength(1)
    expect(f.factory.to(f.entry.device)).toBeDefined()
    expect(f.factory.to(event.pubkey)).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1000)
    const ownRoster = f.relay.published.filter(published => published.kind === KINDS.ROSTER &&
      published.pubkey === f.observer.device)
    expect(ownRoster.length).toBeGreaterThanOrEqual(2)
    for (const published of ownRoster) {
      const body = JSON.parse(nip44.v2.decrypt(published.content, ROOT.roomKey))
      expect(body.device).toBe(f.observer.device)
      expect(body.v).toBeUndefined()
      expect(body.body).toBeUndefined()
    }
  })

  it('creates no peer for a forged inner device signature or a copied legitimate credential', async () => {
    const f = await fixture()
    const attacker = generateSecretKey()
    for (const [label, event] of [
      ['forged inner device signature', hostileEnvelope(f.entry, attacker)],
      ['copied legitimate credential', hostileEnvelope({ ...f.entry, device: getPublicKey(attacker) }, attacker)],
    ] as const) {
      f.relay.publish(event)
      await vi.advanceTimersByTimeAsync(0)
      expect(f.factory.instances, label).toHaveLength(0)
      expect(f.observer.participants().map(view => view.participant), label).toEqual([f.observer.participant])
    }

    // The same credential and admitted proof work with the genuine device's
    // signature, proving the negative cases reached an active session.
    f.relay.publish(hostileEnvelope(f.entry, f.deviceSk))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.factory.instances).toHaveLength(1)
    expect(f.factory.to(f.entry.device)).toBeDefined()
  })

  it('creates no peer for authenticated devices carrying an untrusted, wrong or expired admission proof', async () => {
    const f = await fixture()
    const terms = { hostSk: f.hostSk, participant: f.entry.participant, tier: 'kith' as const,
      roomId: ROOT.roomId, expiresAt: NOW + 3600 }
    const proofs = [
      ['untrusted issuer', issueKindredProof({ ...terms, hostSk: generateSecretKey() })],
      ['wrong participant', issueKindredProof({ ...terms, participant: getPublicKey(generateSecretKey()) })],
      ['wrong room', issueKindredProof({ ...terms, roomId: deriveRoom(new Uint8Array(32).fill(95)).roomId })],
      ['expired proof', issueKindredProof({ ...terms, expiresAt: NOW - 1 })],
    ] as const
    for (const [label, proof] of proofs) {
      const event = encodeRosterEvent({ ...f.entry, proof }, { ...ROOT, deviceSk: f.deviceSk, envelope: 2 })
      // The credential and encrypted device proof pass the codec. Admission
      // still belongs to the receiving RoomSession's independently held policy.
      expect(decodeRosterEvent(event, { ...ROOT, now: NOW })?.device, label).toBe(f.entry.device)
      f.relay.publish(event)
      await vi.advanceTimersByTimeAsync(0)
      expect(f.factory.instances, label).toHaveLength(0)
      expect(f.observer.participants().map(view => view.participant), label).toEqual([f.observer.participant])
    }
    f.relay.publish(encodeRosterEvent(f.entry, { ...ROOT, deviceSk: f.deviceSk, envelope: 2 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.factory.instances).toHaveLength(1)
    expect(f.factory.to(f.entry.device)).toBeDefined()
  })
})
