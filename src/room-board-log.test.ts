import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { bytesToHex, randomBytes } from '@noble/hashes/utils'
import { RoomAgent } from './agent.js'
import { localIdentity } from './identity.js'
import { createDeviceCredential } from './credential.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { decodeChatEvent, deriveChannel, encodeChatEvent } from './chat.js'
import { deriveRoom } from './room.js'
import { KINDS } from './kinds.js'
import { RoomBoardLog, ROOM_BOARD_REMOTE } from './room-board-log.js'
import {
  BoardAssembler, MAX_BOARD_PART_BYTES, ROOM_BOARD_CHANNEL, memoryRoomBoardStorage, roomBoardGenesis, roomBoardRecordId, splitBoardBlob, validBoardPart,
  type BoardPart, type RoomBoardStorage,
} from './room-board-wire.js'

const BASE = 'https://example.test/j/'
const FAST = { flushMs: 5, flushMaxMs: 25, settleMs: [5, 15] as const, retryMs: 20, persistMs: 1 }
const blobId = () => bytesToHex(randomBytes(16))

interface Store extends RoomBoardStorage { readonly records: Map<string, string>; fail: boolean }
function store(records = new Map<string, string>()): Store {
  const memory = memoryRoomBoardStorage(records)
  let fail = false
  return { records, get fail() { return fail }, set fail(value: boolean) { fail = value },
    list: () => memory.list(),
    add: async record => { if (fail) throw new Error('Disk full'); return memory.add(record) },
    remove: ids => memory.remove(ids) }
}

/** A relay connection whose stored-chat sends can be made to fail, as a
 *  device with no network does. */
function link(relay: SimRelay) {
  const state = { down: false }
  const transport = () => {
    const t = new SimTransport(relay)
    const publish = t.publish.bind(t)
    t.publish = async event => {
      if (event.kind === KINDS.CHAT && state.down) throw new Error('No relay accepted the event')
      await publish(event)
    }
    return t
  }
  return { state, transport }
}

function addCard(log: RoomBoardLog, title: string, id: string = blobId()): string {
  log.doc.transact(() => {
    const card = new Y.Map<unknown>()
    card.set('title', title)
    card.set('status', 'todo')
    log.doc.getMap('records').set(id, card)
  })
  return id
}
const titles = (log: RoomBoardLog): string[] =>
  [...log.doc.getMap('records').values()].map(card => (card as Y.Map<unknown>).get('title') as string).sort()
const columns = (log: RoomBoardLog): string[] => [...log.doc.getMap('columns').keys()].sort()
const settled = (...logs: RoomBoardLog[]) => vi.waitFor(() => {
  for (const log of logs) expect(log.status()).toEqual({ ready: true, pending: false })
}, { timeout: 4_000 })

/** Somebody holding the room key and a credential of their own for it, without a session. */
async function member(roomId: string) {
  const identity = localIdentity(generateSecretKey()), deviceSk = generateSecretKey()
  const credential = await createDeviceCredential({ identity, devicePubkey: getPublicKey(deviceSk), roomId, expiresAt: Math.floor(Date.now() / 1000) + 3600 })
  return { identity, deviceSk, credential }
}

/** Every event on the room's board stream that the relay holds, in epoch 0. */
function boardEvents(relay: SimRelay, keeper: RoomAgent): Event[] {
  const { roomId, roomKey } = deriveRoom(keeper.keeperState!.secret)
  const { id } = deriveChannel(roomId, roomKey, ROOM_BOARD_CHANNEL)
  return relay.published.filter(event => event.kind === KINDS.CHAT && event.tags.some(tag => tag[0] === 'd' && tag[1] === id))
}

const agents: RoomAgent[] = []
const logs: RoomBoardLog[] = []
afterEach(async () => {
  for (const log of logs.splice(0)) await log.close()
  for (const agent of agents.splice(0)) agent.leave()
  vi.restoreAllMocks()
})

