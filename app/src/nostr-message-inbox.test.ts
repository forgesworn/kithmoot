import { afterEach, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, getEventHash, type Event } from 'nostr-tools/pure'
import { createWrap, wrapEvent } from 'nostr-tools/nip59'
import { nip44 } from 'nostr-tools'
import type { RelayTransport } from '../../src/relay-pool.js'
import { memoryDeviceStore } from './device-store.js'
import { NostrMessageInbox } from './nostr-message-inbox.js'
import { OrdinaryMessageHistory, ordinaryHistoryKey, rememberOrdinaryCopy } from './nostr-message-history.js'
import { captureOrdinaryCopy, ordinaryInboxRelays } from './nostr-message-wire.js'

afterEach(() => { vi.useRealTimers() })
function fixture() {
  const key = generateSecretKey(), sender = generateSecretKey(), self = getPublicKey(key), peer = getPublicKey(sender)
  const store = memoryDeviceStore()
  let now = Math.floor(Date.now() / 1000)
  let live = true, block = false, calls = 0, stopped = 0, releases = 0, changes = 0, failures = 0, defer = async () => {}
  let render = () => {}, eager: ((receive: (event: Event) => void) => void) | undefined
  let incoming: (event: Event) => void = () => {}
  let end: () => void = () => {}
  const transport: Pick<RelayTransport, 'subscribe' | 'close'> = {
    subscribe: (filters, receive, eose) => {
      expect(filters).toEqual([{ kinds: [1059], '#p': [self], limit: 128 }])
      incoming = receive; end = () => eose?.(); end(); eager?.(receive)
      return () => { stopped++ }
    },
    close: () => { stopped++ },
  }
  const make = (offline = false) => new NostrMessageInbox({ account: self, store, acquire: async () => () => { releases++ },
    receive: async () => { if (offline) throw Error('Synthetic offline'); return transport }, current: () => live,
    blocked: who => block && who === peer, changed: () => { changes++; render() }, failed: () => { failures++ }, now: () => now,
    decrypt: async (who, content, current) => {
      if (!current()) throw Error('Stale'); calls++; await defer()
      return nip44.v2.decrypt(content, nip44.v2.utils.getConversationKey(key, who))
    } })
  const envelope = (content = 'Literal ordinary text', tags = [['p', self]]) => wrapEvent({ kind: 14, created_at: now, content, tags }, sender, self)
  return { key, sender, self, peer, store, now, make, envelope, receive: (event: Event) => incoming(event),
    calls: () => calls, stopped: () => stopped, releases: () => releases, changes: () => changes, failures: () => failures,
    end: () => end(), change: (work: () => void) => { render = work }, advance: (seconds: number) => { now += seconds },
    eager: (work: (receive: (event: Event) => void) => void) => { eager = work },
    stop: () => { live = false }, block: () => { block = true }, delay: (work: () => Promise<void>) => { defer = work } }
}

it('receives real gift wraps without opening them, then verifies both layers and literal ordinary text', async () => {
  const f = fixture(), inbox = f.make(), event = f.envelope('<img src="https://literal.invalid">\nhttps://literal.invalid/private')
  try {
    await inbox.open(); f.receive(event)
    expect(f.calls()).toBe(0); expect(inbox.snapshot().messages[0]?.status).toBe('sealed')
    await inbox.openMessage(event.id)
    expect(f.calls()).toBe(2)
    expect(inbox.snapshot().messages[0]?.message).toMatchObject({ author: f.peer, peer: f.peer, sentAt: f.now,
      text: '<img src="https://literal.invalid">\nhttps://literal.invalid/private', members: [f.self, f.peer].sort() })
    const raw = f.store.get(ordinaryHistoryKey(f.self))!
    expect(raw).not.toContain('literal.invalid'); expect(raw).not.toContain(f.peer)
    expect(JSON.parse(raw).events[0].id).toBe(event.id)
  } finally { inbox.close() }
})

