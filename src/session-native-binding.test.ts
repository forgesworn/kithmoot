import { afterEach, describe, expect, it } from 'vitest'
import { RoomSession, type RoomSessionOptions } from './session.js'
import { localIdentity } from './identity.js'
import { consumeNativeSessionBinding, registerNativeSessionBinding, type NativeSessionView } from './session-native-binding.js'
import { createDeviceCredential } from './credential.js'
import { deriveRoom } from './room.js'
import { getPublicKey } from 'nostr-tools/pure'
import type { ProtocolExecution } from './protocol-execution.js'

const opened: RoomSession[] = []
afterEach(async () => { await Promise.all(opened.splice(0).map(session => session.leave())) })

function options(): RoomSessionOptions {
  return { secret: new Uint8Array(32).fill(31), deviceSk: new Uint8Array(32).fill(32),
    identity: localIdentity(new Uint8Array(32).fill(33)),
    transport: { publish: async () => {}, subscribe: () => () => {}, close: () => {} } }
}
describe('internal exact-options native construction binding', () => {
  it('consumes one exact cell before option access and never transfers it to a copy', () => {
    const opts = options(), calls: string[] = []
    registerNativeSessionBinding(opts, { attach: () => { calls.push('attach') }, schedule: () => {}, revoke: () => { calls.push('revoke') } })
    expect(consumeNativeSessionBinding({ ...opts })).toBeUndefined()
    Object.defineProperty(opts, 'protocol', { get: () => {
      calls.push('option'); expect(consumeNativeSessionBinding(opts)).toBeUndefined(); return undefined
    } })
    opened.push(new RoomSession(opts))
    expect(calls.at(-1)).toBe('attach')
    expect(calls.filter(value => value === 'attach')).toHaveLength(1)
    expect(consumeNativeSessionBinding(opts)).toBeUndefined()
  })
  it('cancellation cannot remove another registration or replace an occupied cell', () => {
    const opts = options(), binding = { attach: () => {}, schedule: () => {}, revoke: () => {} }
    const cancel = registerNativeSessionBinding(opts, binding)
    expect(() => registerNativeSessionBinding(opts, binding)).toThrow()
    cancel()
    registerNativeSessionBinding(opts, binding)
    cancel()
    expect(consumeNativeSessionBinding(opts)).toBeDefined()
    expect(consumeNativeSessionBinding(opts)).toBeUndefined()
  })
  it('refuses subclasses before accessing options and spends/revokes the cell', () => {
    const opts = options(); let reads = 0, revoked = 0, attached = 0
    Object.defineProperty(opts, 'protocol', { get: () => { reads++; return undefined } })
    registerNativeSessionBinding(opts, { attach: () => { attached++ }, schedule: () => {}, revoke: () => { revoked++ } })
    class OtherSession extends RoomSession {}
    expect(() => new OtherSession(opts)).toThrow('cannot be subclassed')
    expect([reads, revoked, attached]).toEqual([0, 1, 0])
    expect(consumeNativeSessionBinding(opts)).toBeUndefined()
  })
  it('constructor refusal revokes synchronously while preserving borrowed buffers', () => {
    const opts = options(); let revoked = 0, attached = 0
    opts.transport.rekey = () => { throw Error('transport refused') }
    registerNativeSessionBinding(opts, { attach: () => { attached++ }, schedule: () => {}, revoke: () => { revoked++ } })
    expect(() => new RoomSession(opts)).toThrow('transport refused')
    expect([revoked, attached]).toEqual([1, 0])
    expect(opts.secret.every(value => value === 31)).toBe(true)
    expect(opts.deviceSk.every(value => value === 32)).toBe(true)
    expect(consumeNativeSessionBinding(opts)).toBeUndefined()
  })
  it('captures descriptors without invoking accessors and refuses asynchronous functions', () => {
    let reads = 0
    const input = { attach: () => {}, schedule: () => {}, revoke: () => {} }
    Object.defineProperty(input, 'attach', { get: () => { reads++; return () => {} } })
    expect(() => registerNativeSessionBinding(options(), input)).toThrow()
    expect(reads).toBe(0)
    expect(() => registerNativeSessionBinding(options(), { attach: async () => {}, schedule: () => {}, revoke: () => {} })).toThrow()
  })
  it('a regular function returning a promise cannot turn attach into an asynchronous handshake', () => {
    const opts = options(); let revoked = 0, view: NativeSessionView | undefined
    registerNativeSessionBinding(opts, { attach: value => { view = value; return Promise.resolve() },
      schedule: () => {}, revoke: () => { revoked++ } })
    expect(() => new RoomSession(opts)).toThrow('must complete synchronously')
    expect(revoked).toBe(1)
    expect(() => view!.snapshot()).toThrow('unavailable')
    expect(consumeNativeSessionBinding(opts)).toBeUndefined()
  })
  it('opaque plans belong to one Session, copy seals, spend once and update every chat', async () => {
    // This unit fixture checks private plan mechanics only. Its local executor
    // is deliberately not native browser custody or renewal authorisation.
    const opts = options(), now = Math.floor(Date.now() / 1000), oldSeal = new Uint8Array(32).fill(34), nextSeal = new Uint8Array(32).fill(35)
    const credential = await createDeviceCredential({ identity: opts.identity!, roomId: deriveRoom(opts.secret).roomId,
      devicePubkey: getPublicKey(opts.deviceSk), seal: getPublicKey(oldSeal), expiresAt: now + 1800, now: () => now })
    const next = await createDeviceCredential({ identity: opts.identity!, roomId: deriveRoom(opts.secret).roomId,
      devicePubkey: getPublicKey(opts.deviceSk), seal: getPublicKey(nextSeal), expiresAt: now + 2700, now: () => now + 1 })
    const protocol: ProtocolExecution = { check: () => {}, run: async (_name, effect) => effect(), retain: pending => pending }
    let view!: NativeSessionView, applying = false
    opts.protocol = protocol; opts.resume = credential; opts.sealKeys = [oldSeal]; opts.now = () => now + 1
    registerNativeSessionBinding(opts, { attach: value => { view = value }, schedule: () => {}, revoke: () => { view.revoke() } })
    const session = new RoomSession(opts); opened.push(session)
    await session.join([], {})
    const channel = session.channel('existing'), prepared = channel.prepare('prepared before native adoption')
    const candidate = { credential: next, sealKeys: [oldSeal, nextSeal], predecessor: credential.id, operation: 'a'.repeat(64), root: protocol,
      checkPreparation: () => {}, checkApplication: () => { if (!applying) throw Error('outside application') } }
    const plan = view.prepare(candidate)
    expect(() => view.prepare(candidate)).toThrow('invalid native Session candidate')
    expect(() => view.apply({} as any)).toThrow('spent or foreign')
    expect(() => view.apply(plan)).toThrow('outside application')
    nextSeal.fill(0)
    view.check(plan); applying = true; view.apply(plan)
    expect(view.snapshot().credential.id).toBe(next.id)
    expect(view.snapshot().seals).toHaveLength(2)
    expect(oldSeal.every(value => value === 34)).toBe(true)
    expect(() => view.check(plan)).toThrow('spent or foreign')
    expect(() => view.apply(plan)).toThrow('spent or foreign')
    await expect(prepared.publish()).rejects.toThrow('changed its credential')
    await session.chat.send('current main')
    await channel.send('current existing channel')
    expect(session.chat.messages().some(message => message.credential.id === next.id && message.text === 'current main')).toBe(true)
    expect(channel.messages().some(message => message.credential.id === next.id && message.text === 'current existing channel')).toBe(true)
    view.revoke()
    expect(() => view.snapshot()).toThrow('unavailable')
  })
})
