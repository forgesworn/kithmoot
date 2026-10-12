import { describe, it, expect, vi } from 'vitest'
import type { Event } from 'nostr-tools/pure'
import { memoryDeviceStore } from './device-store.js'
import { PendingSends, stateAfter, neverLeft, RETRY_SECONDS, CONNECT_POLL_MS, type PendingSend } from './pending-sends.js'
import { CONVERSATION_MOVED } from '../../src/chat.js'

const ROOM = 'a'.repeat(64)
const event = (id: string) => ({ id, kind: 1, pubkey: 'p', created_at: 1, tags: [], content: id, sig: 's' }) as Event

function harness(connected = true) {
  const store = memoryDeviceStore()
  let clock = 1_000_000
  const timers: Array<{ at: number; run: () => void }> = []
  const state = { connected }
  const pending = new PendingSends({
    store, connected: () => state.connected, now: () => clock,
    schedule: (run, ms) => { timers.push({ at: clock + ms, run }) },
  })
  const advance = async (ms: number) => {
    clock += ms
    for (const timer of timers.splice(0).filter(t => { if (t.at <= clock) return true; timers.push(t); return false })) timer.run()
    for (let i = 0; i < 60; i++) await Promise.resolve()
  }
  return { store, pending, state, advance }
}

async function add(pending: PendingSends, id: string, publish: () => Promise<void>, durable = true): Promise<PendingSend> {
  await pending.add({ id, roomId: ROOM, channel: 'Chat', text: `text ${id}`, files: [], event: event(id), publish, durable })
  return pending.items(ROOM).find(item => item.id === id)!
}

const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve() }

