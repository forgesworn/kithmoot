import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { useWebSocketImplementation } from 'nostr-tools/pool'
import { matchFilters, type Filter } from 'nostr-tools/filter'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { encrypt, decrypt } from 'nostr-tools/nip04'
import { verifyEventUncached } from '../../src/verify.js'
import { localIdentity } from '../../src/identity.js'
import { LegacyMessageInbox } from './legacy-message-inbox.js'
import { RelayConnections } from './relay-settings.js'

/** Real local sockets and signed NIP-42 challenges. This fixture is a test
 * relay, not evidence about an external relay/operator or a browser route. */
class LocalRelay {
  readonly server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  readonly frames: unknown[][] = []
  readonly events: Event[] = []
  readonly subscriptions = new Map<WebSocket, Map<string, Filter[]>>()
  url = ''
  constructor(private readonly requiredAccount?: string) {
    this.server.on('connection', socket => {
      const challenge = getPublicKey(generateSecretKey())
      let authenticated = false
      const subscriptions = new Map<string, Filter[]>()
      this.subscriptions.set(socket, subscriptions)
      socket.on('close', () => this.subscriptions.delete(socket))
      socket.send(JSON.stringify(['AUTH', challenge]))
      socket.on('message', raw => {
        const frame = JSON.parse(raw.toString()) as unknown[]
        this.frames.push(frame)
        if (frame[0] === 'AUTH') {
          const event = frame[1] as Event
          authenticated = verifyEventUncached(event) && event.kind === 22242 && event.pubkey === this.requiredAccount &&
            JSON.stringify(event.tags) === JSON.stringify([['relay', this.url], ['challenge', challenge]])
          socket.send(JSON.stringify(['OK', event.id, authenticated, authenticated ? '' : 'restricted: account required']))
        } else if (frame[0] === 'REQ') {
          if (this.requiredAccount && !authenticated) { socket.send(JSON.stringify(['CLOSED', frame[1], 'auth-required: account required'])); return }
          const filters = frame.slice(2) as Filter[], id = frame[1] as string
          subscriptions.set(id, filters)
          for (const event of this.events) if (matchFilters(filters, event)) socket.send(JSON.stringify(['EVENT', id, event]))
          socket.send(JSON.stringify(['EOSE', id]))
        } else if (frame[0] === 'CLOSE') subscriptions.delete(frame[1] as string)
        else if (frame[0] === 'EVENT') socket.send(JSON.stringify(['OK', (frame[1] as Event).id, false, 'blocked: receive test']))
      })
    })
  }
  async start(): Promise<this> {
    await new Promise<void>((resolve, reject) => { this.server.once('listening', resolve); this.server.once('error', reject) })
    const address = this.server.address()
    if (!address || typeof address !== 'object') throw Error('Missing test relay address')
    this.url = `ws://127.0.0.1:${address.port}/events`
    return this
  }
  seed(event: Event): void {
    if (!verifyEventUncached(event)) throw Error('Invalid test event')
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
const servers: LocalRelay[] = [], close: (() => void)[] = []
async function relay(account?: string) { const server = new LocalRelay(account); servers.push(server); return server.start() }
beforeEach(() => {
  vi.stubGlobal('WebSocket', WebSocket)
  useWebSocketImplementation(WebSocket as unknown as typeof globalThis.WebSocket)
})
afterEach(async () => {
  for (const stop of close.splice(0)) stop()
  for (const server of servers.splice(0)) await server.stop()
  vi.unstubAllGlobals()
})
const wait = (check: () => void) => vi.waitFor(check, { timeout: 3000, interval: 10 })
function connections(urls: string[]) {
  const saved = new Map<string, string>()
  return new RelayConnections({ getItem: key => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value) } }, urls,
    undefined, { intervalMs: 60_000, visible: () => true })
}

