import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { base64 } from '@scure/base'
import type { Event } from 'nostr-tools/pure'
import { decodeChatEvent, deriveChannel } from '../src/chat.js'
import {
  BoardAssembler, MAX_BOARD_PART_BYTES, MAX_BOARD_PARTS, ROOM_BOARD_CACHE_KEY_INFO, ROOM_BOARD_CHANNEL, ROOM_BOARD_GENESIS,
  roomBoardGenesis, splitBoardBlob, type BoardPart,
} from '../src/room-board-wire.js'

interface Decode { roomId: string; roomKey: string; now: number; epoch?: { id: string; key: string }; channel?: null }
const vectors = JSON.parse(readFileSync(new URL('./room-board-v1.json', import.meta.url), 'utf8'))
const decodeOpts = (d: Decode) => ({ roomId: d.roomId, roomKey: hexToBytes(d.roomKey), now: d.now,
  ...(d.channel === null ? {} : { channel: ROOM_BOARD_CHANNEL }),
  ...(d.epoch ? { epoch: { id: d.epoch.id, key: hexToBytes(d.epoch.key) } } : {}) })
const records = (doc: Y.Doc): Record<string, unknown> =>
  Object.fromEntries([...doc.getMap('records')].map(([id, card]) => [id, (card as Y.Map<unknown>).get('title')]))

describe('independently assembled room board vectors', () => {
  it('channel, streams, limits and the local copy key', () => {
    expect(vectors.channel).toBe(ROOM_BOARD_CHANNEL)
    expect(vectors.limits).toEqual({ partBytes: MAX_BOARD_PART_BYTES, maxParts: MAX_BOARD_PARTS })
    const { roomId, roomKey, epoch } = vectors.inputs
    const first = deriveChannel(roomId, hexToBytes(roomKey), ROOM_BOARD_CHANNEL)
    const later = deriveChannel(epoch.id, hexToBytes(epoch.key), ROOM_BOARD_CHANNEL)
    expect(vectors.streams).toEqual([
      { name: 'epoch-0', d: first.id, key: bytesToHex(first.key) },
      { name: 'later-epoch', d: later.id, key: bytesToHex(later.key) },
    ])
    expect(bytesToHex(hkdf(sha256, hexToBytes(roomKey), undefined, new TextEncoder().encode(`${ROOM_BOARD_CACHE_KEY_INFO}:${roomId}`), 32))).toBe(vectors.cacheKey)
  })

  it('the starting state, built by hand from the document format, is the constant every member applies', () => {
    expect(vectors.genesis.base64).toBe(ROOM_BOARD_GENESIS)
    expect(roomBoardGenesis().byteLength).toBe(vectors.genesis.bytes)
    expect(bytesToHex(sha256(roomBoardGenesis()))).toBe(vectors.genesis.sha256)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, roomBoardGenesis())
    expect([...doc.getMap('columns').keys()].sort()).toEqual([...vectors.genesis.columns].sort())
    expect([...doc.getMap('views').keys()]).toEqual(vectors.genesis.views)
  })

  it('two members’ changes merge to the same board in every order, however often they arrive', () => {
    const [a, b] = (vectors.merge.updates as string[]).map(update => base64.decode(update))
    const orders = [[a, b], [b, a], [a, b, a, b], [b, b, a]]
    for (const order of orders) {
      for (const genesisFirst of [true, false]) {
        const doc = new Y.Doc()
        if (genesisFirst) Y.applyUpdate(doc, roomBoardGenesis())
        for (const update of order) Y.applyUpdate(doc, update!)
        if (!genesisFirst) Y.applyUpdate(doc, roomBoardGenesis())
        expect(records(doc)).toEqual(vectors.merge.records)
        expect([...doc.getMap('columns').keys()].sort()).toEqual([...vectors.merge.columns].sort())
        expect(base64.encode(Y.encodeStateVector(doc))).toBe(vectors.merge.stateVector)
        expect(Y.encodeStateAsUpdate(doc).byteLength).toBe(vectors.merge.stateBytes)
      }
    }
  })

  it('cuts a blob into exactly these parts', () => {
    const [one, three] = vectors.blobs
    expect(splitBoardBlob(one.kind, base64.decode(one.base64), one.blob)).toEqual(one.parts)
    const snapshot = (vectors.valid as Array<{ name: string; expected: { board: BoardPart } }>).filter(v => v.name.startsWith('snapshot-part-')).map(v => v.expected.board)
    expect(snapshot.map(part => ({ index: part.index, count: part.count, bytes: base64.decode(part.data).byteLength, sha256: bytesToHex(sha256(base64.decode(part.data))) }))).toEqual(three.partData)
  })

  for (const vector of vectors.valid) {
    it(`accepts ${vector.name}`, () => {
      const message = decodeChatEvent(vector.event as Event, decodeOpts(vector.decode))
      expect(message).not.toBeNull()
      expect({ participant: message!.participant, device: message!.device, sentAt: message!.sentAt, board: message!.board }).toEqual(vector.expected)
      expect(message!.text).toBe('Board update')
    })
  }

  it('joins the three snapshot parts, arriving last first, into the one blob', () => {
    const three = vectors.blobs[1]
    const parts = (vectors.valid as Array<{ name: string; event: Event; decode: Decode }>).filter(v => v.name.startsWith('snapshot-part-'))
    const assembler = new BoardAssembler()
    let blob
    for (const vector of [...parts].reverse()) {
      const message = decodeChatEvent(vector.event, decodeOpts(vector.decode))!
      blob = assembler.add(message.device, message.board!)
    }
    expect(blob?.kind).toBe('snapshot')
    expect(blob!.bytes.byteLength).toBe(three.bytes)
    expect(bytesToHex(sha256(blob!.bytes))).toBe(three.sha256)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, blob!.bytes)
    expect([...doc.getMap('records').keys()]).toEqual(['card-long'])
  })

  for (const vector of vectors.refused) {
    it(`refuses ${vector.name}`, () => {
      expect(decodeChatEvent(vector.event as Event, decodeOpts(vector.decode))).toBeNull()
    })
  }
})
