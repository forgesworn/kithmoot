// Constructor mechanics only. The deliberately fake executor/capture below
// prove no browser custody, bootstrap claim, membership or carrier authority.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoomSession, type RoomSessionOptions } from './session.js'
import { registerNativeSessionBinding, registerRetainedNativeSessionBinding, consumeNativeSessionBinding,
  type NativeSessionBinding, type NativeSessionView, type RetainedNativeSessionCapture } from './session-native-binding.js'
import { createDeviceCredential } from './credential.js'
import { localIdentity } from './identity.js'
import { deriveRoom } from './room.js'
import { getPublicKey } from 'nostr-tools/pure'
import type { ProtocolExecution } from './protocol-execution.js'

const opened: RoomSession[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(opened.splice(0).map(session => session.leave()))
  vi.useRealTimers()
})

async function fixture(twoSeals = false) {
  const secret = new Uint8Array(32).fill(31), deviceSk = new Uint8Array(32).fill(32), seal = new Uint8Array(32).fill(34)
  const prior = new Uint8Array(32).fill(35), identity = localIdentity(new Uint8Array(32).fill(33))
  const now = Math.floor(Date.now() / 1000), roomId = deriveRoom(secret).roomId, device = getPublicKey(deviceSk)
  const resume = await createDeviceCredential({identity, roomId, devicePubkey: device, seal: getPublicKey(seal), expiresAt: now + 1800, now: () => now})
  const protocol: ProtocolExecution = {check: vi.fn(), run: vi.fn(async (_name, effect) => effect()), retain: pending => pending}
  const transport = {publish: vi.fn(async () => {}), subscribe: vi.fn(() => () => {}), close: vi.fn(), rekey: vi.fn()}
  const facade = Object.freeze(Object.assign(Object.create(null) as Pick<typeof transport, 'publish' | 'subscribe' | 'close'>,
    {publish: transport.publish, subscribe: transport.subscribe, close: transport.close}))
  const seals = twoSeals ? [prior, seal] : [seal]
  const options = {secret, deviceSk, resume, sealKeys: seals, protocol, transport: facade, expectedEpoch: 0,
    memberEpochDesk: false, epochCatchUp: false, timing: {credentialTtlSeconds: 1800}}
  const current = vi.fn()
  const capture: RetainedNativeSessionCapture = Object.freeze({protocol, transport: facade, roomId, device, participant: identity.pubkey,
    credential: JSON.stringify(resume), seals: Object.freeze(seals.map(key => getPublicKey(key))), expectedEpoch: 0, current})
  let view!: NativeSessionView
  const binding: NativeSessionBinding = {attach: vi.fn(value => {view = value}), schedule: vi.fn(), revoke: vi.fn(() => {view?.revoke()})}
  const construct = (input: object = options, expected = capture) => {
    registerRetainedNativeSessionBinding(Object.freeze(input), binding, expected)
    const session = new RoomSession(input as unknown as RoomSessionOptions)
    opened.push(session)
    return session
  }
  return {options, capture, binding, construct, view: () => view, current, identity, protocol, transport, seal, prior, now}
}

function forbidEntropy() {
  return vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => {throw Error('Unexpected constructor entropy')})
}

