import { expect, it } from 'vitest'
import { ChannelChecks } from './channel-checks.js'
import { memoryDeviceStore } from './device-store.js'
import { createChannelCheckAcceptance, createChannelCheckRequest, parseChannelCheckMessage } from '@forgesworn/signet-contacts'
const a = '1'.repeat(64), b = '2'.repeat(64), context = '3'.repeat(64)
function setup() {
  const store = memoryDeviceStore(), toA: string[] = [], toB: string[] = []
  let current = true, time = 1800000000, fail = false, allowed = true
  let tail = Promise.resolve()
  const lock = <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task); tail = result.then(() => {}, () => {}); return result
  }
  const make = (local: string) => new ChannelChecks({ local, context, store, lock, now: () => time, current: () => current, allowed: () => allowed,
    send: async text => { if (fail) throw new Error('offline'); (local === a ? toB : toA).push(text) } })
  return { store, toA, toB, make, alice: make(a), bob: make(b), tick: () => { time++ },
    offline: (value: boolean) => { fail = value }, close: () => { current = false }, block: () => { allowed = false } }
}
it('requires explicit acceptance and comparison, with matching persisted words after restart', async () => {
  const t = setup(), id = await t.alice.start(b)
  await t.bob.receive(a, t.toB.shift()!)
  expect(t.toA).toEqual([]); expect(t.bob.words(id)).toBeUndefined()
  await t.bob.accept(id)
  await t.alice.receive(b, t.toA.shift()!)
  await t.bob.receive(a, t.toB.shift()!)
  const words = t.alice.words(id)!
  expect(t.bob.words(id)).toEqual({ youSay: words.theySay, theySay: words.youSay })
  expect(t.make(a).words(id)).toEqual(words)
  expect(t.alice.list()[0].checkedAt).toBeUndefined()
  await t.alice.confirm(id)
  expect(t.make(a).list()[0].checkedAt).toBe(1800000000)
  expect(t.bob.list()[0].checkedAt).toBeUndefined()
})
it('persists acceptance pinning before revealing and refuses a replacement after a failed send/restart', async () => {
  const t = setup(), id = await t.alice.start(b)
  await t.bob.receive(a, t.toB.shift()!); await t.bob.accept(id)
  const acceptance = t.toA.shift()!
  t.offline(true)
  await expect(t.alice.receive(b, acceptance)).rejects.toThrow('offline')
  const reloaded = t.make(a)
  expect(reloaded.list()[0].state?.phase).toBe('reveal-pending')
  expect(reloaded.words(id)).toBeUndefined()
  const alternate = createChannelCheckAcceptance(reloaded.list()[0].request, '7'.repeat(64), 1800000000)
  await expect(reloaded.receive(b, JSON.stringify(alternate))).rejects.toThrow('pinned')
  t.offline(false); await reloaded.retry(id)
  await t.bob.receive(a, t.toB.shift()!)
  expect(reloaded.words(id)?.youSay).toBe(t.bob.words(id)?.theySay)
  const count = t.toB.length
  await reloaded.receive(b, acceptance)
  expect(t.toB).toHaveLength(count)
})
it('sends nothing when durable storage fails and fails closed on corrupt history', async () => {
  const t = setup()
  t.store.set = () => { throw new Error('quota') }
  await expect(t.alice.start(b)).rejects.toThrow('quota')
  expect(t.toB).toEqual([])
  t.store.get = () => '{broken'
  expect(() => t.alice.list()).toThrow()
  await expect(t.alice.start(b)).rejects.toThrow()
  expect(t.toB).toEqual([])
})
it('binds the authenticated participant and room, preserves declines, and ignores expired replay', async () => {
  const t = setup(), id = await t.alice.start(b), request = t.toB.shift()!
  await t.bob.receive('4'.repeat(64), request)
  await t.bob.receive(a, JSON.stringify({ ...JSON.parse(request), context: '4'.repeat(64) }))
  expect(t.bob.list()).toEqual([])
  await t.bob.receive(a, request); await t.bob.decline(id)
  await t.bob.receive(a, request)
  await expect(t.bob.accept(id)).rejects.toThrow()
  expect(t.toA).toEqual([])
  const old = createChannelCheckRequest({ id: '5'.repeat(32), context, from: a, to: b, nonce: '6'.repeat(64), now: 1700000000 })
  await t.bob.receive(a, JSON.stringify(old))
  expect(t.bob.list()).toHaveLength(1)
})
it('coordinates duplicate starts and acceptances across controllers and stops after leaving', async () => {
  const t = setup()
  const ids = await Promise.all([t.alice.start(b), t.make(a).start(b)])
  expect(ids[0]).toBe(ids[1]); expect(t.toB).toHaveLength(1)
  await t.bob.receive(a, t.toB.shift()!)
  await Promise.all([t.bob.accept(ids[0]), t.make(b).accept(ids[0])])
  expect(t.toA).toHaveLength(1)
  const message = parseChannelCheckMessage(t.toA[0])!
  expect(message.type).toBe('channel-check-accept')
  t.close()
  await expect(t.alice.receive(b, t.toA[0])).rejects.toThrow('closed')
  expect(t.toB).toEqual([])
})

it('checks a new block before revealing or starting another exchange', async () => {
  const t = setup(), id = await t.alice.start(b)
  await t.bob.receive(a, t.toB.shift()!); await t.bob.accept(id)
  t.block()
  await t.alice.receive(b, t.toA.shift()!)
  expect(t.toB).toEqual([])
  expect(t.alice.words(id)).toBeUndefined()
  await expect(t.alice.start(b)).rejects.toThrow('blocked')
  await expect(t.bob.retry(id)).rejects.toThrow('blocked')
})
