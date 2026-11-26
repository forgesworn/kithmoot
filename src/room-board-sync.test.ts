import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { build } from 'esbuild'
import { bytesToHex, randomBytes } from '@noble/hashes/utils'
import { RoomBoardSync, type RoomBoardCopy, type RoomBoardEnvelope, type RoomBoardStream, type RoomBoardSyncTiming } from './room-board-sync.js'
import { roomBoardGenesis, roomBoardRecordId, splitBoardBlob, type BoardPart } from './room-board-wire.js'

const FAST = { flushMs: 5, flushMaxMs: 25, settleMs: [5, 15] as const, retryMs: 20, persistMs: 1 }

/**
 * A room's board stream with no key anywhere: events are parts in the clear,
 * each with the device that sent it. What a host does with keys (sealing,
 * signing, opening, checking) is not here, so whatever passes is the core's
 * own doing.
 */
interface Plain extends RoomBoardEnvelope { device: string; part: BoardPart }
function plainStream() {
  const events: Plain[] = []
  const listeners = new Set<(event: Plain) => void>()
  let down: string | undefined
  return {
    events,
    set down(reason: string | undefined) { down = reason },
    publish: async (event: Plain) => {
      if (down) throw new Error(down)
      events.push(event)
      for (const listener of [...listeners]) listener(event)
    },
    subscribe: (stream: RoomBoardStream) => {
      const hand = (event: Plain) => { if (stream.admit(event.id)) stream.receive(event.device, event.part, event.created_at) }
      for (const event of [...events]) hand(event)
      stream.caughtUp()
      listeners.add(hand)
      return () => { listeners.delete(hand) }
    },
  }
}

function memoryCopy(records = new Map<string, Uint8Array>()): RoomBoardCopy & { records: Map<string, Uint8Array>; removed: string[] } {
  const removed: string[] = []
  return {
    records, removed,
    read: async () => ({ records: [...records].map(([id, update]) => ({ id, update })), unread: 0 }),
    add: async update => { const id = roomBoardRecordId(bytesToHex(update)); records.set(id, update); return id },
    remove: async ids => { for (const id of ids) { removed.push(id); records.delete(id) } },
  }
}

const boards: RoomBoardSync<Plain>[] = []
afterEach(async () => { for (const board of boards.splice(0)) await board.close() })

async function device(stream: ReturnType<typeof plainStream>, copy: RoomBoardCopy = memoryCopy(), timing: RoomBoardSyncTiming = FAST) {
  const name = bytesToHex(randomBytes(32))
  let sent = 0
  const board = new RoomBoardSync<Plain>({
    envelope: async part => ({ id: bytesToHex(randomBytes(32)), created_at: Math.floor(Date.now() / 1000) + sent++, device: name, part }),
    publish: event => stream.publish(event),
    copy,
    timing,
  })
  boards.push(board)
  await board.open()
  board.listen(s => stream.subscribe(s))
  return board
}

function addCard(board: RoomBoardSync<Plain>, title: string): void {
  board.doc.transact(() => {
    const card = new Y.Map<unknown>()
    card.set('title', title)
    board.doc.getMap('records').set(bytesToHex(randomBytes(8)), card)
  })
}
const titles = (board: RoomBoardSync<Plain>): string[] =>
  [...board.doc.getMap('records').values()].map(card => (card as Y.Map<unknown>).get('title') as string).sort()
const settled = (...all: RoomBoardSync<Plain>[]) => vi.waitFor(() => {
  for (const board of all) expect(board.status()).toEqual({ ready: true, pending: false })
}, { timeout: 4_000 })

