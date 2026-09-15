import { finalizeEvent, generateSecretKey, type Event } from 'nostr-tools/pure'
import { describe, expect, it, vi } from 'vitest'
import { NostrHistoryRelayReader } from './history-relay-reader.js'

class Socket {
  readyState = 0
  onopen: (() => void) | undefined
  onclose: (() => void) | undefined
  onerror: (() => void) | undefined
  onmessage: ((event: { data: unknown }) => void) | undefined
  sent: string[] = []
  send(value: string): void { this.sent.push(value) }
  close(): void { this.readyState = 3 }
  open(): void { this.readyState = 1; this.onopen?.() }
  frame(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }) }
}

const event = (): Event => finalizeEvent({ kind: 4, created_at: 1, tags: [], content: 'ciphertext' }, generateSecretKey())

describe('NostrHistoryRelayReader', () => {
  it('only completes on its own EOSE and never sends a publication', async () => {
    const socket = new Socket()
    const reader = new NostrHistoryRelayReader(() => socket as unknown as WebSocket)
    const pending = reader.read('wss://relay.test', { kinds: [4], since: 0, until: 2, limit: 5 })
    socket.open()
    const request = JSON.parse(socket.sent[0]!)
    expect(request[0]).toBe('REQ')
    socket.frame(['EOSE', 'someone-else'])
    socket.frame(['EVENT', request[1], event()])
    socket.frame(['EOSE', request[1]])
    await expect(pending).resolves.toMatchObject({ terminal: 'complete', events: [expect.objectContaining({ kind: 4 })] })
    expect(socket.sent).toHaveLength(1)
  })

  it('makes CLOSED, unavailable and timeout separate receipts', async () => {
    vi.useFakeTimers()
    const closed = new Socket()
    const reader = new NostrHistoryRelayReader(() => closed as unknown as WebSocket, 100)
    const closedRead = reader.read('wss://relay.test', { kinds: [4], since: 0, until: 2, limit: 5 })
    closed.open(); const id = JSON.parse(closed.sent[0]!)[1]
    closed.frame(['CLOSED', id, 'restricted'])
    await expect(closedRead).resolves.toMatchObject({ terminal: 'closed', detail: 'restricted' })
    const unavailable = new Socket()
    const unavailableRead = new NostrHistoryRelayReader(() => unavailable as unknown as WebSocket, 100).read('wss://relay.test', { kinds: [4], since: 0, until: 2, limit: 5 })
    unavailable.onerror?.()
    await expect(unavailableRead).resolves.toMatchObject({ terminal: 'unavailable' })
    const timeout = new Socket()
    const timeoutRead = new NostrHistoryRelayReader(() => timeout as unknown as WebSocket, 100).read('wss://relay.test', { kinds: [4], since: 0, until: 2, limit: 5 })
    await vi.advanceTimersByTimeAsync(100)
    await expect(timeoutRead).resolves.toMatchObject({ terminal: 'timeout' })
    vi.useRealTimers()
  })

  it('keeps only the requested event cap while still waiting for EOSE', async () => {
    const socket = new Socket()
    const reader = new NostrHistoryRelayReader(() => socket as unknown as WebSocket)
    const pending = reader.read('wss://relay.test', { kinds: [4], since: 0, until: 2, limit: 1 })
    socket.open(); const id = JSON.parse(socket.sent[0]!)[1]
    const first = event(), extra = event()
    socket.frame(['EVENT', id, first])
    socket.frame(['EVENT', id, extra])
    socket.frame(['EOSE', id])
    await expect(pending).resolves.toMatchObject({ terminal: 'complete', events: [expect.objectContaining({ id: first.id })] })
  })
})
