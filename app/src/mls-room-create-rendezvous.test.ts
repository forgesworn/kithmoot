import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { getPublicKey } from 'nostr-tools/pure'
import { base64urlnopad } from '@scure/base'
import { RendezvousVault, type EncryptedRendezvousRecord, type RendezvousVaultStorage } from './rendezvous-vault.js'
import { BrowserMlsRoomForeground } from './mls-room-foreground.js'
import { withMlsRoomCreateRendezvous, type MlsRoomCreateRendezvous } from './mls-room-create-rendezvous.js'

const account = getPublicKey(new Uint8Array(32).fill(1)), device = getPublicKey(new Uint8Array(32).fill(2))
const scalar = new Uint8Array(32).fill(3), rz = getPublicKey(scalar), nonce = new Uint8Array(16).fill(9)
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
class Storage implements RendezvousVaultStorage {
  storedKey?: CryptoKey
  value?: EncryptedRendezvousRecord
  epoch = 0
  queue = Promise.resolve()
  withLock<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }
  revision() { return String(this.epoch) }
  invalidate() { this.epoch++ }
  async key() { return this.storedKey }
  async saveKey(key: CryptoKey) { this.storedKey = key }
  async record() { return this.value }
  async put(record: EncryptedRendezvousRecord) { this.value = record }
  async remove() { this.value = undefined }
}
async function fixture(install = true) {
  const storage = new Storage(), source = new RendezvousVault(storage, webcrypto as unknown as Crypto)
  let clock = 1000
  if (install) {
    const fields = { v: 1, p: account, d: device, rz, u: 'rendezvous', i: 7, n: base64urlnopad.encode(nonce), e: 1300 }
    const result = await source.accept(JSON.stringify({ ...fields, c: 'bounded-fixture-ciphertext' }),
      { identity: account, device, nonce, now: clock },
      { decrypt: async () => JSON.stringify({ ...fields, k: base64urlnopad.encode(scalar) }) })
    expect(result.ok).toBe(true)
  }
  const foreground = new BrowserMlsRoomForeground()
  const run = <T>(work: (custody: MlsRoomCreateRendezvous) => Promise<T>, selectedDevice = device) =>
    foreground.run(account, () => true, scope => withMlsRoomCreateRendezvous(source, foreground, scope, selectedDevice, () => clock, work))
  return { storage, source, foreground, run, clock: (value: number) => { clock = value } }
}
describe('room creation custody from the actual encrypted child', () => {
  beforeEach(() => vi.stubGlobal('document', { visibilityState: 'visible' }))
  afterEach(() => vi.unstubAllGlobals())
  it('exposes a frozen public receipt without scalar or ECDH authority', async () => {
    const f = await fixture()
    const result = await f.run(async custody => {
      expect(Object.keys(custody).sort()).toEqual(['current', 'receipt', 'releaseCurrent'])
      expect(Object.isFrozen(custody)).toBe(true); expect(Object.isFrozen(custody.receipt)).toBe(true)
      expect(custody.receipt).toEqual({ identity: account, device, rendezvousPubkey: rz, index: 7, expiresAt: 1300 })
      expect(custody.current()).toBe(true)
      return custody
    })
    expect(result.state).toBe('done')
    if (result.state === 'done') expect(result.value.current()).toBe(false)
  })
  it.each(['missing', 'wrong-device', 'bad-clock', 'corrupt'] as const)('refuses %s storage before work', async mode => {
    const f = await fixture(mode !== 'missing'), work = vi.fn(async () => 1)
    if (mode === 'bad-clock') f.clock(NaN)
    if (mode === 'corrupt') f.storage.value = { ...f.storage.value!, ciphertext: new ArrayBuffer(3) }
    await expect(f.run(work, mode === 'wrong-device' ? '55'.repeat(32) : device)).rejects.toThrow()
    expect(work).not.toHaveBeenCalled()
  })
  it('rejects copied foreground scopes and structural child sources', async () => {
    const f = await fixture()
    await f.foreground.run(account, () => true, async scope => {
      const work = vi.fn(async () => 1)
      await expect(withMlsRoomCreateRendezvous(f.source, f.foreground, { ...scope }, device, () => 1000, work)).rejects.toThrow()
      await expect(withMlsRoomCreateRendezvous({ withCurrentChild: f.source.withCurrentChild } as RendezvousVault,
        f.foreground, scope, device, () => 1000, work)).rejects.toThrow()
      expect(work).not.toHaveBeenCalled()
    })
  })
  it.each(['return', 'throw'] as const)('keeps the child lock through actual nested work after callback %s', async end => {
    const f = await fixture(), began = deferred(), tail = deferred(), lower = deferred()
    let childReleased = false, ownerReleased = false
    const result = f.run(async () => {
      const scope = f.foreground.capture()!
      void f.foreground.track(scope, async () => { began.resolve(); await tail.promise })
      await began.promise; lower.resolve()
      if (end === 'throw') throw new Error('lower cancelled')
      return 1
    }).then(value => { ownerReleased = true; return value }, error => { ownerReleased = true; return { error: error.message } })
    await lower.promise
    const second = f.storage.withLock(async () => { childReleased = true })
    await Promise.resolve(); await Promise.resolve()
    expect(childReleased).toBe(false); expect(ownerReleased).toBe(false)
    expect(await f.foreground.run(account, () => true, async () => 2)).toEqual({ state: 'busy' })
    tail.resolve(); await result; await second
    expect(childReleased).toBe(true); expect(ownerReleased).toBe(true)
  })
  it('joins new tails registered while an earlier signing tail settles', async () => {
    const f = await fixture(), began = deferred(), first = deferred(), second = deferred()
    let unlocked = false
    const result = f.run(async () => {
      const scope = f.foreground.capture()!
      void f.foreground.track(scope, async () => {
        began.resolve(); await first.promise
        void f.foreground.track(scope, () => second.promise)
      })
      await began.promise; return 1
    })
    await began.promise
    const waiting = f.storage.withLock(async () => { unlocked = true })
    first.resolve(); await first.promise; await Promise.resolve()
    expect(unlocked).toBe(false)
    second.resolve(); expect(await result).toEqual({ state: 'done', value: 1 }); await waiting
  })
  it('another concrete vault invalidates a held child before waiting for its lock', async () => {
    const f = await fixture(), entered = deferred(), tail = deferred()
    let custody!: MlsRoomCreateRendezvous, cleared = false
    const result = f.run(async held => { custody = held; entered.resolve(); await tail.promise; return held.current() })
    await entered.promise
    const clear = new RendezvousVault(f.storage, webcrypto as unknown as Crypto).clear(account).then(() => { cleared = true })
    expect(custody.current()).toBe(false); expect(custody.releaseCurrent()).toBe(false); expect(cleared).toBe(false)
    tail.resolve(); expect(await result).toEqual({ state: 'done', value: false }); await clear
    expect(f.storage.value).toBeUndefined()
  })
  it('a queued creation cannot miss invalidation before acquiring the child lock', async () => {
    const f = await fixture(), entered = deferred(), release = deferred(), work = vi.fn(async () => 1)
    const holding = f.storage.withLock(async () => { entered.resolve(); await release.promise })
    await entered.promise
    const creation = f.run(work)
    const observed = creation.catch(error => error.message)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    const clear = new RendezvousVault(f.storage, webcrypto as unknown as Crypto).clear(account)
    release.resolve(); await holding
    expect(await observed).toBe('stale-rendezvous'); await clear
    expect(work).not.toHaveBeenCalled()
  })
  it.each(['revision', 'bad-clock', 'foreground'] as const)('rechecks %s after unlock while outer cleanup is pending', async mode => {
    const f = await fixture()
    let clock = 1000
    expect(await f.foreground.run(account, () => true, async scope => {
      const held = await withMlsRoomCreateRendezvous(f.source, f.foreground, scope, device, () => clock, async custody => custody)
      expect(held.current()).toBe(false); expect(held.releaseCurrent()).toBe(true)
      if (mode === 'revision') f.storage.invalidate()
      else if (mode === 'bad-clock') clock = NaN
      else f.foreground.invalidate()
      expect(held.releaseCurrent()).toBe(false)
      return 1
    })).toEqual(mode === 'foreground' ? { state: 'interrupted' } : { state: 'done', value: 1 })
  })
})
