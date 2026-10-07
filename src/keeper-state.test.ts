import { describe, expect, it } from 'vitest'
import { bytesToHex } from '@noble/hashes/utils'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { parseKeeperState, serialiseKeeperState } from './keeper-state.js'
import { createDeviceCredential } from './credential.js'
import { localIdentity } from './identity.js'
import type { KeeperState } from './agent.js'

const secret = new Uint8Array(32).fill(1)
const inviterSk = new Uint8Array(32).fill(2)
const bearer = new Uint8Array(32).fill(3)
const epochSecret = new Uint8Array(32).fill(4)

describe('keeper state', () => {
  it('retains v3 creation across disk persistence without upgrading old rooms', () => {
    const state = { secret, inviterSk, bearer, persistent: true as const }
    expect(parseKeeperState(serialiseKeeperState(state)).persistent).toBe(true)
    expect(parseKeeperState(serialiseKeeperState({ secret, inviterSk, bearer })).persistent).toBeUndefined()
  })

  it('keeps a conference room\'s end, written only for one, and refuses a bad one', () => {
    const ends = 1_800_086_400
    const state = { secret, inviterSk, bearer, persistent: true as const, endsAt: ends }
    expect(parseKeeperState(serialiseKeeperState(state)).endsAt).toBe(ends)
    expect(JSON.parse(serialiseKeeperState({ secret, inviterSk, bearer }))).not.toHaveProperty('ends')
    const stored = JSON.parse(serialiseKeeperState(state))
    for (const bad of [0, -1, 1.5, '1800086400']) {
      expect(() => parseKeeperState(JSON.stringify({ ...stored, ends: bad }))).toThrow(/ends/)
    }
  })

  it('keeps a self-destructing room\'s flag, written only for one', () => {
    const state = { secret, inviterSk, bearer, persistent: true as const, endsAt: 1_800_086_400, destruct: true as const }
    const back = parseKeeperState(serialiseKeeperState(state))
    expect(back.destruct).toBe(true)
    expect(back.endsAt).toBe(1_800_086_400)
    expect(JSON.parse(serialiseKeeperState({ secret, inviterSk, bearer }))).not.toHaveProperty('destruct')
    expect(parseKeeperState(serialiseKeeperState({ secret, inviterSk, bearer })).destruct).toBeUndefined()
    // Only the literal true counts, so a hand-edited file cannot half-set it.
    const edited = JSON.parse(serialiseKeeperState(state)) as Record<string, unknown>
    edited.destruct = 'yes'
    expect(parseKeeperState(JSON.stringify(edited)).destruct).toBeUndefined()
  })

  it('reads a version 1 file as epoch 0 with nobody removed', () => {
    const v1 = JSON.stringify({ v: 1, secret: bytesToHex(secret), inviterSk: bytesToHex(inviterSk), bearer: bytesToHex(bearer) })
    expect(parseKeeperState(v1)).toEqual({ secret, inviterSk, bearer, epoch: 0, removed: [] })
  })

  it('round-trips an epoch, its secret, the removed set and a closed room', () => {
    const removed = ['CD'.repeat(32), 'ab'.repeat(32), 'ab'.repeat(32)]
    const json = serialiseKeeperState({ secret, inviterSk, bearer, epoch: 3, epochSecret, removed, closed: true })
    const parsed = JSON.parse(json)
    expect(parsed.v).toBe(2)
    expect(parseKeeperState(json)).toEqual({
      secret,
      inviterSk,
      bearer,
      epoch: 3,
      epochSecret,
      removed: ['ab'.repeat(32), 'cd'.repeat(32)],
      closed: true,
    })
  })

  it('writes epoch 0 without a secret and refuses a later epoch without one', () => {
    const json = serialiseKeeperState({ secret, inviterSk, bearer })
    expect(JSON.parse(json)).toEqual({ v: 2, secret: bytesToHex(secret), inviterSk: bytesToHex(inviterSk), bearer: bytesToHex(bearer), epoch: 0, removed: [] })
    expect(() => serialiseKeeperState({ secret, inviterSk, bearer, epoch: 1 })).toThrow(/secret/)
    expect(() => parseKeeperState(JSON.stringify({ v: 2, secret: bytesToHex(secret), inviterSk: bytesToHex(inviterSk), bearer: bytesToHex(bearer), epoch: 1 }))).toThrow(/epochSecret/)
  })

  it('carries who asked to be nudged, written only when somebody has', () => {
    const plain = serialiseKeeperState({ secret, inviterSk, bearer })
    expect(JSON.parse(plain).nudge).toBeUndefined()
    const json = serialiseKeeperState({ secret, inviterSk, bearer, nudge: ['CD'.repeat(32), 'ab'.repeat(32), 'ab'.repeat(32)] })
    expect(JSON.parse(json).nudge).toEqual(['ab'.repeat(32), 'cd'.repeat(32)])
    expect(parseKeeperState(json).nudge).toEqual(['ab'.repeat(32), 'cd'.repeat(32)])
    expect(parseKeeperState(serialiseKeeperState({ secret, inviterSk, bearer, nudge: [] })).nudge).toBeUndefined()
    expect(() => parseKeeperState(JSON.stringify({ v: 2, secret: bytesToHex(secret), inviterSk: bytesToHex(inviterSk), bearer: bytesToHex(bearer), nudge: ['x'] }))).toThrow(/nudge/)
  })

  it('carries who the room knows, written only when anybody is (#207)', () => {
    expect(JSON.parse(serialiseKeeperState({ secret, inviterSk, bearer })).members).toBeUndefined()
    const json = serialiseKeeperState({ secret, inviterSk, bearer, members: ['CD'.repeat(32), 'ab'.repeat(32), 'ab'.repeat(32)] })
    expect(JSON.parse(json).members).toEqual(['ab'.repeat(32), 'cd'.repeat(32)])
    expect(parseKeeperState(json).members).toEqual(['ab'.repeat(32), 'cd'.repeat(32)])
    expect(() => parseKeeperState(JSON.stringify({ v: 2, secret: bytesToHex(secret), inviterSk: bytesToHex(inviterSk), bearer: bytesToHex(bearer), members: ['x'] }))).toThrow(/members/)
  })

  it('carries the room\'s named channels, so a restart does not empty them', () => {
    expect(JSON.parse(serialiseKeeperState({ secret, inviterSk, bearer })).channels).toBeUndefined()
    const json = serialiseKeeperState({ secret, inviterSk, bearer, channels: ['release', 'design', 'design'] })
    expect(JSON.parse(json).channels).toEqual(['design', 'release'])
    expect(parseKeeperState(json).channels).toEqual(['design', 'release'])
    expect(parseKeeperState(serialiseKeeperState({ secret, inviterSk, bearer, channels: [] })).channels).toBeUndefined()
    const stored = { v: 2, secret: bytesToHex(secret), inviterSk: bytesToHex(inviterSk), bearer: bytesToHex(bearer) }
    expect(() => parseKeeperState(JSON.stringify({ ...stored, channels: 'design' }))).toThrow(/channels/)
    expect(() => parseKeeperState(JSON.stringify({ ...stored, channels: ['agents'] }))).toThrow(/channels/)
  })

  it('refuses what it cannot read rather than guessing', () => {
    expect(() => parseKeeperState('{"v":3}')).toThrow(/version/)
    expect(() => parseKeeperState(JSON.stringify({ v: 1, secret: 'short', inviterSk: bytesToHex(inviterSk), bearer: bytesToHex(bearer) }))).toThrow(/secret/)
    expect(() => parseKeeperState(JSON.stringify({ v: 2, secret: bytesToHex(secret), inviterSk: bytesToHex(inviterSk), bearer: bytesToHex(bearer), removed: ['x'] }))).toThrow(/removed/)
  })

  describe('phase 2a fields', () => {
    const at = 1_800_000_000
    const past1 = new Uint8Array(32).fill(5)
    const past2 = new Uint8Array(32).fill(6)
    async function device(): Promise<{ device: string; credential: import('nostr-tools/pure').Event; seen: number }> {
      const sk = generateSecretKey()
      const devicePubkey = getPublicKey(sk)
      const credential = await createDeviceCredential({ identity: localIdentity(generateSecretKey()), devicePubkey, roomId: 'ef'.repeat(32), expiresAt: at + 43_200, now: () => at })
      return { device: devicePubkey, credential, seen: at + 60 }
    }
    async function full(): Promise<KeeperState> {
      return {
        secret, inviterSk, bearer, epoch: 3, epochSecret, removed: [],
        epochAt: at + 1000,
        past: [
          { epoch: 1, secret: past1, leftAt: at + 500 },
          { epoch: 2, secret: past2, leftAt: at + 1000 },
          { epoch: 0, secret, leftAt: at + 100 },
        ],
        devices: [await device(), await device()],
      }
    }

    it('round-trips when the epoch began, the window and the devices seen in it', async () => {
      const state = await full()
      const json = serialiseKeeperState(state)
      const stored = JSON.parse(json)
      expect(stored.v).toBe(2)
      expect(stored.epochAt).toBe(at + 1000)
      // Newest first, and epoch 0 without the room secret written twice.
      expect(stored.past).toEqual([
        { epoch: 2, secret: bytesToHex(past2), left: at + 1000 },
        { epoch: 1, secret: bytesToHex(past1), left: at + 500 },
        { epoch: 0, left: at + 100 },
      ])
      const parsed = parseKeeperState(json)
      expect(parsed.epochAt).toBe(at + 1000)
      expect(parsed.past).toEqual([
        { epoch: 2, secret: past2, leftAt: at + 1000 },
        { epoch: 1, secret: past1, leftAt: at + 500 },
        { epoch: 0, secret, leftAt: at + 100 },
      ])
      expect(parsed.devices?.map((d) => d.device).sort()).toEqual(state.devices!.map((d) => d.device).sort())
      // As plain JSON: nostr-tools marks an event it signed as verified, and
      // nothing read from a file is.
      expect(parsed.devices?.[0]?.credential).toEqual(JSON.parse(JSON.stringify(state.devices!.find((d) => d.device === parsed.devices?.[0]?.device)?.credential)))
      expect(parseKeeperState(serialiseKeeperState(parsed))).toEqual(parsed)
    })

    it('stays version 2, so an older keeper reads the same room from it and ignores the new fields', async () => {
      // An older reader refuses any version but 1 and 2, and builds its
      // state from the fields it names. What it would read is the file
      // without the new fields, and that must be the same room.
      const json = serialiseKeeperState(await full())
      const stored = JSON.parse(json)
      expect(stored.v).toBe(2)
      const { epochAt: _a, past: _p, devices: _d, ...older } = stored
      const asOlder = parseKeeperState(JSON.stringify(older))
      const { epochAt: _b, past: _q, devices: _e, ...rest } = parseKeeperState(json)
      expect(asOlder).toEqual(rest)
      expect(asOlder).toEqual({ secret, inviterSk, bearer, epoch: 3, epochSecret, removed: [] })
      // And nothing new is written for a keeper that has none of it.
      expect(Object.keys(JSON.parse(serialiseKeeperState({ secret, inviterSk, bearer })))).toEqual(['v', 'secret', 'inviterSk', 'bearer', 'epoch', 'removed'])
    })

    it('drops a malformed field, or a malformed entry, and keeps the rest of the file', async () => {
      const stored = JSON.parse(serialiseKeeperState(await full()))
      const read = (patch: Record<string, unknown>) => parseKeeperState(JSON.stringify({ ...stored, ...patch }))
      for (const epochAt of ['soon', -1, 1.5, null, {}]) {
        const parsed = read({ epochAt })
        expect(parsed.epochAt).toBeUndefined()
        expect(parsed.epoch).toBe(3)
        expect(parsed.past).toHaveLength(3)
      }
      for (const bad of ['past', 7, null, {}]) {
        expect(read({ past: bad, devices: bad }).past).toBeUndefined()
        expect(read({ past: bad, devices: bad }).devices).toBeUndefined()
        expect(read({ past: bad, devices: bad }).epochSecret).toEqual(epochSecret)
      }
      const past = read({
        past: [
          stored.past[0],
          { epoch: 1, secret: 'short', left: at },
          { epoch: 3, secret: bytesToHex(past1), left: at },
          { epoch: 2, secret: bytesToHex(past1), left: at },
          { epoch: -1, secret: bytesToHex(past1), left: at },
          { epoch: 1, secret: bytesToHex(past1) },
          'nonsense',
          { epoch: 0, left: at + 100 },
        ],
      }).past
      expect(past?.map((e) => e.epoch)).toEqual([2, 0])
      expect(past?.[0]?.secret).toEqual(past2)
      const devices = read({
        devices: [
          stored.devices[0],
          { ...stored.devices[1], device: 'x' },
          { ...stored.devices[1], seen: 'yesterday' },
          { ...stored.devices[1], credential: { ...stored.devices[1].credential, sig: 'nope' } },
          { ...stored.devices[1], credential: 'nope' },
          stored.devices[0],
        ],
      }).devices
      expect(devices?.map((d) => d.device)).toEqual([stored.devices[0].device])
      // Past entries mean nothing to a room still at epoch 0.
      expect(parseKeeperState(JSON.stringify({ ...stored, epoch: 0, epochSecret: undefined })).past).toBeUndefined()
    })
  })
})

