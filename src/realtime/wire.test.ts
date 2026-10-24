import { describe, expect, it } from 'vitest'
import {
  DATAGRAM_BYTES, FrameOpener, FrameSealer, HEADER_BYTES, inspectDatagram,
  fragmentPacket, MAX_FRAME_BYTES, newPublication, publicationKey,
  type CompressedFrame, type Publication,
} from './wire.js'

const ROOM = new Uint8Array(32).fill(17)
const PUBLICATION: Publication = { id: '12'.repeat(16), sender: 'ab'.repeat(32) }
function frame(size = 100, kind: 'video' | 'audio' = 'video'): CompressedFrame {
  return { kind, type: 'key', timestampUs: 1234567, durationUs: kind === 'audio' ? 20000 : 66667,
    data: Uint8Array.from({ length: size }, (_, i) => (i * 31) % 256) }
}
function feed(opener: FrameOpener, datagrams: Uint8Array[]) {
  let opened: ReturnType<FrameOpener['push']> = null
  for (const datagram of datagrams) opened = opener.push(datagram) ?? opened
  return opened
}

describe('participant-bound realtime encryption', () => {
  it('reassembles reordered fragments into exactly the original compressed media', () => {
    const input = frame(MAX_FRAME_BYTES), sealer = new FrameSealer(PUBLICATION, ROOM)
    const opener = new FrameOpener(PUBLICATION, ROOM, () => 0), sealed = sealer.seal(input)
    const fragments = fragmentPacket(sealed.packet)
    expect(fragments.length).toBeGreaterThan(2)
    expect(fragments.every(bytes => bytes.length <= DATAGRAM_BYTES && inspectDatagram(bytes)?.publication === PUBLICATION.id)).toBe(true)
    // The tail arrives first and one datagram is duplicated during transit.
    expect(opener.push(fragments.at(-1)!)).toBeNull()
    expect(opener.push(fragments.at(-1)!)).toBeNull()
    const output = feed(opener, fragments.slice(0, -1).reverse())
    expect(output).toEqual({ ...input, sequence: sealed.sequence })
    expect(opener.snapshot()).toEqual({ assemblies: 0, bytes: 0 })
    sealer.close(); opener.close()
  })

  it('authenticates routing and timing headers as well as ciphertext', () => {
    const sealer = new FrameSealer(PUBLICATION, ROOM), bytes = fragmentPacket(sealer.seal(frame()).packet)[0]
    for (const offset of [4, 20, 28, 32, 33, 38, 46, bytes.length - 1]) {
      const tampered = bytes.slice(); tampered[offset] ^= 1
      const opener = new FrameOpener(PUBLICATION, ROOM, () => 0)
      expect(opener.push(tampered), `tamper at byte ${offset}`).toBeNull()
      // Authentication failure must not burn the valid sequence or bind a salt.
      expect(opener.push(bytes)?.data).toEqual(frame().data)
      opener.close()
    }
    sealer.close()
  })

  it('refuses another room, sender or publication without sharing their keys', () => {
    const sealer = new FrameSealer(PUBLICATION, ROOM), datagrams = fragmentPacket(sealer.seal(frame(30000)).packet)
    const wrongBindings = [
      new FrameOpener(PUBLICATION, new Uint8Array(32).fill(18), () => 0),
      new FrameOpener({ ...PUBLICATION, sender: 'cd'.repeat(32) }, ROOM, () => 0),
      new FrameOpener({ ...PUBLICATION, id: '34'.repeat(16) }, ROOM, () => 0),
    ]
    for (const opener of wrongBindings) { expect(feed(opener, datagrams)).toBeNull(); opener.close() }
    const correct = new FrameOpener(PUBLICATION, ROOM, () => 0)
    expect(feed(correct, datagrams)?.data).toEqual(frame(30000).data)
    correct.close(); sealer.close()
  })

  it('accepts only the bounded out-of-order replay window and never advances it for a forged header', () => {
    const sealer = new FrameSealer(PUBLICATION, ROOM), opener = new FrameOpener(PUBLICATION, ROOM, () => 0)
    const packets = Array.from({ length: 70 }, () => fragmentPacket(sealer.seal(frame()).packet)[0])
    const forged = packets[0].slice(); new DataView(forged.buffer).setUint32(28, 0xffff_ffff)
    expect(opener.push(forged)).toBeNull()
    expect(opener.push(packets[0])?.sequence).toBe(0)
    expect(opener.push(packets[69])?.sequence).toBe(69)
    expect(opener.push(packets[5])).toBeNull()
    expect(opener.push(packets[6])?.sequence).toBe(6)
    expect(opener.push(packets[68])?.sequence).toBe(68)
    expect(opener.push(packets[68])).toBeNull()
    expect(opener.push(packets[69])).toBeNull()
    sealer.close(); opener.close()
  })

  it('does not mix a second publishing session into an authenticated publication', () => {
    const first = new FrameSealer(PUBLICATION, ROOM), second = new FrameSealer(PUBLICATION, ROOM)
    const opener = new FrameOpener(PUBLICATION, ROOM, () => 0)
    expect(feed(opener, fragmentPacket(first.seal(frame()).packet))).not.toBeNull()
    // A reconnect requires a fresh publication binding. Reusing the same opaque
    // publication ID must not reset replay protection through a new salt.
    expect(feed(opener, fragmentPacket(second.seal(frame()).packet))).toBeNull()
    opener.close(); first.close(); second.close()
  })

  it('derives independent keys and refuses malformed publication bindings', () => {
    const key = publicationKey(ROOM, PUBLICATION)
    expect(publicationKey(ROOM, PUBLICATION)).toEqual(key)
    expect(publicationKey(ROOM, { ...PUBLICATION, id: '56'.repeat(16) })).not.toEqual(key)
    expect(publicationKey(ROOM, { ...PUBLICATION, sender: 'cd'.repeat(32) })).not.toEqual(key)
    expect(publicationKey(new Uint8Array(32).fill(18), PUBLICATION)).not.toEqual(key)
    expect(() => publicationKey(new Uint8Array(31), PUBLICATION)).toThrow()
    expect(() => newPublication('not-a-public-key')).toThrow()
    const publication = newPublication(PUBLICATION.sender)
    expect(publication).toEqual({ id: expect.stringMatching(/^[0-9a-f]{32}$/), sender: PUBLICATION.sender })
  })
})