async function room(relay = new SimRelay({ replay: true })) {
  const keeperLink = link(relay)
  const keeper = await RoomAgent.create({ base: BASE, name: 'Keeper', agent: false, relays: ['wss://sim'], transport: keeperLink.transport, announceJitterMs: 0 })
  agents.push(keeper)
  const join = async (name: string, identity = localIdentity(generateSecretKey())) => {
    const connection = link(relay)
    const agent = await RoomAgent.join({ link: keeper.url, name, identity, agent: false, transport: connection.transport, announceJitterMs: 0 })
    agents.push(agent)
    return { agent, connection }
  }
  const board = async (agent: RoomAgent, storage: Store = store()) => {
    const log = await agent.session.board(storage, { timing: FAST })
    logs.push(log)
    return log
  }
  return { relay, keeper, keeperLink, join, board }
}

describe('the board part a chat envelope carries', () => {
  const part = (): BoardPart => splitBoardBlob('update', new Uint8Array([1, 2, 3]), blobId())[0]!

  it('accepts only its one honest shape', () => {
    expect(validBoardPart(part())).toBe(true)
    expect(validBoardPart({ ...part(), extra: 1 })).toBe(false)
    expect(validBoardPart({ ...part(), v: 2 })).toBe(false)
    expect(validBoardPart({ ...part(), kind: 'replace' })).toBe(false)
    expect(validBoardPart({ ...part(), blob: 'ABC' })).toBe(false)
    expect(validBoardPart({ ...part(), index: 1 })).toBe(false)
    expect(validBoardPart({ ...part(), count: 97 })).toBe(false)
    expect(validBoardPart({ ...part(), data: '' })).toBe(false)
    expect(validBoardPart({ ...part(), data: 'not base64!' })).toBe(false)
    expect(validBoardPart({ ...part(), data: 'A'.repeat(30_044) })).toBe(false)
    expect(validBoardPart({ ...part(), data: 'A'.repeat(30_040) })).toBe(true)
    expect(validBoardPart(null)).toBe(false)
  })

  it('cuts a large blob into parts that join again in any order', () => {
    const bytes = randomBytes(MAX_BOARD_PART_BYTES * 2 + 17)
    const parts = splitBoardBlob('snapshot', bytes, blobId())
    expect(parts).toHaveLength(3)
    expect(parts.every(validBoardPart)).toBe(true)
    const assembler = new BoardAssembler()
    expect(assembler.add('device', parts[2]!)).toBeUndefined()
    expect(assembler.add('device', parts[0]!)).toBeUndefined()
    expect(assembler.add('device', parts[0]!)).toBeUndefined()
    const blob = assembler.add('device', parts[1]!)
    expect(blob?.kind).toBe('snapshot')
    expect(bytesToHex(blob!.bytes)).toBe(bytesToHex(bytes))
  })

  it('never joins parts from two devices, and drops a blob whose parts disagree', () => {
    const [first, second] = splitBoardBlob('update', randomBytes(MAX_BOARD_PART_BYTES + 1), blobId())
    const assembler = new BoardAssembler()
    expect(assembler.add('one', first!)).toBeUndefined()
    expect(assembler.add('two', second!)).toBeUndefined()
    expect(assembler.add('one', { ...second!, kind: 'snapshot' })).toBeUndefined()
    // The disagreement dropped what `one` had gathered, so its true second part starts again.
    expect(assembler.add('one', second!)).toBeUndefined()
  })

  it('rides only in the board channel, alone', async () => {
    const f = await room()
    const secret = f.keeper.keeperState!.secret
    const { roomId, roomKey } = deriveRoom(secret)
    const deviceSk = generateSecretKey()
    const base = { id: blobId(), participant: f.keeper.participant, device: getPublicKey(deviceSk),
      credential: f.keeper.session.credential!, text: 'Board update', sentAt: Math.floor(Date.now() / 1000) }
    expect(() => encodeChatEvent({ ...base, board: part() }, { roomId, roomKey, deviceSk })).toThrow('Invalid board envelope')
    expect(() => encodeChatEvent({ ...base, board: { ...part(), v: 2 } as unknown as BoardPart }, { roomId, roomKey, deviceSk, channel: ROOM_BOARD_CHANNEL })).toThrow('Invalid board envelope')
  })
})