describe('retained native Session mechanics without a participant signer', () => {
  it('validates before callbacks, copies material, joins and delegates scheduling to the native binding', async () => {
    const f = await fixture(true), order: string[] = []
    f.current.mockImplementation(() => {order.push('current')})
    vi.mocked(f.protocol.check).mockImplementation(() => {order.push('protocol')})
    f.transport.rekey.mockImplementation(() => {order.push('rekey')})
    const session = f.construct()
    expect(order.slice(0, 4)).toEqual(['current', 'current', 'protocol', 'current'])
    expect(f.transport.rekey).not.toHaveBeenCalled()
    expect(session.participant).toBe(f.identity.pubkey)
    expect(f.binding.attach).toHaveBeenCalledOnce()
    const id = f.options.resume.id
    f.options.resume.content = 'changed after construction'; f.seal.fill(0); f.prior.fill(0)
    await session.join([], {})
    expect(session.credential?.id).toBe(id)
    expect(session.credential?.content).toBe('')
    expect(f.view().snapshot().seals).toEqual(f.capture.seals)
    expect(f.binding.schedule).toHaveBeenCalledOnce()
    expect(consumeNativeSessionBinding(f.options)).toBeUndefined()
  })

  for (const fault of ['credential', 'device', 'participant', 'room', 'protocol', 'transport', 'epoch', 'missing-seal', 'duplicate', 'reordered', 'too-many', 'expired'] as const) {
    it(`refuses ${fault} before protocol, SID, transport or attachment effects`, async () => {
      const f = await fixture(true), input = {...f.options}
      let capture = f.capture
      if (fault === 'credential') input.resume = {...input.resume, sig: '0'.repeat(128)}
      if (fault === 'device') input.deviceSk = new Uint8Array(32).fill(36)
      if (fault === 'participant') capture = Object.freeze({...capture, participant: 'f'.repeat(64)})
      if (fault === 'room') capture = Object.freeze({...capture, roomId: 'f'.repeat(64)})
      if (fault === 'protocol') input.protocol = {...input.protocol}
      if (fault === 'transport') input.transport = {...input.transport}
      if (fault === 'epoch') input.expectedEpoch = 1
      if (fault === 'missing-seal') input.sealKeys = [f.prior]
      if (fault === 'duplicate') input.sealKeys = [f.seal, f.seal]
      if (fault === 'reordered') input.sealKeys = [...input.sealKeys].reverse()
      if (fault === 'too-many') input.sealKeys = Array.from({length: 129}, () => f.seal)
      if (fault === 'expired') {vi.useFakeTimers(); vi.setSystemTime((f.now + 1201) * 1000)}
      const entropy = forbidEntropy()
      expect(() => f.construct(input, capture)).toThrow()
      expect(entropy).not.toHaveBeenCalled()
      expect(f.protocol.check).not.toHaveBeenCalled()
      expect(f.transport.rekey).not.toHaveBeenCalled()
      expect(f.transport.publish).not.toHaveBeenCalled()
      expect(f.transport.subscribe).not.toHaveBeenCalled()
      expect(f.binding.attach).not.toHaveBeenCalled()
      expect(f.binding.revoke).toHaveBeenCalledOnce()
      expect(consumeNativeSessionBinding(input)).toBeUndefined()
      expect(f.options.secret.every(value => value === 31)).toBe(true)
      expect(f.seal.every(value => value === 34)).toBe(true)
    })
  }

  for (const field of ['identity', 'credential', 'onCredential', 'retainCredential', 'resume', 'sealKeys', 'protocol', 'unknown'] as const) {
    it(`does not invoke an accessor for ${field}`, async () => {
      const f = await fixture(), input = {...f.options}; let calls = 0
      Object.defineProperty(input, field, {enumerable: true, get: () => {calls++; throw Error('Foreign getter')}})
      const entropy = forbidEntropy()
      expect(() => f.construct(input)).toThrow()
      expect(calls).toBe(0)
      expect(entropy).not.toHaveBeenCalled()
      expect(f.protocol.check).not.toHaveBeenCalled()
      expect(f.transport.rekey).not.toHaveBeenCalled()
      expect(f.binding.revoke).toHaveBeenCalledOnce()
    })
  }

  it('runs the current check again before effects and refuses revocation during pure preparation', async () => {
    const f = await fixture(); f.current.mockImplementationOnce(() => {}).mockImplementation(() => {throw Error('Native decision ended')})
    const entropy = forbidEntropy()
    expect(() => f.construct()).toThrow('Native decision ended')
    expect(f.current).toHaveBeenCalledTimes(2)
    expect(entropy).not.toHaveBeenCalled()
    expect(f.protocol.check).not.toHaveBeenCalled()
    expect(f.transport.rekey).not.toHaveBeenCalled()
    expect(f.binding.attach).not.toHaveBeenCalled()
    expect(f.binding.revoke).toHaveBeenCalledOnce()
  })

  it('refuses synchronous revocation by the protocol check before entropy or transport work', async () => {
    const f = await fixture(); let revoked = false
    f.current.mockImplementation(() => {if (revoked) throw Error('Native decision revoked')})
    vi.mocked(f.protocol.check).mockImplementation(() => {revoked = true})
    const entropy = forbidEntropy()
    expect(() => f.construct()).toThrow('Native decision revoked')
    expect(f.current).toHaveBeenCalledTimes(3)
    expect(f.protocol.check).toHaveBeenCalledOnce()
    expect(entropy).not.toHaveBeenCalled()
    expect(f.transport.rekey).not.toHaveBeenCalled()
    expect(f.binding.attach).not.toHaveBeenCalled()
    expect(f.binding.revoke).toHaveBeenCalledOnce()
  })

  for (const field of ['forwarderMediaPipeline', 'rekey', 'setRelays', 'describe', 'epoch', 'now', 'sid', 'name', 'assist', 'owner'] as const) {
    it(`does not inherit ${field} during retained fresh-epoch construction`, async () => {
      const f = await fixture(); let reads = 0, leaked = 0
      const previous = Object.getOwnPropertyDescriptor(Object.prototype, field)
      Object.defineProperty(Object.prototype, field, {configurable: true,
        get() {reads++; return {rekey: () => {leaked++; return true}}},
        set(value) {Object.defineProperty(this, field, {value, configurable: true, writable: true, enumerable: true})}})
      try {
        f.construct({...f.options, requireFreshEpoch: true, authority: f.identity.pubkey})
        expect(reads).toBe(0); expect(leaked).toBe(0)
      } finally {
        if (previous) Object.defineProperty(Object.prototype, field, previous)
        else Reflect.deleteProperty(Object.prototype, field)
      }
    })
  }

  it('can erase revoked owned secrets even when synchronous close rejects', async () => {
    const f = await fixture(); f.construct()
    vi.mocked(f.binding.revoke).mockImplementation(() => {throw Error('Explicit close refusal')})
    f.view().revoke()
    expect(() => f.view().close()).toThrow('Explicit close refusal')
    try { f.view().dispose() } finally {vi.mocked(f.binding.revoke).mockImplementation(() => {})}
    expect(f.options.secret.every(value => value === 0)).toBe(true)
  })

  it('spends a subclass construction cell before reading options or invoking a callback', async () => {
    const f = await fixture(), input = Object.freeze({...f.options})
    registerRetainedNativeSessionBinding(input, f.binding, f.capture)
    const entropy = forbidEntropy()
    class Derived extends RoomSession {}
    expect(() => new Derived(input as unknown as RoomSessionOptions)).toThrow('cannot be subclassed')
    expect(consumeNativeSessionBinding(input)).toBeUndefined()
    expect(f.current).not.toHaveBeenCalled()
    expect(f.protocol.check).not.toHaveBeenCalled()
    expect(entropy).not.toHaveBeenCalled()
    expect(f.binding.revoke).toHaveBeenCalledOnce()
  })

  it('requires the retained current check to finish synchronously', async () => {
    const f = await fixture(), capture = Object.freeze({...f.capture, current: () => Promise.resolve()})
    const entropy = forbidEntropy()
    expect(() => f.construct(f.options, capture)).toThrow('must complete synchronously')
    expect(entropy).not.toHaveBeenCalled()
    expect(f.protocol.check).not.toHaveBeenCalled()
    expect(f.transport.rekey).not.toHaveBeenCalled()
    expect(f.binding.revoke).toHaveBeenCalledOnce()
  })

  for (const fault of ['zero-seal', 'short-seal', 'sparse-seal', 'seal-getter', 'end-ceiling'] as const) {
    it(`refuses ${fault} during pure preparation`, async () => {
      const f = await fixture(), input = {...f.options, endsAt: undefined as number | undefined}
      let getterCalls = 0
      if (fault === 'zero-seal') input.sealKeys = [new Uint8Array(32)]
      if (fault === 'short-seal') input.sealKeys = [new Uint8Array(31).fill(34)]
      if (fault === 'sparse-seal') input.sealKeys = new Array<Uint8Array<ArrayBuffer>>(1)
      if (fault === 'seal-getter') {
        input.sealKeys = []
        Object.defineProperty(input.sealKeys, '0', {get: () => {getterCalls++; return f.seal}})
      }
      if (fault === 'end-ceiling') input.endsAt = f.now + 1799
      const entropy = forbidEntropy()
      expect(() => f.construct(input)).toThrow()
      expect(getterCalls).toBe(0)
      expect(entropy).not.toHaveBeenCalled()
      expect(f.protocol.check).not.toHaveBeenCalled()
      expect(f.transport.rekey).not.toHaveBeenCalled()
      expect(f.binding.revoke).toHaveBeenCalledOnce()
      expect(f.seal.every(value => value === 34)).toBe(true)
    })
  }

  it('refuses an unregistered, legacy-registered or already-consumed retained options object', async () => {
    const f = await fixture(), session = f.construct(); await session.join([], {})
    const entropy = forbidEntropy(), before = f.transport.publish.mock.calls.length
    expect(() => new RoomSession(f.options as unknown as RoomSessionOptions)).toThrow('exact construction cell')
    const copy = Object.freeze({...f.options})
    registerNativeSessionBinding(copy, f.binding)
    expect(() => new RoomSession(copy as unknown as RoomSessionOptions)).toThrow('exact construction cell')
    expect(entropy).not.toHaveBeenCalled()
    expect(f.transport.publish).toHaveBeenCalledTimes(before)
  })

  it('refuses public credential minting and a late join before any new entropy or protocol work', async () => {
    const f = await fixture(), session = f.construct(), entropy = forbidEntropy()
    const checks = vi.mocked(f.protocol.check).mock.calls.length, runs = vi.mocked(f.protocol.run).mock.calls.length
    await expect(session.issueDeviceCredential(getPublicKey(new Uint8Array(32).fill(36)))).rejects.toThrow('private renewal controller')
    expect(f.protocol.check).toHaveBeenCalledTimes(checks)
    expect(f.protocol.run).toHaveBeenCalledTimes(runs)
    vi.useFakeTimers(); vi.setSystemTime((f.now + 1201) * 1000)
    await expect(session.join([], {})).rejects.toThrow('no longer current')
    expect(entropy).not.toHaveBeenCalled()
    expect(f.transport.publish).not.toHaveBeenCalled()
    expect(f.transport.subscribe).not.toHaveBeenCalled()
    expect(f.binding.schedule).not.toHaveBeenCalled()
  })

  it('adopts a native successor in the real Session and every live chat without a signer', async () => {
    const f = await fixture(), session = f.construct(); await session.join([], {})
    const channel = session.channel('existing'), prepared = channel.prepare('before native adoption')
    const nextSeal = new Uint8Array(32).fill(36), old = session.credential!
    const next = await createDeviceCredential({identity: f.identity, roomId: f.capture.roomId, devicePubkey: f.capture.device,
      seal: getPublicKey(nextSeal), expiresAt: f.now + 2700, now: () => f.now + 1})
    let applying = false
    const plan = f.view().prepare({credential: next, sealKeys: [f.seal, nextSeal], predecessor: old.id, operation: 'a'.repeat(64), root: f.protocol,
      checkPreparation: () => {}, checkApplication: () => {if (!applying) throw Error('Outside application')}})
    nextSeal.fill(0)
    expect(() => f.view().apply(plan)).toThrow('Outside application')
    f.view().check(plan); applying = true; f.view().apply(plan)
    expect(session.credential?.id).toBe(next.id)
    expect(f.view().snapshot().seals).toHaveLength(2)
    expect(() => f.view().apply(plan)).toThrow('spent or foreign')
    await expect(prepared.publish()).rejects.toThrow('changed its credential')
    await session.chat.send('current main'); await channel.send('current existing')
    expect(session.chat.messages().some(message => message.credential.id === next.id)).toBe(true)
    expect(channel.messages().some(message => message.credential.id === next.id)).toBe(true)
    expect(f.seal.every(value => value === 34)).toBe(true)
  })
})