describe('unsent messages', () => {
  it('keeps artwork through reload and retry, and can take it back for editing without losing the reference', async () => {
    const h = harness(false)
    const artwork = [{ pack: 'kithmoot-original-v1', id: 'coffee', kind: 'gif' as const, sha256: 'a'.repeat(64), label: 'Coffee' }]
    await h.pending.add({ id: 'art', roomId: ROOM, channel: 'Chat', text: 'GIF: Coffee', files: [], artwork, event: event('art'), publish: async () => {}, durable: true, editable: true })
    const restored = new PendingSends({ store: h.store, connected: () => false, schedule: () => {} })
    const [item] = await restored.restore(ROOM)
    expect(item?.artwork).toEqual(artwork)
    const editable = new PendingSends({ store: h.store, connected: () => false, schedule: () => {} })
    await editable.restore(ROOM)
    expect((await editable.take('art'))?.artwork).toEqual(artwork)
    const publish = vi.fn(async () => {})
    restored.resume('art', publish)
    restored.retry('art')
    await flush()
    expect(publish).toHaveBeenCalledOnce()
    expect(restored.items(ROOM)[0]?.artwork).toEqual(artwork)
  })
  it('reads what a failed publish says about where the event went', () => {
    expect(stateAfter(new Error('every relay rejected the event (wss://a: blocked)'))).toBe('refused')
    expect(stateAfter(new Error('no relay could be reached in time (wss://a: timeout)'))).toBe('unknown')
    expect(stateAfter(new Error(CONVERSATION_MOVED))).toBe('moved')
    expect(stateAfter(new Error('something else'))).toBe('unknown')
  })

  it('is not offered to the relays while none can be reached, then goes when one can', async () => {
    const h = harness(false)
    const publish = vi.fn(async () => {})
    const item = await add(h.pending, 'one', publish)
    await flush()
    expect(publish).not.toHaveBeenCalled()
    expect(h.pending.items(ROOM).find(saved => saved.id === item.id)?.state).toBe('waiting')
    h.state.connected = true
    await h.advance(CONNECT_POLL_MS)
    expect(publish).toHaveBeenCalledOnce()
  })

  it('keeps an accepted row until its message is on screen, even without an echo', async () => {
    const h = harness()
    await add(h.pending, 'one', async () => {}); await add(h.pending, 'two', async () => {})
    await flush()
    await h.pending.arrived(['one'])
    expect(h.pending.items(ROOM).map(item => item.id)).toEqual(['two'])
    await h.advance(60_000)
    expect(h.pending.items(ROOM).map(item => item.id)).toEqual(['two'])
    expect(h.pending.items(ROOM)[0]!.acknowledged).toBe(true)
    await h.pending.arrived(['two'])
    expect(h.pending.items(ROOM)).toEqual([])
  })

  it('retries on a back-off with the same event, and says whether it could have arrived', async () => {
    const h = harness()
    const publish = vi.fn()
      .mockRejectedValueOnce(new Error('no relay could be reached in time (wss://a)'))
      .mockRejectedValueOnce(new Error('every relay rejected the event (wss://a: rate-limited)'))
      .mockResolvedValue(undefined)
    const item = await add(h.pending, 'one', publish)
    await flush()
    expect(h.pending.items(ROOM).find(saved => saved.id === item.id)?.state).toBe('unknown')
    await h.advance(RETRY_SECONDS[1]! * 1000)
    expect(h.pending.items(ROOM).find(saved => saved.id === item.id)?.state).toBe('refused')
    await h.advance(RETRY_SECONDS[2]! * 1000)
    expect(publish).toHaveBeenCalledTimes(3)
    expect(h.pending.items(ROOM).find(saved => saved.id === item.id)?.acknowledged).toBe(true)
  })

  it('never retries a message whose conversation moved on', async () => {
    const h = harness()
    const publish = vi.fn().mockRejectedValue(new Error(CONVERSATION_MOVED))
    const item = await add(h.pending, 'one', publish)
    await flush()
    expect(h.pending.items(ROOM).find(saved => saved.id === item.id)?.state).toBe('moved')
    await h.advance(120_000)
    h.pending.retry('one')
    await flush()
    expect(publish).toHaveBeenCalledOnce()
  })

  it('keeps an unsent message across a reload, and drops it once a relay has it', async () => {
    const h = harness(false)
    await add(h.pending, 'one', async () => {})
    await add(h.pending, 'brief', async () => {}, false)
    const next = new PendingSends({ store: h.store, connected: () => true })
    const restored = await next.restore(ROOM)
    expect(restored.map(item => [item.id, item.state, item.text])).toEqual([['one', 'waiting', 'text one']])
    const publish = vi.fn(async () => {})
    next.resume('one', publish)
    await flush()
    expect(publish).toHaveBeenCalledOnce()
    expect(h.store.get(`kithmoot.pending.${ROOM}`) ?? undefined).toBeUndefined()
  })

  it('says a reload caught mid-send may have arrived', async () => {
    const h = harness()
    await add(h.pending, 'one', () => new Promise(() => {}))
    await flush()
    const next = new PendingSends({ store: h.store, connected: () => true })
    expect((await next.restore(ROOM))[0]!.state).toBe('unknown')
  })

  it('will not dismiss a message while it is being sent', async () => {
    const h = harness()
    await add(h.pending, 'one', () => new Promise(() => {}))
    await flush()
    expect(await h.pending.dismiss('one')).toBeUndefined()
    expect(h.pending.items(ROOM)).toHaveLength(1)
  })

  it('waits, kept, while its room is not the one open, and goes through the room once it is again', async () => {
    const store = memoryDeviceStore()
    let open: string | undefined = ROOM
    const pending = new PendingSends({ store, connected: () => true, active: () => open })
    const closed = vi.fn().mockRejectedValue(new Error(CONVERSATION_MOVED))
    open = undefined
    await pending.add({ id: 'one', roomId: ROOM, channel: 'Chat', text: 't', files: [], event: event('one'), publish: closed, durable: true })
    pending.wake()
    await flush()
    expect(closed).not.toHaveBeenCalled()
    open = ROOM
    pending.release(ROOM)
    const fresh = vi.fn(async () => {})
    for (const item of await pending.restore(ROOM)) pending.resume(item.id, fresh)
    await flush()
    expect(fresh).toHaveBeenCalledOnce()
    expect(closed).not.toHaveBeenCalled()
  })

  it('gives back only a message nothing of which has left the device', async () => {
    const h = harness(false)
    await add(h.pending, 'offline', async () => {})
    expect(neverLeft(h.pending.items(ROOM)[0]!)).toBe(true)
    expect((await h.pending.take('offline'))?.text).toBe('text offline')
    expect(h.pending.items(ROOM)).toEqual([])
    h.state.connected = true
    const unanswered = await add(h.pending, 'unanswered', vi.fn().mockRejectedValue(new Error('no relay could be reached in time')))
    const refused = await add(h.pending, 'refused', vi.fn().mockRejectedValue(new Error('every relay rejected the event')))
    await flush()
    expect(h.pending.items(ROOM).find(saved => saved.id === unanswered.id)?.state).toBe('unknown')
    expect(await h.pending.take('unanswered')).toBeUndefined()
    const retainedRefused = h.pending.items(ROOM).find(saved => saved.id === refused.id)
    expect(await h.pending.take('refused')).toEqual(retainedRefused)
  })

  it('remembers across a reload which messages Edit can take back', async () => {
    const h = harness(false)
    await h.pending.add({ id: 'plain', roomId: ROOM, channel: 'Chat', text: 't', files: [], event: event('plain'), publish: async () => {}, durable: true, editable: true })
    await add(h.pending, 'reply', async () => {})
    const next = new PendingSends({ store: h.store, connected: () => false })
    expect((await next.restore(ROOM)).map(item => [item.id, item.editable === true])).toEqual([['plain', true], ['reply', false]])
  })

  it('holds a message for the chosen moment, takes it back unsent, or sends it now', async () => {
    const h = harness()
    const held = vi.fn(async () => {})
    await h.pending.add({ id: 'held', roomId: ROOM, channel: 'Chat', text: 'oops', files: [], event: event('held'), publish: held, durable: true, editable: true }, 5_000)
    expect(h.pending.items(ROOM)[0]!.state).toBe('holding')
    expect(h.pending.holding).toBe(true)
    await h.advance(4_000)
    expect(held).not.toHaveBeenCalled()
    expect((await h.pending.take('held'))?.text).toBe('oops')
    await h.advance(2_000)
    expect(held).not.toHaveBeenCalled()
    const now = vi.fn(async () => {})
    await h.pending.add({ id: 'now', roomId: ROOM, channel: 'Chat', text: 't', files: [], event: event('now'), publish: now, durable: true }, 10_000)
    h.pending.retry('now')
    await flush()
    expect(now).toHaveBeenCalledOnce()
  })

  it('sends a held message once its moment has passed, and after a reload during it', async () => {
    const h = harness()
    const publish = vi.fn(async () => {})
    await h.pending.add({ id: 'held', roomId: ROOM, channel: 'Chat', text: 't', files: [], event: event('held'), publish, durable: true }, 5_000)
    const next = new PendingSends({ store: h.store, connected: () => true })
    expect((await next.restore(ROOM))[0]!.state).toBe('waiting')
    await h.advance(5_000)
    expect(publish).toHaveBeenCalledOnce()
  })

  it('lists each room on its own', async () => {
    const h = harness(false)
    await add(h.pending, 'one', async () => {})
    await h.pending.add({ id: 'two', roomId: 'b'.repeat(64), channel: 'Chat', text: 't', files: [], event: event('two'), publish: async () => {}, durable: true })
    expect(h.pending.items(ROOM).map(item => item.id)).toEqual(['one'])
  })
})

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function custody(connected = true) {
  let image = { durable: null as string | null, transient: null as string | null }
  const retain = vi.fn(async (_room: string, durable: string | null, transient: string | null) => { image = { durable, transient } })
  const load = vi.fn(async () => ({ ...image }))
  const holds = vi.fn(), timers: Array<() => void> = []
  const pending = new PendingSends({ storage: { retain, load }, connected: () => connected, onStorageHold: holds, schedule: run => timers.push(run) })
  return { pending, retain, load, holds, timers, image: () => ({ ...image }), seed: (durable: string | null, transient: string | null = null) => { image = { durable, transient } } }
}
const input = (id: string, publish = vi.fn(async (_saved: Event) => {}), durable = true) =>
  ({ id, roomId: ROOM, channel: 'Chat', text: `text ${id}`, files: ['one'], event: event(id), publish, durable })

