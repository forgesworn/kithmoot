import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey, verifiedSymbol, type Event } from 'nostr-tools/pure'
import { matchFilters, type Filter } from 'nostr-tools/filter'
import { localIdentity, type ParticipantIdentity, type UnsignedEvent } from './identity.js'
import { NostrRelayPool } from './relay-pool.js'
import { verifyEventUncached } from './verify.js'

const sockets = WebSocket as unknown as typeof globalThis.WebSocket
const pools: NostrRelayPool[] = []
const servers: Relay[] = []
class Relay {
  readonly server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  url = ''
  readonly frames: unknown[][] = []
  readonly challenges: string[] = []
  readonly events: Event[] = []
  readonly subscriptions = new Map<WebSocket, Map<string, Filter[]>>()
  challenge?: unknown
  constructor(readonly keeper: string, readonly required = true) {
    this.server.on('connection', socket => {
      const challenge = this.challenge ?? getPublicKey(generateSecretKey())
      this.challenges.push(String(challenge))
      let authenticated = false
      socket.send(JSON.stringify(['AUTH', challenge]))
      const subscriptions = new Map<string, Filter[]>()
      this.subscriptions.set(socket, subscriptions)
      socket.on('close', () => this.subscriptions.delete(socket))
      socket.on('message', raw => {
        const frame = JSON.parse(raw.toString()) as unknown[]
        this.frames.push(frame)
        if (frame[0] === 'AUTH') {
          const auth = frame[1] as Event
          authenticated = auth.kind === 22242 && auth.pubkey === this.keeper && verifyEventUncached(auth) &&
            JSON.stringify(auth.tags) === JSON.stringify([['relay', this.url], ['challenge', challenge]])
          socket.send(JSON.stringify(['OK', auth.id, authenticated, authenticated ? '' : 'restricted: keeper required']))
        } else if (frame[0] === 'EVENT') {
          const event = frame[1] as Event
          if (this.required && !authenticated) { socket.send(JSON.stringify(['OK', event.id, false, 'auth-required: keeper required'])); return }
          if (!verifyEventUncached(event)) throw new Error('invalid test publish')
          this.seed(event)
          socket.send(JSON.stringify(['OK', event.id, true, '']))
        } else if (frame[0] === 'REQ') {
          if (this.required && !authenticated) { socket.send(JSON.stringify(['CLOSED', frame[1], 'auth-required: keeper required'])); return }
          const filters = frame.slice(2) as Filter[]
          subscriptions.set(frame[1] as string, filters)
          for (const event of this.events) if (matchFilters(filters, event)) socket.send(JSON.stringify(['EVENT', frame[1], event]))
          socket.send(JSON.stringify(['EOSE', frame[1]]))
        } else if (frame[0] === 'CLOSE') subscriptions.delete(frame[1] as string)
      })
    })
  }
  async start(): Promise<this> {
    await new Promise<void>(resolve => this.server.once('listening', resolve))
    const address = this.server.address()
    if (typeof address !== 'object' || !address) throw new Error('missing listener')
    this.url = `ws://127.0.0.1:${address.port}/events`
    servers.push(this)
    return this
  }
  seed(event: Event): void {
    this.events.push(event)
    for (const [socket, subscriptions] of this.subscriptions) for (const [id, filters] of subscriptions) {
      if (socket.readyState === WebSocket.OPEN && matchFilters(filters, event)) socket.send(JSON.stringify(['EVENT', id, event]))
    }
  }
  async stop(): Promise<void> {
    for (const socket of this.server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()))
  }
}
const note = () => finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'local synthetic event' }, generateSecretKey())
const wait = (check: () => void) => vi.waitFor(check, { timeout: 3000, interval: 10 })
function pool(relay: Relay, identity?: ParticipantIdentity, timeout = 1000): NostrRelayPool {
  const result = new NostrRelayPool([relay.url], undefined, { websocketImplementation: sockets,
    authenticationTimeoutMs: timeout, authentication: identity ? [{ url: relay.url, identity }] : [] })
  pools.push(result)
  return result
}
afterEach(async () => {
  for (const p of pools.splice(0)) p.close()
  for (const relay of servers.splice(0)) await relay.stop()
  vi.restoreAllMocks()
})