it('reopens the exact saved ciphertext offline after a fresh inbox lifetime, without cached plaintext or automatic decrypt', async () => {
  const f = fixture(), first = f.make(), event = f.envelope('Retained across restart')
  await first.open(); f.receive(event); await first.openMessage(event.id); first.close()
  const second = f.make(true)
  try {
    await second.open(); expect(f.calls()).toBe(2)
    expect(second.snapshot().messages).toEqual([{ copy: event.id, status: 'sealed' }])
    await second.openMessage(event.id); expect(f.calls()).toBe(4)
    expect(second.snapshot().messages[0]?.message?.text).toBe('Retained across restart')
    expect(second.snapshot().status).toContain('Saved copies remain available')
  } finally { second.close() }
})

it('rejects wrong recipients, forged cached verification and getters before storing or decrypting', async () => {
  const f = fixture(), inbox = f.make(), wrong = wrapEvent({ kind: 14, content: 'Elsewhere', tags: [['p', f.self]] }, f.sender, getPublicKey(generateSecretKey()))
  const forged = f.envelope(); forged.content = f.envelope('Substituted').content
  let getters = 0
  const accessor = { ...f.envelope() }; Object.defineProperty(accessor, 'content', { get: () => { getters++; return 'unexpected' }, enumerable: true })
  try {
    await inbox.open(); f.receive(wrong); f.receive(forged); f.receive(accessor)
    expect(inbox.snapshot().messages).toEqual([]); expect(f.calls()).toBe(0); expect(getters).toBe(0)
    expect(f.store.get(ordinaryHistoryKey(f.self))).toBeNull()
  } finally { inbox.close() }
})

it('refuses a signed seal whose rumor impersonates another author', async () => {
  const f = fixture(), inbox = f.make(), other = getPublicKey(generateSecretKey())
  const template = { kind: 14, pubkey: other, created_at: f.now, tags: [['p', f.self]], content: 'Forged author' }
  const rumor = { ...template, id: getEventHash(template) }
  const seal = finalizeEvent({ kind: 13, created_at: f.now, tags: [],
    content: nip44.v2.encrypt(JSON.stringify(rumor), nip44.v2.utils.getConversationKey(f.sender, f.self)) }, f.sender)
  const event = createWrap(seal, f.self)
  try {
    await inbox.open(); f.receive(event); await inbox.openMessage(event.id)
    expect(inbox.snapshot().messages[0]).toEqual({ copy: event.id, status: 'refused' })
    expect(f.calls()).toBe(2)
  } finally { inbox.close() }
})

it('checks block policy after authenticating the seal and before the second provider call', async () => {
  const f = fixture(), inbox = f.make(), event = f.envelope()
  try {
    await inbox.open(); f.receive(event); f.block(); await inbox.openMessage(event.id)
    expect(f.calls()).toBe(1); expect(inbox.snapshot().messages[0]?.message).toBeUndefined()
  } finally { inbox.close() }
})

for (const boundary of ['close', 'account'] as const) it(`cannot adopt a late outer decrypt after ${boundary}`, async () => {
  const f = fixture(), inbox = f.make(), event = f.envelope('Never restore cancelled plaintext')
  let release!: () => void; f.delay(() => new Promise<void>(resolve => { release = resolve }))
  await inbox.open(); f.receive(event)
  const pending = inbox.openMessage(event.id)
  expect(f.calls()).toBe(1)
  if (boundary === 'close') inbox.close(); else f.stop()
  release(); await pending
  expect(f.calls()).toBe(1); expect(inbox.snapshot().messages).toEqual([]); expect(f.releases()).toBe(1)
})

it('deduplicates independently rewrapped copies by the verified unsigned message id', async () => {
  const f = fixture(), inbox = f.make(), one = f.envelope('Same rumor'), two = f.envelope('Same rumor')
  try {
    await inbox.open(); f.receive(one); f.receive(two)
    await inbox.openMessage(one.id); await inbox.openMessage(two.id)
    expect(one.id).not.toBe(two.id); expect(inbox.snapshot().messages).toHaveLength(1)
  } finally { inbox.close() }
})