describe('the room’s own board', () => {
  it('starts as the same three columns for everybody, with nothing to create, share or join', async () => {
    const f = await room()
    const ada = await f.join('Ada')
    const [a, b] = await Promise.all([f.board(f.keeper), f.board(ada.agent)])
    await settled(a, b)
    expect(columns(a)).toEqual(['doing', 'done', 'todo'])
    expect(columns(b)).toEqual(['doing', 'done', 'todo'])
    expect(bytesToHex(a.state())).toBe(bytesToHex(roomBoardGenesis()))
    // An untouched board owes the room nothing.
    expect(boardEvents(f.relay, f.keeper)).toHaveLength(0)
  })

  it('carries each member’s cards to the other, and keeps both when they write at once', async () => {
    const f = await room()
    const ada = await f.join('Ada')
    const a = await f.board(f.keeper), b = await f.board(ada.agent)
    const seen: unknown[] = []
    b.onUpdate((_update, source) => seen.push(source))
    addCard(a, 'Book the hall')
    await vi.waitFor(() => expect(titles(b)).toEqual(['Book the hall']))
    expect(seen).toContain(ROOM_BOARD_REMOTE)
    addCard(a, 'Order the tea')
    addCard(b, 'Print the notices')
    await vi.waitFor(() => {
      expect(titles(a)).toEqual(['Book the hall', 'Order the tea', 'Print the notices'])
      expect(titles(b)).toEqual(['Book the hall', 'Order the tea', 'Print the notices'])
    })
    await settled(a, b)
    expect(bytesToHex(a.state())).toBe(bytesToHex(b.state()))
  })

  it('shows a late arrival the board when everybody who wrote it has gone', async () => {
    const f = await room()
    const ada = await f.join('Ada')
    const a = await f.board(ada.agent)
    addCard(a, 'Left for whoever comes next')
    await settled(a)
    await a.close()
    ada.agent.leave()
    const bob = await f.join('Bob')
    const b = await f.board(bob.agent)
    await vi.waitFor(() => expect(titles(b)).toEqual(['Left for whoever comes next']))
    await settled(b)
    // Bob read it from the room; he had nothing to send.
    expect(boardEvents(f.relay, f.keeper)).toHaveLength(1)
  })

  it('keeps an edit made with no network, says so, and sends it when the network is back', async () => {
    const f = await room()
    const ada = await f.join('Ada')
    const a = await f.board(f.keeper), b = await f.board(ada.agent)
    await settled(a, b)
    f.keeperLink.state.down = true
    addCard(a, 'Written on the train')
    await vi.waitFor(() => expect(a.status()).toEqual({ ready: true, pending: true, error: 'No relay accepted the event' }))
    expect(titles(b)).toEqual([])
    f.keeperLink.state.down = false
    await vi.waitFor(() => expect(titles(b)).toEqual(['Written on the train']))
    await settled(a, b)
  })

  it('sends after a restart what was written offline and never sent', async () => {
    const f = await room()
    const ada = await f.join('Ada')
    const kept = store()
    const a = await f.board(f.keeper, kept), b = await f.board(ada.agent)
    await settled(a, b)
    f.keeperLink.state.down = true
    addCard(a, 'Unsent before the lid closed')
    await vi.waitFor(() => expect(a.status().error).toBeDefined())
    await a.close()
    logs.splice(logs.indexOf(a), 1)
    expect(titles(b)).toEqual([])
    f.keeperLink.state.down = false
    // The same device, opening the board again from its own copy.
    const { roomId, roomKey } = deriveRoom(f.keeper.keeperState!.secret)
    const again = new RoomBoardLog({ roomId, roomKey, transport: f.keeperLink.transport(), deviceSk: generateSecretKey(),
      credential: () => undefined, storage: kept, timing: FAST })
    logs.push(again)
    await again.open()
    expect(titles(again)).toEqual(['Unsent before the lid closed'])
    // With no credential it can read and keep the board but not send.
    await vi.waitFor(() => expect(again.status().error).toMatch(/access to the room ran out/))
    await again.close()
    const reopened = await f.board(f.keeper, kept)
    await vi.waitFor(() => expect(titles(b)).toEqual(['Unsent before the lid closed']))
    await settled(reopened, b)
  })

  it('puts the board back when the room’s relay has forgotten it', async () => {
    const first = new SimRelay({ replay: true })
    const f = await room(first)
    const kept = store()
    const a = await f.board(f.keeper, kept)
    addCard(a, 'Survives the relay')
    await settled(a)
    await a.close()
    // Another relay that has never heard of this room: only the device holds the board.
    const second = new SimRelay({ replay: true })
    const { roomId, roomKey } = deriveRoom(f.keeper.keeperState!.secret)
    const { deviceSk, credential } = await member(roomId)
    const holder = new RoomBoardLog({ roomId, roomKey, transport: new SimTransport(second), deviceSk,
      credential: () => credential, storage: kept, timing: FAST })
    logs.push(holder)
    await holder.open()
    await settled(holder)
    const reader = new RoomBoardLog({ roomId, roomKey, transport: new SimTransport(second), deviceSk: generateSecretKey(),
      credential: () => undefined, storage: store(), timing: FAST })
    logs.push(reader)
    await reader.open()
    await vi.waitFor(() => expect(titles(reader)).toEqual(['Survives the relay']))
    expect(reader.status()).toEqual({ ready: true, pending: false })
  })

  it('follows the room to a new epoch: the removed member stops, and a newcomer still gets the whole board', async () => {
    const f = await room()
    const ada = await f.join('Ada'), bob = await f.join('Bob')
    const k = await f.board(f.keeper), a = await f.board(ada.agent), b = await f.board(bob.agent)
    addCard(b, 'Bob wrote this before he was removed')
    await vi.waitFor(() => expect(titles(a)).toEqual(['Bob wrote this before he was removed']))
    await settled(k, a, b)
    // The keeper's own board is shut, so only Ada is left to hand the board on.
    await k.close()
    logs.splice(logs.indexOf(k), 1)
    await f.keeper.remove(bob.agent.participant)
    await vi.waitFor(() => expect(ada.agent.session.epoch).toBe(1))
    addCard(a, 'Written after the removal')
    await settled(a)
    expect(titles(b)).toEqual(['Bob wrote this before he was removed'])
    // Carol arrives knowing only the new epoch, and Bob is not there to ask.
    const carolIdentity = localIdentity(generateSecretKey())
    f.keeper.session.letIn(carolIdentity.pubkey)
    const carol = await f.join('Carol', carolIdentity)
    expect(carol.agent.session.epoch).toBe(1)
    const c = await f.board(carol.agent)
    await vi.waitFor(() => expect(titles(c)).toEqual(['Bob wrote this before he was removed', 'Written after the removal']))
    await settled(c)
    expect(titles(b)).toEqual(['Bob wrote this before he was removed'])
  }, 20_000)

  it('carries a board too large for one envelope in parts', async () => {
    const f = await room()
    const ada = await f.join('Ada')
    const a = await f.board(f.keeper)
    const long = Array.from({ length: 6 }, (_, i) => `${i}:${bytesToHex(randomBytes(8_000))}`)
    a.doc.transact(() => { for (const text of long) { const card = new Y.Map<unknown>(); card.set('title', text); a.doc.getMap('records').set(blobId(), card) } })
    await settled(a)
    const sent = boardEvents(f.relay, f.keeper)
    expect(sent.length).toBeGreaterThan(2)
    // A full part, with everything its envelope carries, stays where NIP-44
    // pads to 32,768 bytes and no further: an event of about 45 KB, inside
    // the 64 KB that common relays stop at.
    const sizes = sent.map(event => JSON.stringify(event).length)
    expect(Math.max(...sizes)).toBeGreaterThan(40_000)
    expect(Math.max(...sizes)).toBeLessThan(46_000)
    const b = await f.board(ada.agent)
    await vi.waitFor(() => expect(titles(b)).toEqual([...long].sort()))
  })

  it('ignores a malformed change from a member and a well-formed one from a stranger', async () => {
    const f = await room()
    const ada = await f.join('Ada')
    const a = await f.board(f.keeper), b = await f.board(ada.agent)
    await settled(a, b)
    const { roomId, roomKey } = deriveRoom(f.keeper.keeperState!.secret)
    const now = Math.floor(Date.now() / 1000)
    const forgedDoc = new Y.Doc()
    forgedDoc.getMap('records').set('forged', 'by a stranger')
    const forged = splitBoardBlob('update', Y.encodeStateAsUpdate(forgedDoc), blobId())[0]!
    // A stranger holding the room key, signing with a device the keeper's credential does not name.
    const strangerSk = generateSecretKey()
    f.relay.publish(encodeChatEvent({ id: blobId(), participant: f.keeper.participant, device: getPublicKey(strangerSk),
      credential: f.keeper.session.credential!, text: 'Board update', sentAt: now, board: forged },
      { roomId, roomKey, deviceSk: strangerSk, channel: ROOM_BOARD_CHANNEL }))
    // The same change with a credential for another room.
    const elsewhere = await member(bytesToHex(randomBytes(32)))
    f.relay.publish(encodeChatEvent({ id: blobId(), participant: elsewhere.identity.pubkey, device: getPublicKey(elsewhere.deviceSk),
      credential: elsewhere.credential, text: 'Board update', sentAt: now, board: forged },
      { roomId, roomKey, deviceSk: elsewhere.deviceSk, channel: ROOM_BOARD_CHANNEL }))
    // A real member whose bytes are no document update at all, in one part and in two.
    const mallory = await member(roomId)
    const garbage = [...splitBoardBlob('update', randomBytes(64), blobId()), ...splitBoardBlob('snapshot', randomBytes(MAX_BOARD_PART_BYTES + 9), blobId())]
    for (const part of garbage) {
      const event = encodeChatEvent({ id: blobId(), participant: mallory.identity.pubkey, device: getPublicKey(mallory.deviceSk),
        credential: mallory.credential, text: 'Board update', sentAt: now, board: part },
        { roomId, roomKey, deviceSk: mallory.deviceSk, channel: ROOM_BOARD_CHANNEL })
      expect(decodeChatEvent(event, { roomId, roomKey, channel: ROOM_BOARD_CHANNEL, now })?.board).toBeDefined()
      f.relay.publish(event)
    }
    addCard(a, 'Still works')
    await vi.waitFor(() => expect(titles(b)).toEqual(['Still works']))
    await settled(a, b)
    expect(a.doc.getMap('records').has('forged')).toBe(false)
    expect(b.doc.getMap('records').has('forged')).toBe(false)
    expect(columns(b)).toEqual(['doing', 'done', 'todo'])
  })

  it('opens over a copy it cannot wholly read, says so, and never removes what it could not read', async () => {
    const f = await room()
    const kept = store()
    const a = await f.board(f.keeper, kept)
    addCard(a, 'In the room and on this device')
    await settled(a)
    await a.close()
    logs.splice(logs.indexOf(a), 1)
    // Damage: a record sealed under another room's key, and one that is no record at all.
    const elsewhere = memoryRoomBoardStorage()
    const foreign = new RoomBoardLog({ roomId: bytesToHex(randomBytes(32)), roomKey: randomBytes(32), transport: new SimTransport(new SimRelay({ replay: true })),
      deviceSk: generateSecretKey(), credential: () => undefined, storage: elsewhere, timing: FAST })
    await foreign.open()
    addCard(foreign, 'Sealed under another key')
    await foreign.close()
    const [foreignId, foreignRecord] = [...elsewhere.records][0]!
    expect(roomBoardRecordId(foreignRecord)).toBe(foreignId)
    kept.records.set(foreignId, foreignRecord)
    kept.records.set('f'.repeat(64), 'not a record')

    const again = await f.board(f.keeper, kept)
    expect(titles(again)).toEqual(['In the room and on this device'])
    expect(again.status().error).toMatch(/Part of the copy of this board kept on this device could not be read/)
    // Enough further changes that it writes the whole board afresh and tidies its own records away.
    for (let i = 0; i < 40; i++) { addCard(again, `Card ${i}`); await new Promise(resolve => setTimeout(resolve, 4)) }
    await again.close()
    logs.splice(logs.indexOf(again), 1)
    expect(kept.records.size).toBeLessThan(40)
    // The two it could not read are exactly where and what they were.
    expect(kept.records.get(foreignId)).toBe(foreignRecord)
    expect(kept.records.get('f'.repeat(64))).toBe('not a record')
  })

  it('lets two tabs of one device keep one copy without either undoing the other', async () => {
    const f = await room()
    const kept = store()
    const { roomId, roomKey } = deriveRoom(f.keeper.keeperState!.secret)
    const tab = async (offline: boolean) => {
      const who = await member(roomId)
      const connection = link(f.relay)
      connection.state.down = offline
      const log = new RoomBoardLog({ roomId, roomKey, transport: connection.transport(), deviceSk: who.deviceSk,
        credential: () => who.credential, storage: kept, timing: FAST })
      logs.push(log)
      await log.open()
      return log
    }
    // The second tab has no network. What it writes is never sent, and once
    // it is shut that work exists nowhere but in the copy both tabs share.
    const first = await tab(false), second = await tab(true)
    const expected: string[] = []
    for (let i = 0; i < 5; i++) { addCard(second, `second ${i}`); expected.push(`second ${i}`) }
    await second.close()
    logs.splice(logs.indexOf(second), 1)
    expect(titles(first)).toEqual([])
    const unsent = new Map(kept.records)
    expect(unsent.size).toBeGreaterThan(0)
    // The first tab, which never read those records, now writes enough to
    // write the whole board afresh and tidy up after itself, more than once.
    for (let i = 0; i < 80; i++) {
      addCard(first, `first ${i}`); expected.push(`first ${i}`)
      await new Promise(resolve => setTimeout(resolve, 4))
    }
    await first.close()
    logs.splice(0)
    expect(kept.records.size).toBeLessThan(40 + unsent.size)
    // It tidied only what was its own: the second tab's records are untouched.
    for (const [id, record] of unsent) expect(kept.records.get(id)).toBe(record)
    // A later open, with a relay that knows nothing, finds every card of both.
    const later = new RoomBoardLog({ roomId, roomKey, transport: new SimTransport(new SimRelay({ replay: true })), deviceSk: generateSecretKey(),
      credential: () => undefined, storage: kept, timing: FAST })
    logs.push(later)
    await later.open()
    expect(titles(later)).toEqual([...expected].sort())
    expect(later.status().error).toBeUndefined()
  })

  it('stays open and in step with the room when this device cannot save', async () => {
    const f = await room()
    const ada = await f.join('Ada')
    const kept = store()
    const a = await f.board(f.keeper, kept), b = await f.board(ada.agent)
    await settled(a, b)
    kept.fail = true
    addCard(a, 'Not saved here yet')
    await vi.waitFor(() => expect(titles(b)).toEqual(['Not saved here yet']))
    await vi.waitFor(() => expect(a.status().error).toMatch(/could not be saved on this device/))
    kept.fail = false
    await vi.waitFor(() => expect(a.status()).toEqual({ ready: true, pending: false }))
    await a.close()
    logs.splice(logs.indexOf(a), 1)
    // A fresh log over the same copy, on a relay that knows nothing, holds the card.
    const { roomId, roomKey } = deriveRoom(f.keeper.keeperState!.secret)
    const fresh = new RoomBoardLog({ roomId, roomKey, transport: new SimTransport(new SimRelay({ replay: true })), deviceSk: generateSecretKey(),
      credential: () => undefined, storage: kept, timing: FAST })
    logs.push(fresh)
    await fresh.open()
    expect(titles(fresh)).toEqual(['Not saved here yet'])
  })

  it('has its board events deleted with everything else an agent signed', async () => {
    const f = await room()
    const ada = await f.join('Ada')
    const a = await f.board(ada.agent)
    addCard(a, 'Asked to be deleted')
    await settled(a)
    const written = boardEvents(f.relay, f.keeper)
    expect(written).toHaveLength(1)
    await ada.agent.deleteOwnEvents({ timeoutMs: 2_000 })
    const asked = new Set(f.relay.published.filter(event => event.kind === 5 && event.pubkey === written[0]!.pubkey)
      .flatMap(event => event.tags.filter(tag => tag[0] === 'e').map(tag => tag[1])))
    expect(asked.has(written[0]!.id)).toBe(true)
    expect(a.closed).toBe(true)
  })

  it('tells a member that the board is in use, once, without opening it, in whichever epoch', async () => {
    const f = await room()
    const ada = await f.join('Ada'), bob = await f.join('Bob')
    let adaTold = 0
    const stop = ada.agent.session.watchBoard(() => { adaTold++ })
    await new Promise(resolve => setTimeout(resolve, 30))
    // An untouched board is not in use.
    expect(adaTold).toBe(0)
    const k = await f.board(f.keeper)
    addCard(k, 'First card')
    await vi.waitFor(() => expect(adaTold).toBe(1))
    addCard(k, 'Second card')
    await settled(k)
    expect(adaTold).toBe(1)
    stop()
    // Somebody who starts watching later is told from what the relay holds.
    let bobTold = 0
    bob.agent.session.watchBoard(() => { bobTold++ })
    await vi.waitFor(() => expect(bobTold).toBe(1))
    // After a rekey the watch moves with the room: a member who was not yet
    // told hears of the first write to the new epoch's stream.
    const g = await room()
    const cy = await g.join('Cy'), dee = await g.join('Dee')
    let cyTold = 0
    cy.agent.session.watchBoard(() => { cyTold++ })
    await g.keeper.remove(dee.agent.participant)
    await vi.waitFor(() => expect(cy.agent.session.epoch).toBe(1))
    expect(cyTold).toBe(0)
    const later = await g.board(g.keeper)
    addCard(later, 'Written after the rekey')
    await vi.waitFor(() => expect(cyTold).toBe(1))
  }, 15_000)

  it('reads the board stream as the envelope it is: a member’s, in this room and this channel', async () => {
    const f = await room()
    const a = await f.board(f.keeper)
    addCard(a, 'One card')
    await settled(a)
    const { roomId, roomKey } = deriveRoom(f.keeper.keeperState!.secret)
    const events = boardEvents(f.relay, f.keeper)
    expect(events).toHaveLength(1)
    const now = Math.floor(Date.now() / 1000)
    const message = decodeChatEvent(events[0]!, { roomId, roomKey, channel: ROOM_BOARD_CHANNEL, now })
    expect(message?.participant).toBe(f.keeper.participant)
    expect(message?.board?.kind).toBe('snapshot')
    // Not readable as conversation, and not at all without the room key.
    expect(decodeChatEvent(events[0]!, { roomId, roomKey, now })).toBeNull()
    expect(decodeChatEvent(events[0]!, { roomId, roomKey: randomBytes(32), channel: ROOM_BOARD_CHANNEL, now })).toBeNull()
    expect(events[0]!.content).not.toContain('One card')
  })
})
