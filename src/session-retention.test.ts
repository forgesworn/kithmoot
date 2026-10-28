import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { RoomSession, type PrimaryRoomSessionOptions } from './session.js'
import { localIdentity } from './identity.js'
import { createDeviceCredential } from './credential.js'
import * as seals from './seal.js'
import { deriveRoom } from './room.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import type { DeviceCredential } from './types.js'

const NOW = 1_800_000_000
const SECRET = new Uint8Array(32).fill(71)
const sessions: RoomSession[] = []
const gates: { resolve(): void }[] = []
function gate() {
  let resolve!: () => void
  let reject!: (reason: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  const result = { promise, resolve, reject }
  gates.push(result)
  return result
}
function setup(extra: Partial<PrimaryRoomSessionOptions> = {}, relay = new SimRelay()) {
  const inner = localIdentity(generateSecretKey())
  const sign = vi.fn(inner.signEvent.bind(inner))
  const transport = new SimTransport(relay)
  const subscribe = vi.spyOn(transport, 'subscribe')
  const observer = vi.fn()
  const session = new RoomSession({
    transport, secret: SECRET, identity: { pubkey: inner.pubkey, signEvent: sign },
    deviceSk: generateSecretKey(), now: () => NOW, announceJitterMs: 0,
    timing: { heartbeatIntervalMs: 1_000_000_000, sweepIntervalMs: 1_000_000_000 },
    onCredential: observer, ...extra,
  })
  sessions.push(session)
  return { session, relay, sign, subscribe, observer }
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve() }
afterEach(async () => {
  for (const pending of gates.splice(0)) pending.resolve()
  await Promise.all(sessions.splice(0).map(session => session.leave()))
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('required own-credential retention', () => {
  it('holds concurrent join callers before subscriptions, chat and roster; adopts once after acknowledgement', async () => {
    const pending = gate()
    const retain = vi.fn((_credential: DeviceCredential, _seal?: Uint8Array) => pending.promise)
    const sealEntropy = vi.spyOn(seals, 'generateSealKey')
    const { session, relay, sign, subscribe, observer } = setup({ retainCredential: retain })
    const one = session.join([], {})
    const two = session.join([], {})
    expect(two).toBe(one)
    await flush()
    expect(retain).toHaveBeenCalledTimes(1)
    expect(sign).toHaveBeenCalledTimes(1)
    expect(sealEntropy).toHaveBeenCalledTimes(1)
    expect(session.credential).toBeUndefined()
    expect(subscribe).not.toHaveBeenCalled()
    expect(relay.published).toEqual([])
    expect(observer).not.toHaveBeenCalled()
    expect(() => session.chat).toThrow()
    const retained = structuredClone(retain.mock.calls[0]![0])
    const seal = retain.mock.calls[0]![1]!.slice()
    expect(getPublicKey(seal)).toBe(seals.credentialSeal(retained))
    pending.resolve()
    await Promise.all([one, two])
    expect(structuredClone(session.credential)).toEqual(retained)
    expect(observer).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalled()
    expect(relay.published.length).toBeGreaterThan(0)
    await session.chat.send('only after retention')
    expect(retain.mock.calls[0]![1]).toEqual(new Uint8Array(32))
  })

  it('reconciles the same candidate after a lost acknowledgement, with no replacement signing or seal entropy', async () => {
    const stored: { credential: DeviceCredential; seal: Uint8Array }[] = []
    const retain = vi.fn(async (credential: DeviceCredential, seal?: Uint8Array) => {
      stored.push({ credential: structuredClone(credential), seal: seal!.slice() })
      if (stored.length === 1) throw new Error('write may have committed; acknowledgement lost')
    })
    const entropy = vi.spyOn(seals, 'generateSealKey')
    const { session, sign, subscribe, relay, observer } = setup({ retainCredential: retain })
    await expect(session.join([], {})).rejects.toThrow('acknowledgement lost')
    expect(session.credential).toBeUndefined()
    expect(subscribe).not.toHaveBeenCalled()
    expect(relay.published).toEqual([])
    expect(observer).not.toHaveBeenCalled()
    await session.join([], {})
    expect(stored).toHaveLength(2)
    expect(stored[1]).toEqual(stored[0])
    expect(sign).toHaveBeenCalledTimes(1)
    expect(entropy).toHaveBeenCalledTimes(1)
    expect(structuredClone(session.credential)).toEqual(stored[0]!.credential)
  })

  it('isolates mutated credential fields, nested tags and seal bytes from the adopted candidate', async () => {
    let original!: DeviceCredential
    let originalSeal!: Uint8Array
    const retain = vi.fn(async (credential: DeviceCredential, seal?: Uint8Array) => {
      original = structuredClone(credential)
      originalSeal = seal!.slice()
      credential.id = '0'.repeat(64)
      credential.tags[0]![1] = 'changed'
      credential.tags.push(['seal', 'wrong'])
      seal!.fill(0)
    })
    const { session, observer } = setup({ retainCredential: retain })
    await session.join([], {})
    expect(structuredClone(session.credential)).toEqual(original)
    expect(structuredClone(observer.mock.calls[0]![0])).toEqual(original)
    expect(observer.mock.calls[0]![1]).toEqual(originalSeal)
  })

  it.each(['leave', 'abort', 'expiry'] as const)('%s while retention waits prevents adoption and publication', async reason => {
    let clock = NOW
    const signal = new AbortController()
    const pending = gate()
    const retain = vi.fn((_credential: DeviceCredential, _seal?: Uint8Array) => pending.promise)
    const { session, subscribe, relay, observer } = setup({ retainCredential: retain, now: () => clock, admissionSignal: signal.signal })
    const joining = session.join([], {})
    const rejected = expect(joining).rejects.toThrow()
    await flush()
    let leaving: Promise<void> | undefined
    let left = false
    if (reason === 'leave') {
      leaving = session.leave().then(() => { left = true })
      await flush()
      expect(left).toBe(false)
    } else if (reason === 'abort') signal.abort()
    else clock += 13 * 3600
    pending.resolve()
    await rejected
    await leaving
    expect(session.credential).toBeUndefined()
    expect(subscribe).not.toHaveBeenCalled()
    expect(relay.published).toEqual([])
    expect(observer).not.toHaveBeenCalled()
    expect(retain.mock.calls[0]![1]).toEqual(new Uint8Array(32))
  })

  it('reconciles an expired uncertain candidate before permitting any replacement', async () => {
    let clock = NOW
    const retained: DeviceCredential[] = []
    let acknowledge = false
    const retain = vi.fn(async (credential: DeviceCredential) => {
      retained.push(structuredClone(credential))
      if (!acknowledge) throw new Error('outcome unknown')
    })
    const entropy = vi.spyOn(seals, 'generateSealKey')
    const { session, sign, relay } = setup({ retainCredential: retain, now: () => clock })
    await expect(session.join([], {})).rejects.toThrow('unknown')
    clock += 13 * 3600
    await expect(session.join([], {})).rejects.toThrow('unknown')
    expect(retained[1]).toEqual(retained[0])
    expect(sign).toHaveBeenCalledTimes(1)
    expect(entropy).toHaveBeenCalledTimes(1)
    acknowledge = true
    await expect(session.join([], {})).rejects.toThrow('expired before use')
    expect(retained[2]).toEqual(retained[0])
    expect(sign).toHaveBeenCalledTimes(1)
    expect(relay.published).toEqual([])
    await session.join([], {})
    expect(sign).toHaveBeenCalledTimes(2)
    expect(entropy).toHaveBeenCalledTimes(2)
    expect(structuredClone(session.credential)).toEqual(retained[3])
    expect(session.credential?.id).not.toBe(retained[0]!.id)
  })

  it('keeps the old credential in chat during renewal and retries the exact candidate once per timer', async () => {
    vi.useFakeTimers()
    let clock = NOW
    const pending = gate()
    const retained: DeviceCredential[] = []
    const retain = vi.fn(async (credential: DeviceCredential) => {
      retained.push(structuredClone(credential))
      if (retained.length === 2) await pending.promise
      if (retained.length === 2) throw new Error('uncertain renewal')
    })
    const entropy = vi.spyOn(seals, 'generateSealKey')
    const { session, sign, observer } = setup({ retainCredential: retain, now: () => clock, timing: { credentialTtlSeconds: 120, heartbeatIntervalMs: 1_000_000, sweepIntervalMs: 1_000_000 } })
    await session.join([], {})
    const initial = session.credential!
    clock += 60
    await vi.advanceTimersByTimeAsync(60_000)
    expect(retain).toHaveBeenCalledTimes(2)
    expect(session.credential).toEqual(initial)
    expect(observer).toHaveBeenCalledTimes(1)
    await session.chat.send('old authority while waiting')
    pending.resolve()
    await flush()
    expect(session.credential).toEqual(initial)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(retain).toHaveBeenCalledTimes(3)
    expect(retained[2]).toEqual(retained[1])
    expect(sign).toHaveBeenCalledTimes(2)
    expect(entropy).toHaveBeenCalledTimes(2)
    expect(structuredClone(session.credential)).toEqual(retained[1])
    expect(observer).toHaveBeenCalledTimes(2)
    await session.chat.send('new authority after acknowledgement')
  })

  it('failed renewal cannot evict a full active seal history needed to open a rekey', async () => {
    vi.useFakeTimers()
    let clock = NOW
    const relay = new SimRelay()
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const participantSk = generateSecretKey()
    const deviceSk = generateSecretKey()
    const active = Array.from({ length: 128 }, () => seals.generateSealKey())
    const resume = await createDeviceCredential({ identity: localIdentity(participantSk), devicePubkey: getPublicKey(deviceSk), roomId: deriveRoom(SECRET).roomId, seal: active[0]!.pubkey, now: () => NOW, expiresAt: NOW + 3600 })
    const retain = vi.fn(async () => { throw new Error('uncertain') })
    const common = { authority, epochSettleMs: 0, now: () => clock, timing: { credentialTtlSeconds: 3600, heartbeatIntervalMs: 30_000, sweepIntervalMs: 1_000_000_000 } }
    const keeper = setup(common, relay).session
    const mine = setup({ ...common, identity: localIdentity(participantSk), deviceSk, resume, sealKeys: active.map(key => key.secretKey), retainCredential: retain }, relay).session
    await keeper.join([], {})
    await mine.join([], {})
    await flush()
    // Awake throughout: the wall clock reaches the renewal point as the
    // renewal timer does. (A jump past it first is a sleep, which the
    // heartbeat renews from at once; see session.test.ts.)
    await vi.advanceTimersByTimeAsync(1799_000)
    clock += 1800
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(retain).toHaveBeenCalledTimes(3)
    expect(mine.credential).toEqual(resume)
    expect(keeper.credentialFor(mine.device)?.id).toBe(resume.id)
    await keeper.rekey({ authoritySk })
    for (let i = 0; i < 10; i++) await nextTurn()
    await vi.advanceTimersByTimeAsync(0)
    expect(mine.epoch).toBe(1)
  })

  it.each([false, true])('leave handles a pending signer with required retention %s', async required => {
    const pending = gate()
    const inner = localIdentity(generateSecretKey())
    const identity = { pubkey: inner.pubkey, signEvent: async (event: Parameters<typeof inner.signEvent>[0]) => {
      await pending.promise
      return inner.signEvent(event)
    } }
    const retain = vi.fn(async () => {})
    const { session, relay, subscribe } = setup({ identity, ...(required ? { retainCredential: retain } : {}) })
    const joining = session.join([], {})
    const rejected = expect(joining).rejects.toThrow('cancelled')
    await flush()
    let settled = false
    const leaving = session.leave().then(() => { settled = true })
    await flush()
    expect(settled).toBe(true)
    pending.resolve()
    await Promise.all([rejected, leaving])
    expect(retain).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
    expect(relay.published).toEqual([])
    expect(session.credential).toBeUndefined()
  })

  it('keeps the convenience observer optional and ignores its failure after required acknowledgement', async () => {
    const retained = vi.fn(async () => {})
    const { session } = setup({ retainCredential: retained, onCredential: () => { throw new Error('observer failed') } })
    await session.join([], {})
    expect(retained).toHaveBeenCalledTimes(1)
    await session.chat.send('joined with retained authority')
  })
})