describe('explicit relay authentication over real WebSockets', () => {
  it('waits for a keeper AUTH acknowledgement before subscribing or publishing, without identifying to another relay', async () => {
    const key = generateSecretKey(), identity = localIdentity(key)
    const keeper = await new Relay(identity.pubkey).start()
    const publicRelay = await new Relay(identity.pubkey, false).start()
    let approve!: () => void
    const signed = vi.fn(async (template: UnsignedEvent) => {
      await new Promise<void>(resolve => { approve = resolve })
      return identity.signEvent(template)
    })
    const p = new NostrRelayPool([keeper.url, { url: publicRelay.url, read: true, write: false }], undefined,
      { websocketImplementation: sockets, authentication: [{ url: keeper.url, identity: { ...identity, signEvent: signed } }] })
    pools.push(p)
    const seen = vi.fn(), eose = vi.fn()
    const off = p.subscribe([{ kinds: [1] }], seen, eose)
    const event = note(), published = p.publish(event)
    await wait(() => expect(signed).toHaveBeenCalledTimes(1))
    expect(keeper.frames).toEqual([])
    expect(eose).not.toHaveBeenCalled()
    approve()
    await published
    await wait(() => expect(seen).toHaveBeenCalledTimes(1))
    await wait(() => expect(eose).toHaveBeenCalledTimes(1))
    expect(keeper.frames[0]?.[0]).toBe('AUTH')
    expect(publicRelay.frames.some(frame => frame[0] === 'AUTH')).toBe(false)
    off()
    await wait(() => expect([...keeper.subscriptions.values()].every(subs => subs.size === 0)).toBe(true))
    keeper.seed(note())
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('does not authenticate merely because a relay is marked as a circle box', async () => {
    const relay = await new Relay(getPublicKey(generateSecretKey())).start()
    const p = new NostrRelayPool([{ url: relay.url, read: true, write: true, circle: true }], undefined, { websocketImplementation: sockets })
    pools.push(p)
    await expect(p.publish(note())).rejects.toThrow('auth-required')
    expect(relay.frames.some(frame => frame[0] === 'AUTH')).toBe(false)
  })

  it('latches a signer refusal without repeated prompts and supports an explicit retry', async () => {
    const identity = localIdentity(generateSecretKey())
    const relay = await new Relay(identity.pubkey).start()
    const signEvent = vi.fn(identity.signEvent).mockRejectedValueOnce(new Error('user declined'))
    const p = pool(relay, { ...identity, signEvent })
    const eose = vi.fn(); p.subscribe([{}], () => {}, eose)
    await expect(p.publish(note())).rejects.toThrow()
    expect(p.health()[0]?.lastError).toContain('not approved')
    expect(eose).not.toHaveBeenCalled()
    await expect(p.publish(note())).rejects.toThrow()
    expect(signEvent).toHaveBeenCalledTimes(1)
    p.reconnect()
    await p.publish(note())
    expect(signEvent).toHaveBeenCalledTimes(2)
    expect(relay.frames.filter(frame => frame[0] === 'AUTH')).toHaveLength(1)
  })

  it('closes timed-out signer work and never sends a late signature', async () => {
    const identity = localIdentity(generateSecretKey()), relay = await new Relay(identity.pubkey).start()
    let finish!: (event: Event) => void
    let template!: UnsignedEvent
    const signEvent = vi.fn((event: UnsignedEvent) => { template = event; return new Promise<Event>(resolve => { finish = resolve }) })
    const p = pool(relay, { ...identity, signEvent }, 100)
    await expect(p.publish(note())).rejects.toThrow()
    expect(p.health()[0]?.lastError).toContain('timed out')
    finish(await identity.signEvent(template))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(relay.frames).toEqual([])
    await expect(p.publish(note())).rejects.toThrow()
    expect(signEvent).toHaveBeenCalledTimes(1)
  })

  it('withdraws an in-flight permission without switching to anonymous room traffic', async () => {
    const identity = localIdentity(generateSecretKey()), relay = await new Relay(identity.pubkey).start()
    let finish!: (event: Event) => void, template!: UnsignedEvent
    const signEvent = vi.fn((event: UnsignedEvent) => { template = event; return new Promise<Event>(resolve => { finish = resolve }) })
    const p = pool(relay, { ...identity, signEvent })
    const published = p.publish(note()).catch(() => 'cancelled')
    await wait(() => expect(signEvent).toHaveBeenCalledTimes(1))
    p.setAuthentication([])
    finish(await identity.signEvent(template))
    expect(await published).toBe('cancelled')
    await expect(p.publish(note())).rejects.toThrow()
    expect(relay.frames).toEqual([])
    p.reconnect()
    await expect(p.publish(note())).rejects.toThrow()
    p.setAuthentication([{ url: relay.url, identity }])
    await p.publish(note())
  })

  it('rejects wrong identities, signer-mutated statements and forged cached verdicts', async () => {
    const identity = localIdentity(generateSecretKey()), relay = await new Relay(identity.pubkey).start()
    for (const signEvent of [
      (template: UnsignedEvent) => localIdentity(generateSecretKey()).signEvent(template),
      (template: UnsignedEvent) => { template.content = 'changed'; return identity.signEvent(template) },
      async (template: UnsignedEvent) => ({ ...await identity.signEvent(template), content: 'tampered', [verifiedSymbol]: true as const }),
    ]) {
      const p = pool(relay, { ...identity, signEvent })
      await expect(p.publish(note())).rejects.toThrow()
      expect(relay.frames).toEqual([])
      p.close()
    }
  })

  it('uses a fresh challenge after reconnect and keeps subscription history deduplicated', async () => {
    const identity = localIdentity(generateSecretKey()), relay = await new Relay(identity.pubkey).start()
    const signEvent = vi.fn(identity.signEvent), p = pool(relay, { ...identity, signEvent })
    const first = note(); relay.seed(first)
    const seen = vi.fn(); p.subscribe([{}], seen)
    await wait(() => expect(seen).toHaveBeenCalledTimes(1))
    for (const socket of relay.server.clients) socket.terminate()
    const missed = note(); relay.seed(missed)
    p.reconnect()
    await wait(() => expect(seen).toHaveBeenCalledTimes(2))
    expect(signEvent).toHaveBeenCalledTimes(2)
    expect(relay.challenges[0]).not.toBe(relay.challenges[1])
    expect(seen.mock.calls.map(call => (call[0] as Event).id)).toEqual([first.id, missed.id])
  })

  it('rejects a malformed challenge before prompting the signer', async () => {
    const identity = localIdentity(generateSecretKey()), relay = await new Relay(identity.pubkey).start()
    relay.challenge = 'x'.repeat(1025)
    const signEvent = vi.fn(identity.signEvent), p = pool(relay, { ...identity, signEvent })
    await expect(p.publish(note())).rejects.toThrow()
    expect(signEvent).not.toHaveBeenCalled()
  })
})