it('does not turn application invitations into literal ordinary chat or permit unrelated recipients', async () => {
  const f = fixture(), inbox = f.make()
  const invite = f.envelope('An application invitation', [['p', f.self], ['kithmoot-invitation', '1', 'a'.repeat(64)]])
  const elsewhere = f.envelope('Not addressed here', [['p', getPublicKey(generateSecretKey())]])
  try {
    await inbox.open()
    for (const event of [invite, elsewhere]) { f.receive(event); await inbox.openMessage(event.id) }
    expect(inbox.snapshot().messages.every(row => row.status === 'refused' && !row.message)).toBe(true)
  } finally { inbox.close() }
})

it('stops malformed input and UI work at the limit, including late event and end callbacks', async () => {
  const f = fixture(), inbox = f.make(), invalid = { ...f.envelope(), sig: '0'.repeat(128) }
  try {
    await inbox.open(); for (let i = 0; i < 513; i++) f.receive(invalid)
    expect(inbox.snapshot().limited).toBe(true); expect(inbox.snapshot().messages).toEqual([]); expect(f.calls()).toBe(0)
    const notifications = f.changes()
    for (let i = 0; i < 1_000; i++) { f.receive(invalid); f.end() }
    expect(f.changes()).toBe(notifications); expect(f.stopped()).toBe(2)
  } finally { inbox.close() }
})

it('unsubscribes even when a synchronous relay callback reaches the input limit before subscribe returns', async () => {
  const f = fixture(), inbox = f.make(), invalid = { ...f.envelope(), sig: '0'.repeat(128) }
  f.eager(receive => { for (let i = 0; i < 600; i++) receive(invalid) })
  try {
    await inbox.open()
    expect(inbox.snapshot().limited).toBe(true); expect(f.stopped()).toBe(2)
    const notifications = f.changes(); f.receive(f.envelope()); f.end()
    expect(f.changes()).toBe(notifications); expect(inbox.snapshot().messages).toEqual([])
  } finally { inbox.close() }
})

it('does not treat a generic end callback as relay completeness and stops silent reads at its deadline', async () => {
  vi.useFakeTimers()
  const f = fixture(), inbox = f.make(), event = f.envelope()
  try {
    await inbox.open(); f.receive(event)
    expect(inbox.snapshot().status).toContain('does not confirm that all inbox relays answered')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(inbox.snapshot().status).toContain('Inbox completeness and authenticated-relay access are not confirmed')
    expect(inbox.snapshot().messages).toEqual([{ copy: event.id, status: 'sealed' }])
    expect(f.stopped()).toBe(2)
    const notifications = f.changes(); f.end(); f.receive(f.envelope('Too late'))
    expect(f.changes()).toBe(notifications)
    await inbox.openMessage(event.id); expect(f.calls()).toBe(2)
  } finally { inbox.close() }
})

it('releases its acquired history hold when rendering saved copies fails, without relabelling it as storage damage', async () => {
  const f = fixture(), inbox = f.make()
  f.change(() => { if (inbox.snapshot().ready) throw Error('Synthetic render failure') })
  await expect(inbox.open()).resolves.toBeUndefined()
  expect(f.releases()).toBe(1); expect(f.failures()).toBe(1); expect(f.stopped()).toBe(0)
  expect(inbox.snapshot()).toMatchObject({ ready: false, status: '', messages: [] })
  inbox.close(); expect(f.releases()).toBe(1)
})

