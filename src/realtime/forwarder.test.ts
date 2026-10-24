import { describe, expect, it, vi } from 'vitest'
import { RealtimeForwarder, type DatagramSender } from './forwarder.js'
import { FrameOpener, FrameSealer, fragmentPacket, type Publication } from './wire.js'

const ROOM = new Uint8Array(32).fill(17)
const PUBLICATION: Publication = { id: '12'.repeat(16), sender: 'ab'.repeat(32) }
function sender(accept = true) {
  return { send: vi.fn((_bytes: Uint8Array, _options?: { deadlineMs?: number }) => accept), close: vi.fn() } satisfies DatagramSender
}
function datagram(kind: 'audio' | 'video' = 'video') {
  const sealer = new FrameSealer(PUBLICATION, ROOM)
  const sealed = fragmentPacket(sealer.seal({ kind, type: 'key', timestampUs: 1234567,
    durationUs: 20000, data: new Uint8Array([7, 11, 29, 41]) }).packet)[0]
  sealer.close(); return sealed
}

describe('opaque realtime fanout', () => {
  it('turns one publisher upload into seven subscribed deliveries without a media key', () => {
    const forwarder = new RealtimeForwarder(16, () => 1000), publisher = sender(), listeners = Array.from({ length: 7 }, () => sender())
    forwarder.attach('publisher', publisher, [PUBLICATION.id], [PUBLICATION.id])
    listeners.forEach((link, i) => forwarder.attach(`recipient-${i}`, link, [], [PUBLICATION.id]))
    const bytes = datagram()
    forwarder.receive('publisher', bytes)
    expect(publisher.send).not.toHaveBeenCalled()
    for (const link of listeners) {
      expect(link.send).toHaveBeenCalledOnce()
      expect(link.send).toHaveBeenCalledWith(bytes, { deadlineMs: 1200 })
      // The forwarder does not transform or decrypt publication bytes.
      expect(link.send.mock.calls[0][0]).toEqual(bytes)
    }
    expect(forwarder.snapshot()).toMatchObject({ receivedDatagrams: 1, receivedBytes: bytes.length,
      forwardedDatagrams: 7, forwardedBytes: bytes.length * 7, rejected: 0, dropped: 0 })
    // A recipient can decrypt only with the separately held participant key.
    const opener = new FrameOpener(PUBLICATION, ROOM)
    expect(opener.push(listeners[0].send.mock.calls[0][0])?.data).toEqual(new Uint8Array([7, 11, 29, 41]))
    opener.close(); forwarder.close()
  })

  it('enforces subscriptions and rejects owner spoofing, unknown peers and malformed input', () => {
    const forwarder = new RealtimeForwarder(), publisher = sender(), subscribed = sender(), other = sender(), impostor = sender()
    forwarder.attach('publisher', publisher, [PUBLICATION.id], [])
    forwarder.attach('recipient', subscribed, [], [PUBLICATION.id])
    forwarder.attach('unsubscribed', other, [], [])
    forwarder.attach('impostor', impostor, ['34'.repeat(16)], [PUBLICATION.id])
    const bytes = datagram()
    forwarder.receive('impostor', bytes); forwarder.receive('unknown', bytes); forwarder.receive('publisher', new Uint8Array([1, 2, 3]))
    expect(subscribed.send).not.toHaveBeenCalled(); expect(impostor.send).not.toHaveBeenCalled()
    forwarder.receive('publisher', bytes)
    expect(subscribed.send).toHaveBeenCalledOnce(); expect(impostor.send).toHaveBeenCalledOnce()
    expect(other.send).not.toHaveBeenCalled()
    expect(forwarder.snapshot()).toMatchObject({ rejected: 3, receivedDatagrams: 1 })
    forwarder.close()
  })

  it('allows an explicitly detached publication to rebind and refuses its previous owner', () => {
    const forwarder = new RealtimeForwarder(), first = sender(), replacement = sender(), listener = sender()
    forwarder.attach('first', first, [PUBLICATION.id], [])
    forwarder.attach('listener', listener, [], [PUBLICATION.id])
    expect(() => forwarder.attach('replacement', replacement, [PUBLICATION.id], [])).toThrow()
    forwarder.detach('first')
    expect(first.close).toHaveBeenCalledOnce()
    forwarder.attach('replacement', replacement, [PUBLICATION.id], [])
    const bytes = datagram()
    forwarder.receive('first', bytes)
    expect(listener.send).not.toHaveBeenCalled()
    forwarder.receive('replacement', bytes)
    expect(listener.send).toHaveBeenCalledOnce()
    expect(forwarder.snapshot()).toMatchObject({ peers: 2, routes: 1, rejected: 1 })
    forwarder.close()
  })

  it('drops a slow recipient without holding back healthy recipients and applies audio deadlines', () => {
    const forwarder = new RealtimeForwarder(16, () => 250), slow = sender(false), healthy = sender()
    forwarder.attach('publisher', sender(), [PUBLICATION.id], [])
    forwarder.attach('slow', slow, [], [PUBLICATION.id])
    forwarder.attach('healthy', healthy, [], [PUBLICATION.id])
    const bytes = datagram('audio')
    forwarder.receive('publisher', bytes)
    expect(slow.send).toHaveBeenCalledWith(bytes, { deadlineMs: 330 })
    expect(healthy.send).toHaveBeenCalledWith(bytes, { deadlineMs: 330 })
    expect(forwarder.snapshot()).toMatchObject({ receivedDatagrams: 1, forwardedDatagrams: 1, dropped: 1 })
    forwarder.close()
  })

  it('isolates a recipient transport exception so healthy recipients still receive', () => {
    const forwarder = new RealtimeForwarder(), broken = sender(), healthy = sender()
    broken.send.mockImplementation(() => { throw new Error('transport closed during send') })
    forwarder.attach('publisher', sender(), [PUBLICATION.id], [])
    forwarder.attach('broken', broken, [], [PUBLICATION.id])
    forwarder.attach('healthy', healthy, [], [PUBLICATION.id])
    expect(() => forwarder.receive('publisher', datagram())).not.toThrow()
    expect(healthy.send).toHaveBeenCalledOnce()
    expect(forwarder.snapshot()).toMatchObject({ dropped: 1, forwardedDatagrams: 1 })
    forwarder.close()
  })

  it('cleans all attached transports and routes even if one close operation throws', () => {
    const forwarder = new RealtimeForwarder(), broken = sender(), healthy = sender()
    broken.close.mockImplementation(() => { throw new Error('close failed') })
    forwarder.attach('broken', broken, [PUBLICATION.id], [])
    forwarder.attach('healthy', healthy, ['34'.repeat(16)], [PUBLICATION.id])
    expect(() => forwarder.close()).not.toThrow()
    expect(broken.close).toHaveBeenCalledOnce(); expect(healthy.close).toHaveBeenCalledOnce()
    expect(forwarder.snapshot()).toMatchObject({ peers: 0, routes: 0 })
    expect(() => forwarder.attach('later', sender(), [], [])).toThrow()
    forwarder.close(); expect(healthy.close).toHaveBeenCalledOnce()
  })

  it('bounds attachment and ownership state and closes detached transports exactly once', () => {
    const forwarder = new RealtimeForwarder(2), first = sender(), second = sender()
    expect(() => new RealtimeForwarder(1)).toThrow()
    expect(() => forwarder.attach('', sender(), [], [])).toThrow()
    expect(() => forwarder.attach('bad', sender(), ['wrong'], [])).toThrow()
    expect(() => forwarder.attach('duplicate', sender(), [PUBLICATION.id, PUBLICATION.id], [])).toThrow()
    forwarder.attach('first', first, [PUBLICATION.id], [])
    expect(() => forwarder.attach('first', sender(), [], [])).toThrow()
    forwarder.attach('second', second, [], [])
    expect(() => forwarder.attach('third', sender(), [], [])).toThrow()
    forwarder.detach('first'); forwarder.detach('first')
    expect(first.close).toHaveBeenCalledOnce()
    expect(forwarder.snapshot()).toMatchObject({ peers: 1, routes: 0 })
    forwarder.close(); forwarder.close()
    expect(second.close).toHaveBeenCalledOnce()
  })
})
