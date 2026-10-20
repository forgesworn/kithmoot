import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { unwrapEvent } from 'nostr-tools/nip17'
import { verifyEventUncached } from '../../src/verify.js'
import { NostrMessage } from './nostr-message.js'
import { RelayConnections } from './relay-settings.js'

/** Real loopback TCP/WebSocket writes and acknowledgements. Only the fixture's
 * HTTP upgrade is held; the app's guarded carrier and socket API are unchanged.
 * This is not the actual browser UI, external-client receipt or wire privacy. */
class Relay {
  readonly http = createServer()
  readonly server = new WebSocketServer({ noServer: true, maxPayload: 131072 })
  readonly sockets = new Set<Duplex>()
  readonly pending: (() => void)[] = []
  readonly frames: unknown[][] = []
  readonly errors: string[] = []
  upgrades = 0
  url = ''
  constructor(private readonly stalled = false) {
    this.http.on('upgrade', (request, socket, head) => {
      this.upgrades++; this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
      socket.on('error', error => this.errors.push(String(error)))
      const accept = () => { if (!socket.destroyed) this.server.handleUpgrade(request, socket, head, peer => this.server.emit('connection', peer, request)) }
      if (this.stalled) this.pending.push(accept); else accept()
    })
    this.server.on('connection', socket => {
      socket.on('error', error => this.errors.push(String(error)))
      socket.send(JSON.stringify(['AUTH', 'synthetic-ordinary-inbox-challenge']))
      socket.on('message', raw => {
        try {
          const frame = JSON.parse(raw.toString()) as unknown[]; this.frames.push(frame)
          if (frame[0] !== 'EVENT' || !verifyEventUncached(frame[1] as Event)) throw Error('Unexpected or invalid fixture write')
          socket.send(JSON.stringify(['OK', (frame[1] as Event).id, true, '']))
        } catch (error) { this.errors.push(String(error)); socket.close(1008) }
      })
    })
  }
  async start() {
    await new Promise<void>((resolve, reject) => { this.http.once('error', reject); this.http.listen(0, '127.0.0.1', resolve) })
    const address = this.http.address(); if (!address || typeof address !== 'object') throw Error('Missing loopback address')
    this.url = `ws://127.0.0.1:${address.port}/events`; return this
  }
  release() { for (const accept of this.pending.splice(0)) accept() }
  events() { return this.frames.filter(frame => frame[0] === 'EVENT').map(frame => frame[1] as Event) }
  async close() {
    for (const socket of this.server.clients) socket.terminate()
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>(resolve => this.server.close(() => resolve()))
    await new Promise<void>(resolve => this.http.close(() => resolve()))
  }
}
const relays: Relay[] = [], close: (() => void)[] = []
beforeEach(() => vi.stubGlobal('WebSocket', WebSocket))
afterEach(async () => {
  for (const stop of close.splice(0)) stop()
  for (const relay of relays.splice(0)) await relay.close()
  vi.unstubAllGlobals()
})
async function relay(stalled = false) { const result = new Relay(stalled); relays.push(result); return result.start() }
const wait = (check: () => void) => vi.waitFor(check, { timeout: 3000, interval: 10 })

for (const boundary of ['current', 'close', 'account', 'block'] as const) {
  it(`ordinary sender ${boundary === 'current' ? 'delivers after' : 'cannot write after ' + boundary + ' during'} a real delayed inbox connection`, async () => {
    const recipientRelay = await relay(true), senderRelay = await relay(), defaultRelay = await relay()
    const senderKey = generateSecretKey(), recipientKey = generateSecretKey(), sender = getPublicKey(senderKey), recipient = getPublicKey(recipientKey)
    const now = Math.floor(Date.now() / 1000), saved = new Map<string, string>()
    const selected = new RelayConnections({ getItem: key => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value) } }, [defaultRelay.url])
    const lists = [[senderKey, senderRelay.url], [recipientKey, recipientRelay.url]] as const
    let current = true, blocked = false
    const message = new NostrMessage({ current: () => current, blocked: () => blocked, changed: () => {},
      identity: { pubkey: sender,
        encrypt: async (peer, text) => nip44.v2.encrypt(text, nip44.v2.utils.getConversationKey(senderKey, peer)),
        signEvent: async template => finalizeEvent(template, senderKey),
      },
      // Signed inbox data is supplied by the unit fixture, not a claimed app
      // lookup. The native publication is the boundary exercised here.
      lookup: async () => lists.map(([key, url]) => finalizeEvent({ kind: 10050, created_at: now, tags: [['relay', url]], content: '' }, key)),
      publish: async (event, urls, allowed) => {
        const owned = selected.pool('nostr-message', urls.map(url => ({ url, read: false, write: true })))
        close.push(() => owned.close())
        try {
          if (!owned.publishGuarded) throw Error('Missing actual guarded carrier')
          await owned.publishGuarded(event, allowed)
        } finally { owned.close() }
      },
    })
    close.unshift(() => message.close())
    try {
      await message.review(recipient, 'Only the reviewed current ordinary draft')
      const sending = message.send()
      await wait(() => expect(recipientRelay.pending).toHaveLength(1))
      expect(recipientRelay.events()).toEqual([]); expect(senderRelay.events()).toEqual([])
      if (boundary === 'close') message.close()
      else if (boundary === 'account') current = false
      else if (boundary === 'block') blocked = true
      // Release immediately after revocation. This tests the composed native
      // carrier's refusal across a real handshake, including its write guard
      // and cancellation poll; it does not isolate which guard wins the race.
      recipientRelay.release(); await sending
      if (boundary === 'current') {
        expect(recipientRelay.events()).toHaveLength(1); expect(senderRelay.events()).toHaveLength(1)
        const incoming = recipientRelay.events()[0]!, copy = senderRelay.events()[0]!
        expect(incoming.kind).toBe(1059); expect(copy.kind).toBe(1059)
        expect(unwrapEvent(incoming, recipientKey)).toEqual(unwrapEvent(copy, senderKey))
        expect(unwrapEvent(incoming, recipientKey).content).toBe('Only the reviewed current ordinary draft')
        expect(message.snapshot().status).toContain('does not confirm')
      } else {
        expect(recipientRelay.events()).toEqual([]); expect(senderRelay.events()).toEqual([])
        expect(message.snapshot().review).toBeUndefined()
      }
      expect(defaultRelay.upgrades).toBe(0)
      expect(recipientRelay.frames.some(frame => frame[0] === 'AUTH')).toBe(false)
      expect(senderRelay.frames.some(frame => frame[0] === 'AUTH')).toBe(false)
      expect(recipientRelay.errors).toEqual([]); expect(senderRelay.errors).toEqual([]); expect(defaultRelay.errors).toEqual([])
    } finally { message.close(); recipientRelay.release(); senderKey.fill(0); recipientKey.fill(0) }
  })
}