it('erases opened plaintext and closes the read and writer hold when its view notification fails', async () => {
  const f = fixture(), inbox = f.make(), event = f.envelope('Discard on render failure')
  await inbox.open(); f.receive(event)
  f.change(() => { if (inbox.snapshot().messages.some(row => row.message)) throw Error('Synthetic opened-row render failure') })
  await expect(inbox.openMessage(event.id)).resolves.toBeUndefined()
  expect(f.calls()).toBe(2); expect(f.stopped()).toBe(2); expect(f.releases()).toBe(1); expect(f.failures()).toBe(1)
  expect(inbox.snapshot()).toMatchObject({ ready: false, status: '', messages: [] })
  const notifications = f.changes(); f.receive(event); f.end()
  expect(f.changes()).toBe(notifications)
})

it('removes expired opened text on its own timer without keeping a busy expiration loop alive', async () => {
  vi.useFakeTimers()
  const f = fixture(), inbox = f.make(), event = f.envelope('Short-lived', [['p', f.self], ['expiration', String(f.now + 5)]])
  f.change(() => { inbox.snapshot() })
  try {
    await inbox.open(); f.receive(event); await inbox.openMessage(event.id)
    expect(inbox.snapshot().messages[0]?.message?.text).toBe('Short-lived')
    f.advance(5); await vi.advanceTimersByTimeAsync(5_000)
    expect(inbox.snapshot().messages).toEqual([])
    const notifications = f.changes(); await vi.advanceTimersByTimeAsync(10_000)
    expect(f.changes()).toBe(notifications)
  } finally { inbox.close() }
})

it('refuses unknown, corrupt and other-account cache records without overwriting them', () => {
  const f = fixture(), key = ordinaryHistoryKey(f.self)
  for (const raw of ['not json', JSON.stringify({ v: 2, account: f.self, events: [] }), JSON.stringify({ v: 1, account: f.peer, events: [] })]) {
    f.store.set(key, raw)
    expect(() => new OrdinaryMessageHistory(f.store, f.self, () => f.now)).toThrow()
    expect(f.store.get(key)).toBe(raw)
  }
})

it('refuses a concurrent history head change instead of overwriting it', () => {
  const f = fixture(), history = new OrdinaryMessageHistory(f.store, f.self, () => f.now)
  f.store.set(history.key, 'A concurrent writer must be preserved')
  expect(() => history.append(f.envelope(), () => true)).toThrow('changed in another view')
  expect(f.store.get(history.key)).toBe('A concurrent writer must be preserved')
})

it('retains an exact prepared sender copy only under a current account writer lock and releases it on refusal', async () => {
  const f = fixture(), event = wrapEvent({ kind: 14, created_at: f.now, tags: [['p', f.peer]], content: 'Own copy' }, f.key, f.self)
  let current = true, release = 0, unlock!: (release: () => void) => void
  const acquired = new Promise<() => void>(resolve => { unlock = resolve })
  const task = rememberOrdinaryCopy(f.store, f.self, event, async () => acquired, () => current)
  current = false; unlock(() => { release++ })
  await expect(task).rejects.toThrow('changed'); expect(release).toBe(1)
  expect(f.store.get(ordinaryHistoryKey(f.self))).toBeNull()
})

it('preserves published-inbox relay hints and does not revive an older list after an empty or expired latest statement', () => {
  const f = fixture(), list = (at: number, tags: string[][]) => finalizeEvent({ kind: 10050, created_at: at, tags, content: '' }, f.key)
  const old = list(f.now - 5, [['relay', 'wss://inbox.example']])
  expect(ordinaryInboxRelays([old], f.self, f.now)).toEqual(['wss://inbox.example/'])
  expect(ordinaryInboxRelays([old, list(f.now, [])], f.self, f.now)).toEqual([])
  expect(ordinaryInboxRelays([old, list(f.now, [['relay', 'wss://other.example'], ['expiration', String(f.now)]])], f.self, f.now)).toEqual([])
  const captured = captureOrdinaryCopy(f.envelope(), f.self, f.now)!
  expect(Object.isFrozen(captured)).toBe(true); expect(Object.isFrozen(captured.tags)).toBe(true)
})