describe('acknowledged pending-message custody', () => {
  it('keeps the inner message id distinct from the signed event id on reload', async () => {
    const h = custody(false), submitted = input('inner-message-id')
    submitted.event.id = 'outer-event-id'
    await h.pending.add(submitted); h.pending.release(ROOM)
    const [restored] = await h.pending.restore(ROOM)
    expect(restored?.id).toBe('inner-message-id'); expect(restored?.event.id).toBe('outer-event-id')
  })
  it('holds add and publishing until the exact first custody receipt', async () => {
    const h = custody(), gate = deferred(), sent = vi.fn(async () => {})
    h.retain.mockImplementationOnce(async (room, durable, transient) => { await gate.promise; h.seed(durable, transient) })
    let acknowledged = false
    const work = h.pending.add(input('one', sent)).then(() => { acknowledged = true })
    await flush()
    expect(acknowledged).toBe(false); expect(h.pending.items()).toEqual([]); expect(sent).not.toHaveBeenCalled()
    expect(JSON.parse(h.retain.mock.calls[0]![1]!)[0].event).toEqual(event('one'))
    gate.resolve(); await work; await flush()
    expect(acknowledged).toBe(true); expect(sent).toHaveBeenCalledExactlyOnceWith(event('one'))
  })
  it('rejects a first write without installing or publishing any message', async () => {
    const h = custody(), sent = vi.fn(async () => {})
    h.retain.mockRejectedValueOnce(new Error('quota'))
    await expect(h.pending.add(input('one', sent))).rejects.toThrow('quota')
    h.pending.wake(); await flush()
    expect(h.pending.items()).toEqual([]); expect(sent).not.toHaveBeenCalled(); expect(h.image().durable).toBeNull()
  })
  it('retains temporary sends too, without assigning durable custody', async () => {
    const h = custody(false)
    await h.pending.add(input('brief', undefined, false))
    expect(h.image().durable).toBeNull(); expect(JSON.parse(h.image().transient!)[0].id).toBe('brief')
    h.pending.release(ROOM)
    expect((await h.pending.restore(ROOM))[0]?.durable).toBe(false)
  })
  it('does not publish after its pre-send receipt fails; only an explicit retry releases it', async () => {
    const h = custody(), sent = vi.fn(async () => {})
    h.retain.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('native receipt unknown'))
    await h.pending.add(input('one', sent)); await flush()
    expect(sent).not.toHaveBeenCalled(); expect(h.holds).toHaveBeenCalledOnce()
    for (const run of h.timers) run()
    h.pending.wake(); await flush(); expect(sent).not.toHaveBeenCalled()
    await h.pending.retry('one'); expect(sent).toHaveBeenCalledOnce()
  })
  for (const succeeds of [true, false]) it(`holds a failed final receipt after relay ${succeeds ? 'acceptance' : 'refusal'} without permanent sending or automatic replay`, async () => {
    const h = custody(), sent = vi.fn(async () => { if (!succeeds) throw new Error('every relay rejected the event') })
    h.retain.mockImplementationOnce(async (_r, d, t) => h.seed(d, t))
      .mockImplementationOnce(async (_r, d, t) => h.seed(d, t)).mockRejectedValueOnce(new Error('final receipt failed'))
    await h.pending.add(input('one', sent)); await flush()
    expect(h.pending.items()[0]?.state).toBe('unknown'); expect(h.pending.items()[0]?.acknowledged).not.toBe(true)
    expect(JSON.parse(h.image().durable!)[0].state).toBe('unknown')
    h.pending.wake(); h.timers.forEach(run => run()); await flush(); expect(sent).toHaveBeenCalledOnce()
    await h.pending.retry('one'); expect(sent).toHaveBeenCalledTimes(2)
  })
  it('revokes a room while first retention is outstanding, without an old publisher', async () => {
    const h = custody(), gate = deferred(), sent = vi.fn(async () => {})
    h.retain.mockImplementationOnce(async (_r, d, t) => { await gate.promise; h.seed(d, t) })
    const work = h.pending.add(input('one', sent)); const rejected = expect(work).rejects.toThrow(CONVERSATION_MOVED)
    await flush(); h.pending.release(ROOM); gate.resolve(); await rejected; await flush()
    expect(h.pending.items()).toEqual([]); expect(sent).not.toHaveBeenCalled()
    expect((await h.pending.restore(ROOM))[0]?.id).toBe('one')
  })
  it('revokes a room after staging unknown but before publication', async () => {
    const h = custody(), gate = deferred(), sent = vi.fn(async () => {})
    h.retain.mockImplementationOnce(async (_r, d, t) => h.seed(d, t))
      .mockImplementationOnce(async (_r, d, t) => { h.seed(d, t); await gate.promise })
    await h.pending.add(input('one', sent)); await flush()
    expect(JSON.parse(h.image().durable!)[0].state).toBe('unknown')
    h.pending.release(ROOM); gate.resolve(); await flush()
    expect(sent).not.toHaveBeenCalled(); expect(h.pending.items()).toEqual([]); expect(h.holds).not.toHaveBeenCalled()
  })
  it('restores and retries the same id while an old publisher hangs; its late settlement cannot block the new row', async () => {
    const h = custody(), old = deferred(), fresh = deferred(), oldSend = vi.fn(() => old.promise), newSend = vi.fn(() => fresh.promise)
    await h.pending.add(input('one', oldSend)); await flush(); expect(oldSend).toHaveBeenCalledOnce()
    h.pending.release(ROOM); await h.pending.restore(ROOM); h.pending.resume('one', newSend); await flush()
    expect(newSend).toHaveBeenCalledOnce()
    old.reject(new Error('old transport failure')); await flush()
    expect(h.holds).not.toHaveBeenCalled(); expect(h.pending.items()[0]?.state).toBe('sending')
    fresh.resolve(); await flush(); expect(h.pending.items()[0]?.acknowledged).toBe(true)
  })
  it('does not let an old hold timer release a replacement row with the same id', async () => {
    const h = custody(), oldSend = vi.fn(async () => {}), freshSend = vi.fn(async () => {})
    await h.pending.add(input('one', oldSend), 5_000)
    const oldTimer = h.timers[0]!
    h.pending.release(ROOM); await h.pending.add(input('one', freshSend), 20_000)
    oldTimer(); await flush()
    expect(h.pending.items()[0]?.state).toBe('holding'); expect(freshSend).not.toHaveBeenCalled(); expect(oldSend).not.toHaveBeenCalled()
  })
  it('closes synchronously, joins outstanding custody, and releases no later timer or publisher', async () => {
    const h = custody(), gate = deferred(), sent = vi.fn(async () => {})
    h.retain.mockImplementationOnce(async (_r, d, t) => { await gate.promise; h.seed(d, t) })
    const addWork = h.pending.add(input('one', sent)); const rejected = expect(addWork).rejects.toThrow(CONVERSATION_MOVED)
    await flush(); let joined = false
    const close = h.pending.close().then(() => { joined = true })
    expect(h.pending.items()).toEqual([]); await flush(); expect(joined).toBe(false)
    gate.resolve(); await rejected; await close; h.timers.forEach(run => run()); h.pending.wake(); await flush()
    expect(sent).not.toHaveBeenCalled(); await expect(h.pending.add(input('two'))).rejects.toThrow(CONVERSATION_MOVED)
  })
  it('does not wait for a hanging remote publisher on close or react to its settlement', async () => {
    const h = custody(), gate = deferred()
    await h.pending.add(input('one', vi.fn(() => gate.promise))); await flush()
    const receipts = h.retain.mock.calls.length
    await h.pending.close(); gate.resolve(); await flush()
    expect(h.retain).toHaveBeenCalledTimes(receipts); expect(h.pending.items()).toEqual([]); expect(h.holds).not.toHaveBeenCalled()
  })
  it('isolates input, public snapshots and publisher arguments from the retained event', async () => {
    const h = custody(false), captured = input('one'), before = structuredClone(captured.event)
    captured.event.tags = [['room', 'original']]; before.tags = [['room', 'original']]
    const work = h.pending.add(captured)
    captured.event.content = 'changed input'; captured.event.tags[0]![1] = 'changed input'; captured.files.push('changed')
    await work
    const snapshot = h.pending.items()[0]!
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.event.tags[0])).toBe(true)
    expect(() => { snapshot.event.content = 'changed view' }).toThrow()
    expect(snapshot).not.toHaveProperty('publish'); expect(snapshot.files).toEqual(['one'])
    const sent = vi.fn(async (saved: Event) => { expect(saved).toEqual(before); saved.content = 'publisher mutation' })
    h.pending.release(ROOM); await h.pending.restore(ROOM); h.pending.resume('one', sent); await h.pending.retry('one')
    expect(h.pending.items()[0]?.event).toEqual(before); expect(sent).toHaveBeenCalledOnce()
  })
  it('does not mistake observer failure for a missing custody receipt', async () => {
    const h = custody(false), notify = vi.fn(() => { throw new Error('render') })
    const pending = new PendingSends({ storage: { retain: h.retain, load: h.load }, connected: () => false, onChange: notify, schedule: () => { throw new Error('timer') }, onStorageHold: () => { throw new Error('observer') } })
    await expect(pending.add(input('one'))).resolves.toBeUndefined()
    expect(pending.items()[0]?.id).toBe('one'); expect(JSON.parse(h.image().durable!)[0].id).toBe('one')
  })
  for (const throws of ['active', 'connected'] as const) it(`keeps an acknowledged add positive when ${throws} throws afterwards`, async () => {
    const h = custody(false), pending = new PendingSends({ storage: { retain: h.retain, load: h.load }, connected: () => { if (throws === 'connected') throw new Error('connection'); return true }, active: () => { if (throws === 'active') throw new Error('scope'); return ROOM }, schedule: () => {} })
    await expect(pending.add(input('one'))).resolves.toBeUndefined(); expect(pending.items()[0]?.id).toBe('one')
  })
  it('refuses the fifty-first send without dropping a signed event or changing storage', async () => {
    const h = custody(false)
    for (let i = 0; i < 50; i++) await h.pending.add(input(`id-${i}`))
    const before = h.image(), calls = h.retain.mock.calls.length
    await expect(h.pending.add(input('overflow'))).rejects.toThrow('full')
    expect(h.image()).toEqual(before); expect(h.retain).toHaveBeenCalledTimes(calls); expect(h.pending.items()).toHaveLength(50)
  })
  it('holds a removal until custody, and preserves the row on failure', async () => {
    const h = custody(false), gate = deferred()
    await h.pending.add(input('one'))
    h.retain.mockImplementationOnce(async () => { await gate.promise })
    const remove = h.pending.take('one'); const rejected = expect(remove).rejects.toThrow('remove quota')
    await flush(); expect(h.pending.items()).toHaveLength(1)
    gate.reject(new Error('remove quota')); await rejected; expect(h.pending.items()).toHaveLength(1)
    expect((await h.pending.take('one'))?.id).toBe('one')
  })
  for (const corrupt of ['second row', 'duplicate classes', 'bad tags', 'load failure'] as const) it(`restores no partial state on ${corrupt}`, async () => {
    const h = custody(false)
    await h.pending.add(input('one')); const valid = JSON.parse(h.image().durable!)
    h.pending.release(ROOM)
    if (corrupt === 'second row') h.seed(JSON.stringify([...valid, { id: 'invalid' }]))
    else if (corrupt === 'duplicate classes') h.seed(JSON.stringify(valid), JSON.stringify(valid))
    else if (corrupt === 'bad tags') { valid[0].event.tags = null; h.seed(JSON.stringify(valid)) }
    else h.load.mockRejectedValueOnce(new Error('read failed'))
    await expect(h.pending.restore(ROOM)).rejects.toThrow(); expect(h.pending.items()).toEqual([])
  })
  it('refuses the same event id in another room without overwriting the active row', async () => {
    const h = custody(false); await h.pending.add(input('one')); const before = h.image()
    await expect(h.pending.add({ ...input('one'), roomId: 'b'.repeat(64) })).rejects.toThrow('already exists')
    await expect(h.pending.restore('b'.repeat(64))).rejects.toThrow('another room')
    expect(h.image()).toEqual(before); expect(h.pending.items()[0]?.roomId).toBe(ROOM)
  })
})
