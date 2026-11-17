import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { finalizeEvent } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils.js'
import { canonicalRoomServer, planRoomGrants, validateConsent } from './browser-room-consent.js'
import { StandaloneRoomConnection } from './standalone-room-connection.js'
import type { LinkListener } from './browser-link-types.js'

const vector = JSON.parse(readFileSync(new URL('../../vectors/room-admission.json', import.meta.url), 'utf8'))
const box = { routeId: 'standalone-wok', eventUrl: vector.server }
afterEach(() => vi.restoreAllMocks())

describe('standalone Wok room grants', () => {
  it('matches the Vennel WSS grant and consent exactly', async () => {
    const identity = { pubkey: vector.keeper, signEvent: async (event: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(event, hexToBytes('01'.repeat(32))) }
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(bytes => { new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).set(hexToBytes(vector.grantId)); return bytes })
    const planned = await planRoomGrants(identity, box, vector.room, [{ persona: vector.guest, device: vector.device }], vector.now)
    expect(planned.grants).toHaveLength(1)
    expect(planned.grants[0].active.tags).toEqual(vector.events.active.tags)
    expect(planned.grants[0].active.id).toBe(vector.events.active.id)
    expect(planned.expires).toBe(vector.now + 30 * 86400)
    expect(() => validateConsent({ account: vector.keeper, room: vector.room, box, device: vector.device,
      scopes: [vector.room], aliases: [], expires: planned.expires, phase: 'installing', grants: planned.grants })).not.toThrow()
  })
  it('accepts only canonical Link or WSS event addresses', () => {
    expect(canonicalRoomServer(vector.server)).toBe(true)
    expect(canonicalRoomServer(`ws://${'a'.repeat(52)}/events`)).toBe(true)
    for (const url of ['https://relay.example.org/events', 'wss://RELAY.example.org/events', 'wss://relay.example.org/other', 'wss://relay.example.org/events?x=1']) {
      expect(canonicalRoomServer(url)).toBe(false)
    }
  })
})

describe('standalone Wok connection', () => {
  function storage() {
    const values = new Map<string, string>()
    return { values, getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  }
  class Socket {
    static instances: Socket[] = []
    readyState = 0
    sent: string[] = []
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: ((event: { reason: string }) => void) | null = null
    constructor(readonly url: string) { Socket.instances.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.() }) }
    send(text: string) { this.sent.push(text) }
    close() { this.readyState = 3; this.onclose?.({ reason: 'fixture closed' }) }
  }
  it('persists only the public route and delegates its exact socket', async () => {
    const store = storage(), connection = new StandaloneRoomConnection(store, Socket as unknown as typeof WebSocket)
    connection.configure(vector.server)
    expect((await connection.pairedBoxes(vector.keeper))).toEqual([box])
    expect(new StandaloneRoomConnection(store).boxes()).toEqual([box])
    const opened = vi.fn(), closed = vi.fn()
    const listener: LinkListener = { onOpen: opened, onClosed: closed }
    const socket = await connection.openSocket(vector.server, box.routeId, listener)
    await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce())
    socket.sendText('bounded fixture')
    expect(Socket.instances).toHaveLength(1)
    expect(Socket.instances[0].sent).toEqual(['bounded fixture'])
    socket.disconnect()
    expect(closed).toHaveBeenCalledWith('fixture closed')
    await expect(connection.openSocket('wss://other.example.org/events', box.routeId, listener)).rejects.toThrow('Unpaired')
    connection.clear()
    expect(connection.boxes()).toEqual([])
  })
  it('repairs an invalid saved endpoint instead of opening it', () => {
    const store = storage()
    store.setItem('kithmoot.standalone-wok.v1', 'https://relay.example.org/events')
    expect(new StandaloneRoomConnection(store).boxes()).toEqual([])
    expect(store.values.size).toBe(0)
  })
})
