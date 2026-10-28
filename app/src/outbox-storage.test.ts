import { describe, expect, it } from 'vitest'
import type { Event } from 'nostr-tools/pure'
import { memoryDeviceStore } from './device-store.js'
import { PendingSends, StorageStuckError, type PendingSend } from './pending-sends.js'
import { Outbox, pendingStatusWords } from './outbox.js'
import { GROUP_STORAGE_MESSAGES, GROUP_STORAGE_WAITING } from '../../src/group-storage.js'

const ROOM = 'a'.repeat(64)
const event = (id: string) => ({ id, kind: 1, pubkey: 'p', created_at: 1, tags: [], content: id, sig: 's' }) as Event
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve() }
const base = (over: Partial<PendingSend>): PendingSend => ({
  id: 'one', roomId: ROOM, channel: 'Chat', text: 'hello', files: [], event: event('one'), state: 'waiting', durable: false, attempts: 0, ...over,
})
const words = (over: Partial<PendingSend>): string => pendingStatusWords(base(over), 'Sending…', 1_000_000)

describe('what a row says', () => {
  it('a message with files for the group’s storage that has tried says it is waiting for the storage', () => {
    expect(words({ storage: true, attempts: 1 })).toBe(GROUP_STORAGE_WAITING)
    // Before it has tried, it is waiting to be connected like any other.
    expect(words({ storage: true, attempts: 0 })).toBe('Pending: will send when you are connected.')
    expect(words({ attempts: 2 })).toBe('Pending: will send when a relay answers.')
  })

  it('a problem waiting will not mend is said in its own words, not as waiting', () => {
    for (const reason of ['clock', 'locked-out', 'node-open'] as const) {
      expect(words({ storage: true, attempts: 1, stuck: GROUP_STORAGE_MESSAGES[reason] }), reason).toBe(GROUP_STORAGE_MESSAGES[reason])
    }
  })

  it('a storage message that failed at a relay says what a relay message says', () => {
    expect(words({ storage: true, attempts: 1, state: 'unknown' })).toBe('Not confirmed: no relay answered in time. Trying again shortly.')
    expect(words({ storage: true, attempts: 1, state: 'refused' })).toBe('Not sent: the relays turned it down. Trying again shortly.')
  })

  it('a moved message with files says its files must be added again; one without does not', () => {
    expect(words({ state: 'moved', files: ['harbour.png'] })).toBe('Not sent: this conversation changed its key before it went. Copy its text into the conversation to send it, and add its files again.')
    expect(words({ state: 'moved' })).toBe('Not sent: this conversation changed its key before it went. Copy it into the conversation to send it.')
    expect(words({ state: 'moved', channel: 'Plans', files: ['x'] })).toContain('in Plans')
  })

  it('an acknowledged message says sending until its tick has evidence; held and sending keep their words', () => {
    expect(words({ acknowledged: true })).toBe('Sending…')
    expect(words({ held: true })).toMatch(/^Message held/)
    expect(words({ state: 'sending' })).toBe('Sending…')
    expect(words({ state: 'holding', holdUntil: 1_003_000 })).toBe('Sending in 3 s')
  })
})

describe('what a waiting message holds a person to', () => {
  function rig() {
    const pending = new PendingSends({ store: memoryDeviceStore(), connected: () => true, schedule: () => {} })
    const outbox = new Outbox({} as HTMLElement, pending, () => ROOM)
    return { pending, outbox }
  }

  it('a message waiting for the group’s storage does not block leaving the room, but leaving asks', async () => {
    const { pending, outbox } = rig()
    await pending.add({ id: 'one', roomId: ROOM, channel: 'Chat', text: 'photos', files: ['a.jpg'], event: event('one'), publish: () => Promise.reject(new Error(GROUP_STORAGE_WAITING)), durable: false, storage: true })
    await flush()
    expect(outbox.pending).toBe(true)
    expect(outbox.blocking).toBe(false)
    expect(outbox.waitingOnStorage).toBe(true)
  })

  it('a stuck one does not block either', async () => {
    const { pending, outbox } = rig()
    await pending.add({ id: 'one', roomId: ROOM, channel: 'Chat', text: 'photos', files: ['a.jpg'], event: event('one'), publish: () => Promise.reject(new StorageStuckError('words')), durable: false, storage: true })
    await flush()
    expect(outbox.blocking).toBe(false)
    expect(outbox.waitingOnStorage).toBe(true)
  })

  it('an ordinary unsent message still blocks, and asks nothing about storage', async () => {
    const { pending, outbox } = rig()
    await pending.add({ id: 'two', roomId: ROOM, channel: 'Chat', text: 'hello', files: [], event: event('two'), publish: () => Promise.reject(new Error('no relay could be reached in time (wss://a)')), durable: false })
    await flush()
    expect(outbox.blocking).toBe(true)
    expect(outbox.waitingOnStorage).toBe(false)
  })

  it('a message that went is neither', async () => {
    const { pending, outbox } = rig()
    await pending.add({ id: 'one', roomId: ROOM, channel: 'Chat', text: 'photos', files: ['a.jpg'], event: event('one'), publish: async () => {}, durable: false, storage: true })
    await flush()
    expect(outbox.pending).toBe(false)
    expect(outbox.blocking).toBe(false)
    expect(outbox.waitingOnStorage).toBe(false)
  })

  it('only this room’s waiting message counts for leaving this room', async () => {
    const pending = new PendingSends({ store: memoryDeviceStore(), connected: () => true, schedule: () => {}, active: () => undefined })
    const outbox = new Outbox({} as HTMLElement, pending, () => 'b'.repeat(64))
    await pending.add({ id: 'one', roomId: ROOM, channel: 'Chat', text: 'photos', files: ['a.jpg'], event: event('one'), publish: () => Promise.reject(new Error(GROUP_STORAGE_WAITING)), durable: false, storage: true })
    await flush()
    expect(outbox.waitingOnStorage).toBe(false)
  })
})