describe('bounded realtime reassembly', () => {
  it('expires incomplete audio and video without requiring another packet', () => {
    let now = 0
    const opener = new FrameOpener(PUBLICATION, ROOM, () => now), sealer = new FrameSealer(PUBLICATION, ROOM)
    const audio = fragmentPacket(sealer.seal(frame(30000, 'audio')).packet), video = fragmentPacket(sealer.seal(frame(30000)).packet)
    opener.push(audio[0]); opener.push(video[0])
    expect(opener.snapshot().assemblies).toBe(2)
    now = 120; opener.tick()
    expect(opener.snapshot().assemblies).toBe(1)
    now = 500; opener.tick()
    expect(opener.snapshot()).toEqual({ assemblies: 0, bytes: 0 })
    // Expiry discards incomplete work, not the legitimate sender's sequence.
    expect(feed(opener, audio)?.data).toEqual(frame(30000, 'audio').data)
    opener.close(); sealer.close()
  })

  it('caps simultaneous incomplete frames and returns that capacity after expiry', () => {
    let now = 0
    const opener = new FrameOpener(PUBLICATION, ROOM, () => now), sealer = new FrameSealer(PUBLICATION, ROOM)
    const packets = Array.from({ length: 9 }, () => fragmentPacket(sealer.seal(frame(30000)).packet))
    for (const datagrams of packets) expect(opener.push(datagrams[0])).toBeNull()
    expect(opener.snapshot()).toEqual({ assemblies: 8, bytes: 8 * (30000 + 16) })
    now = 500; opener.tick()
    expect(feed(opener, packets[8])?.sequence).toBe(8)
    expect(opener.snapshot()).toEqual({ assemblies: 0, bytes: 0 })
    opener.close(); sealer.close()
  })

  it('reserves a bounded amount for adversarial maximum-sized incomplete frames', () => {
    const opener = new FrameOpener(PUBLICATION, ROOM, () => 0), sealer = new FrameSealer(PUBLICATION, ROOM)
    const first = fragmentPacket(sealer.seal(frame(MAX_FRAME_BYTES)).packet)
    const second = fragmentPacket(sealer.seal(frame(MAX_FRAME_BYTES)).packet)
    opener.push(first[0]); opener.push(second[0])
    expect(opener.snapshot().bytes).toBeLessThanOrEqual(2 * MAX_FRAME_BYTES)
    expect(opener.snapshot().assemblies).toBe(1)
    expect(feed(opener, first.slice(1))?.data.length).toBe(MAX_FRAME_BYTES)
    expect(feed(opener, second)?.data.length).toBe(MAX_FRAME_BYTES)
    opener.close(); sealer.close()
  })

  it('rejects unknown, truncated and inconsistent fragments without reserving memory', () => {
    const opener = new FrameOpener(PUBLICATION, ROOM, () => 0), sealer = new FrameSealer(PUBLICATION, ROOM)
    const valid = fragmentPacket(sealer.seal(frame(30000)).packet)[0]
    const badMagic = valid.slice(); badMagic[0] = 0
    const badCount = valid.slice(); new DataView(badCount.buffer).setUint16(36, 1000)
    const badIndex = valid.slice(); new DataView(badIndex.buffer).setUint16(34, 500)
    const wrongPublication = valid.slice(); wrongPublication[4] ^= 1
    const badTimestamp = valid.slice(); new DataView(badTimestamp.buffer).setFloat64(38, Infinity)
    for (const bad of [new Uint8Array(), new Uint8Array(HEADER_BYTES), new Uint8Array(DATAGRAM_BYTES + 1),
      valid.slice(0, -1), badMagic, badCount, badIndex, wrongPublication, badTimestamp]) {
      expect(opener.push(bad)).toBeNull()
      expect(opener.snapshot()).toEqual({ assemblies: 0, bytes: 0 })
    }
    opener.close(); sealer.close()
  })

  it('does not combine conflicting fragment headers and clears all retained work on close', () => {
    const opener = new FrameOpener(PUBLICATION, ROOM, () => 0), sealer = new FrameSealer(PUBLICATION, ROOM)
    const fragments = fragmentPacket(sealer.seal(frame(30000)).packet)
    expect(opener.push(fragments[0])).toBeNull()
    const conflict = fragments[1].slice(); new DataView(conflict.buffer).setUint32(46, 1)
    expect(opener.push(conflict)).toBeNull()
    expect(feed(opener, fragments.slice(1))?.data).toEqual(frame(30000).data)
    opener.push(fragmentPacket(sealer.seal(frame(30000)).packet)[0])
    expect(opener.snapshot().assemblies).toBe(1)
    opener.close()
    expect(opener.snapshot()).toEqual({ assemblies: 0, bytes: 0 })
    expect(feed(opener, fragments)).toBeNull()
    sealer.close(); expect(() => sealer.seal(frame())).toThrow()
  })
})