describe('legacy receive through real shared default-relay sockets', () => {
  it('keeps existing AUTH/read permissions and another borrower alive when the legacy view closes', async () => {
    const accountKey = generateSecretKey(), authorKey = generateSecretKey(), identity = localIdentity(accountKey)
    const read = await relay(identity.pubkey), writeOnly = await relay()
    const selected = connections([read.url])
    selected.save('default', [{ url: read.url, read: true, write: false }, { url: writeOnly.url, read: false, write: true }])
    const sign = vi.fn(identity.signEvent)
    selected.authenticate('default', read.url, { pubkey: identity.pubkey, signEvent: sign })
    const other = selected.pool('default'); close.push(() => other.close())
    const heard: string[] = []
    other.subscribe([{ kinds: [1] }], event => heard.push(event.id))
    await wait(() => expect(read.frames.some(frame => frame[0] === 'REQ')).toBe(true))
    const owned = selected.pool('default'); close.push(() => owned.close())
    const inbox = new LegacyMessageInbox({ account: identity.pubkey, current: () => true, blocked: () => false, changed: () => {},
      transport: { subscribe: owned.subscribe.bind(owned), close: owned.close.bind(owned) },
      decrypt: async (peer, ciphertext) => decrypt(accountKey, peer, ciphertext) })
    close.unshift(() => inbox.close()); inbox.open()
    const legacy = finalizeEvent({ kind: 4, created_at: Math.floor(Date.now() / 1000), tags: [['p', identity.pubkey]],
      content: await encrypt(authorKey, identity.pubkey, 'Legacy through approved default relay') }, authorKey)
    read.seed(legacy)
    await wait(() => expect(inbox.snapshot().messages).toHaveLength(1))
    await inbox.openMessage(legacy.id)
    expect(inbox.snapshot().messages[0]).toMatchObject({ author: getPublicKey(authorKey), text: 'Legacy through approved default relay' })
    const legacyIds = read.frames.filter(frame => frame[0] === 'REQ' && (frame[2] as Filter)?.kinds?.includes(4)).map(frame => frame[1])
    expect(legacyIds.length).toBeGreaterThan(0)
    expect(sign).toHaveBeenCalledOnce(); expect(sign.mock.calls[0]![0].kind).toBe(22242)
    expect(read.frames.filter(frame => frame[0] === 'AUTH')).toHaveLength(1)
    expect(writeOnly.frames.some(frame => frame[0] === 'REQ' || frame[0] === 'AUTH')).toBe(false)
    inbox.close()
    await wait(() => expect(legacyIds.every(id => read.frames.some(frame => frame[0] === 'CLOSE' && frame[1] === id))).toBe(true))
    expect(other.closed).toBe(false); expect(owned.closed).toBe(true)
    expect(selected.authenticationIdentity('default', read.url)).toBe(identity.pubkey)
    const note = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'Another borrower still receives' }, authorKey)
    read.seed(note); await wait(() => expect(heard).toEqual([note.id]))
    expect(inbox.snapshot().messages).toEqual([])
    expect(read.server.clients.size).toBe(1)
    expect(read.frames.some(frame => frame[0] === 'EVENT')).toBe(false)
    expect(writeOnly.frames.some(frame => frame[0] === 'EVENT')).toBe(false)
  })

  it('never turns a challenge into a new AUTH grant when none was approved', async () => {
    const accountKey = generateSecretKey(), authorKey = generateSecretKey(), account = getPublicKey(accountKey)
    const publicRead = await relay(), selected = connections([publicRead.url]), owned = selected.pool('default')
    close.push(() => owned.close())
    const inbox = new LegacyMessageInbox({ account, current: () => true, blocked: () => false, changed: () => {},
      transport: { subscribe: owned.subscribe.bind(owned), close: owned.close.bind(owned) } })
    close.unshift(() => inbox.close()); inbox.open()
    const event = finalizeEvent({ kind: 4, created_at: Math.floor(Date.now() / 1000), tags: [['p', account]],
      content: await encrypt(authorKey, account, 'A permissionless read') }, authorKey)
    publicRead.seed(event)
    await wait(() => expect(inbox.snapshot().messages).toHaveLength(1))
    expect(inbox.snapshot().messages[0]!.status).toBe('unavailable')
    expect(publicRead.frames.some(frame => frame[0] === 'AUTH' || frame[0] === 'EVENT')).toBe(false)
    expect(selected.authenticationIdentity('default', publicRead.url)).toBeUndefined()
  })
})