describe('the room board without its keys', () => {
  it('shares a new card and a move on the next timer turn with the default settings', async () => {
    vi.useFakeTimers()
    try {
      const stream = plainStream()
      const writer = await device(stream, memoryCopy(), {})
      const reader = await device(stream, memoryCopy(), {})
      addCard(writer, 'Book the hall')
      expect(titles(reader)).toEqual([])
      await vi.advanceTimersByTimeAsync(0)
      expect(titles(reader)).toEqual(['Book the hall'])

      const records = writer.doc.getMap<Y.Map<string>>('records')
      const [key, card] = [...records][0]!
      card.set('status', 'doing')
      await vi.advanceTimersByTimeAsync(0)
      expect(reader.doc.getMap<Y.Map<string>>('records').get(key)?.get('status')).toBe('doing')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the retry delay when a second edit arrives during a failed send', async () => {
    vi.useFakeTimers()
    try {
      const stream = plainStream()
      let fail!: (error: Error) => void
      const firstSend = new Promise<void>((_, reject) => { fail = reject })
      const publish = vi.spyOn(stream, 'publish').mockReturnValueOnce(firstSend)
      const writer = await device(stream, memoryCopy(), {})
      addCard(writer, 'Book the hall')
      await vi.advanceTimersByTimeAsync(0)
      addCard(writer, 'Print the notices')
      await vi.advanceTimersByTimeAsync(0)
      fail(new Error('No relay accepted the event'))
      await vi.advanceTimersByTimeAsync(4_999)
      expect(publish).toHaveBeenCalledTimes(1)
      expect(writer.status()).toEqual({ ready: true, pending: true, error: 'No relay accepted the event' })
      await vi.advanceTimersByTimeAsync(1)
      expect(publish).toHaveBeenCalledTimes(2)
      expect(writer.status()).toEqual({ ready: true, pending: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps two devices in step through a host that only carries parts, and shows a late arrival what both wrote', async () => {
    const stream = plainStream()
    const a = await device(stream), b = await device(stream)
    addCard(a, 'Book the hall')
    addCard(b, 'Print the notices')
    await vi.waitFor(() => {
      expect(titles(a)).toEqual(['Book the hall', 'Print the notices'])
      expect(titles(b)).toEqual(['Book the hall', 'Print the notices'])
    })
    await settled(a, b)
    await a.close(); await b.close()
    const late = await device(stream)
    await vi.waitFor(() => expect(titles(late)).toEqual(['Book the hall', 'Print the notices']))
    await settled(late)
  })

  it('counts a change as the room’s only once a relay has taken it', async () => {
    const stream = plainStream()
    const a = await device(stream)
    await settled(a)
    stream.down = 'No relay accepted the event'
    addCard(a, 'Written with no network')
    await vi.waitFor(() => expect(a.status()).toEqual({ ready: true, pending: true, error: 'No relay accepted the event' }))
    expect(stream.events).toHaveLength(0)
    stream.down = undefined
    await settled(a)
    const late = await device(stream)
    await vi.waitFor(() => expect(titles(late)).toEqual(['Written with no network']))
  })

  it('keeps a change waiting, in the host’s words, when the host cannot seal it', async () => {
    const stream = plainStream()
    let refuse = true
    const board = new RoomBoardSync<Plain>({
      envelope: async part => {
        if (refuse) throw new Error("This device's access to the room ran out, so the board change was not sent")
        return { id: bytesToHex(randomBytes(32)), created_at: Math.floor(Date.now() / 1000), device: 'a'.repeat(64), part }
      },
      publish: event => stream.publish(event), copy: memoryCopy(), timing: FAST,
    })
    boards.push(board)
    await board.open()
    board.listen(s => stream.subscribe(s))
    addCard(board, 'Waiting for access')
    await vi.waitFor(() => expect(board.status().error).toBe("This device's access to the room ran out, so the board change was not sent"))
    expect(board.status().pending).toBe(true)
    refuse = false
    await settled(board)
    expect(stream.events).toHaveLength(1)
  })

  it('takes nothing from a reading the room has moved on from', async () => {
    const stream = plainStream()
    const writer = await device(stream)
    addCard(writer, 'Said in the old epoch')
    await settled(writer)
    const board = new RoomBoardSync<Plain>({ envelope: async () => { throw new Error('unused') }, publish: async () => {}, copy: memoryCopy(), timing: FAST })
    boards.push(board)
    await board.open()
    let old: RoomBoardStream | undefined, stopped = 0
    board.listen(s => { old = s; return () => { stopped++ } })
    board.listen(() => () => {})
    expect(stopped).toBe(1)
    const event = stream.events[0]!
    expect(old!.admit(event.id)).toBe(false)
    old!.receive(event.device, event.part, event.created_at)
    old!.caughtUp()
    expect(titles(board)).toEqual([])
    expect(board.status().ready).toBe(false)
  })

  it('reads each event once, and stops at the most it will read, saying so', async () => {
    const board = new RoomBoardSync<Plain>({ envelope: async () => { throw new Error('unused') }, publish: async () => {}, copy: memoryCopy(), timing: FAST })
    boards.push(board)
    await board.open()
    let stream: RoomBoardStream | undefined
    board.listen(s => { stream = s; return () => {} })
    expect(stream!.admit('e'.repeat(64))).toBe(true)
    expect(stream!.admit('e'.repeat(64))).toBe(false)
    for (let i = 1; i < 20_000; i++) expect(stream!.admit(i.toString(16).padStart(64, '0'))).toBe(true)
    expect(stream!.admit('f'.repeat(64))).toBe(false)
    expect(board.status().error).toBe('This board has more history than this device will read')
  })

  it('refuses a part out of shape, or with no honest time, from its host', async () => {
    const board = new RoomBoardSync<Plain>({ envelope: async () => { throw new Error('unused') }, publish: async () => {}, copy: memoryCopy(), timing: FAST })
    boards.push(board)
    await board.open()
    let stream: RoomBoardStream | undefined
    board.listen(s => { stream = s; return () => {} })
    const card = new Y.Doc()
    Y.applyUpdate(card, roomBoardGenesis())
    card.getMap('records').set('x', new Y.Map())
    const [part] = splitBoardBlob('update', Y.encodeStateAsUpdate(card), bytesToHex(randomBytes(16)))
    stream!.receive('a'.repeat(64), { ...part!, extra: true } as unknown as BoardPart, 1_700_000_000)
    stream!.receive('a'.repeat(64), part!, 1.5)
    expect(board.doc.getMap('records').size).toBe(0)
    stream!.receive('a'.repeat(64), part!, 1_700_000_000)
    expect(board.doc.getMap('records').size).toBe(1)
  })

  it('opens over a copy it cannot wholly read, says so, and removes only records it read or wrote', async () => {
    const stream = plainStream()
    const first = await device(stream)
    addCard(first, 'Kept on this device')
    await settled(first)
    const kept = first.state()
    await first.close()
    const copy = memoryCopy(new Map([['a'.repeat(64), kept]]))
    const read = copy.read
    copy.read = async () => {
      const { records } = await read()
      return { records: [...records, { id: 'b'.repeat(64), update: 'not bytes' as unknown as Uint8Array }, { id: 'c'.repeat(64), update: new Uint8Array([255, 255]) }], unread: 2 }
    }
    const board = await device(stream, copy)
    expect(titles(board)).toEqual(['Kept on this device'])
    expect(board.status().error).toBe('Part of the copy of this board kept on this device could not be read. It has been left as it is; the rest is open')
    // Enough changes for the copy to be written again as one record.
    for (let i = 0; i < 40; i++) { addCard(board, `Card ${i}`); await new Promise(resolve => setTimeout(resolve, 3)) }
    await vi.waitFor(() => expect(copy.removed).toContain('a'.repeat(64)))
    expect(copy.removed).not.toContain('b'.repeat(64))
    expect(copy.removed).not.toContain('c'.repeat(64))
  })

  it('opens from the room, and says it is not keeping the board, when the copy cannot be read at all', async () => {
    const stream = plainStream()
    const writer = await device(stream)
    addCard(writer, 'From the room')
    await settled(writer)
    const copy = memoryCopy()
    copy.read = async () => { throw new Error('No storage') }
    const board = await device(stream, copy)
    await vi.waitFor(() => expect(titles(board)).toEqual(['From the room']))
    expect(board.status().error).toBe('This board could not be read from this device; it is open here from the room')
  })

  it('holds no code that signs, seals, opens or checks anything', async () => {
    // What a host that keeps its keys elsewhere would load: everything this
    // module brings with it.
    const result = await build({ entryPoints: ['src/room-board-sync.ts'], bundle: true, write: false, metafile: true, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' })
    const inputs = Object.keys(result.metafile.inputs)
    expect(inputs.filter(path => path.startsWith('src/')).sort()).toEqual(['src/room-board-sync.ts', 'src/room-board-wire.ts'])
    expect(inputs.filter(path => /nostr-tools|@noble\/curves|@noble\/ciphers|hkdf|hmac|nip44|secp256k1|schnorr/.test(path))).toEqual([])
    const packages = new Set(inputs.filter(path => path.startsWith('node_modules/')).map(path => path.split('/').slice(1, path.split('/')[1]!.startsWith('@') ? 3 : 2).join('/')))
    expect([...packages].sort()).toEqual(['@noble/hashes', '@scure/base', 'lib0', 'yjs'])
  })
})
