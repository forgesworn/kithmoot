import { finalizeEvent, generateSecretKey, type Event } from 'nostr-tools/pure'
import { describe, expect, it, vi } from 'vitest'
import { NostrPublicDeletionRelayWriter } from './public-deletion-relay-writer.js'

class Socket {
  onopen: (() => void) | undefined
  onclose: (() => void) | undefined
  onerror: (() => void) | undefined
  onmessage: ((event: { data: unknown }) => void) | undefined
  sent: string[] = []
  send(value: string): void { this.sent.push(value) }
  close(): void { /* The test decides whether the relay closed unexpectedly. */ }
  open(): void { this.onopen?.() }
  frame(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }) }
}

function deletion(): Event {
  return finalizeEvent({ kind: 5, created_at: 1, tags: [['e', 'a'.repeat(64)], ['k', '1']], content: 'remove this public note' }, generateSecretKey())
}

describe('NostrPublicDeletionRelayWriter', () => {
  it('records each relay acknowledgement without treating it as erasure proof', async () => {
    const event = deletion(), one = new Socket(), two = new Socket()
    const sockets = new Map([['wss://one.test/', one], ['wss://two.test/', two]])
    const writer = new NostrPublicDeletionRelayWriter(url => sockets.get(url)! as unknown as WebSocket)
    const pending = writer.publish(['wss://one.test', 'wss://two.test'], event)
    one.open(); two.open()
    expect(JSON.parse(one.sent[0]!)).toEqual(['EVENT', expect.objectContaining({ id: event.id, kind: 5, tags: event.tags, content: event.content })])
    expect(JSON.parse(two.sent[0]!)).toEqual(['EVENT', expect.objectContaining({ id: event.id, kind: 5, tags: event.tags, content: event.content })])
    one.frame(['OK', event.id, true, 'saved'])
    two.frame(['OK', event.id, false, 'blocked: author policy'])
    await expect(pending).resolves.toEqual([
      { relay: 'wss://one.test/', status: 'accepted', detail: 'saved' },
      { relay: 'wss://two.test/', status: 'refused', detail: 'blocked: author policy' },
    ])
  })

  it('keeps close, connection error and no acknowledgement distinct from acceptance', async () => {
    vi.useFakeTimers()
    const event = deletion(), closed = new Socket(), errored = new Socket(), silent = new Socket()
    const sockets = [closed, errored, silent]
    const writer = new NostrPublicDeletionRelayWriter(() => sockets.shift()! as unknown as WebSocket, 100)
    const pending = writer.publish(['wss://closed.test', 'wss://error.test', 'wss://silent.test'], event)
    closed.onclose?.(); errored.onerror?.()
    await vi.advanceTimersByTimeAsync(100)
    await expect(pending).resolves.toEqual([
      { relay: 'wss://closed.test/', status: 'unknown', detail: 'relay connection closed before an OK acknowledgement' },
      { relay: 'wss://error.test/', status: 'unknown', detail: 'relay connection failed before an OK acknowledgement' },
      { relay: 'wss://silent.test/', status: 'timed-out', detail: 'no OK acknowledgement before deadline' },
    ])
    vi.useRealTimers()
  })

  it('will not put an unsigned or non-deletion event on the wire', async () => {
    const socket = new Socket(), writer = new NostrPublicDeletionRelayWriter(() => socket as unknown as WebSocket)
    const signed = deletion()
    await expect(writer.publish(['wss://relay.test'], { ...signed, content: 'altered' })).rejects.toThrow(/verified signed kind-5/)
    const note = finalizeEvent({ kind: 1, created_at: 1, tags: [], content: 'not a deletion' }, generateSecretKey())
    await expect(writer.publish(['wss://relay.test'], note)).rejects.toThrow(/verified signed kind-5/)
    expect(socket.sent).toEqual([])
  })
})
