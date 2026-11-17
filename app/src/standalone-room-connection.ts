import type { BrowserLink, PairedBox } from './browser-link.js'
import type { LinkListener, LinkSocket } from './browser-link-types.js'
import { canonicalRoomServer } from './browser-room-consent.js'
import { normaliseRelayConfig } from '../../src/relay-pool.js'

const STORAGE_NAME = 'kithmoot.standalone-wok.v1'
const ROUTE_ID = 'standalone-wok'

export class StandaloneRoomConnection {
  #box?: PairedBox
  constructor(private storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, private Base: typeof WebSocket = WebSocket) {
    const saved = storage?.getItem(STORAGE_NAME)
    if (saved) try { this.configure(saved) } catch { this.clear() }
  }
  configure(value: string): PairedBox {
    const eventUrl = normaliseRelayConfig([value])[0]!.url
    if (!eventUrl.startsWith('wss://') || !canonicalRoomServer(eventUrl)) throw new Error('Use a canonical wss:// relay URL ending in /events.')
    this.#box = Object.freeze({ routeId: ROUTE_ID, eventUrl })
    this.storage?.setItem(STORAGE_NAME, eventUrl)
    return this.#box
  }
  clear(): void { this.#box = undefined; this.storage?.removeItem(STORAGE_NAME) }
  boxes(): PairedBox[] { return this.#box ? [this.#box] : [] }
  pairedBoxes(account: string): Promise<PairedBox[]> {
    if (!/^[0-9a-f]{64}$/.test(account)) return Promise.reject(new Error('Choose a signing account first.'))
    return Promise.resolve(this.boxes())
  }
  resume(account: string): Promise<PairedBox[]> { return this.pairedBoxes(account) }
  handles(url: string, routeId: string): boolean { return this.#box?.eventUrl === url && this.#box.routeId === routeId }
  openSocket(url: string, routeId: string, listener: LinkListener): Promise<LinkSocket> {
    if (!this.handles(url, routeId)) return Promise.reject(new Error('Unpaired standalone Wok event address.'))
    const socket = new this.Base(url)
    let open = false, closed = false
    const path = () => ({ status: closed ? 'closed' : open ? 'relay' : 'opening', relay: url, direct: null, cause: 'standalone Wok WSS' })
    const result: LinkSocket = {
      sendText: text => {
        if (!open || closed || socket.readyState !== 1) throw new Error('Standalone Wok is disconnected.')
        socket.send(text)
      },
      disconnect: () => {
        if (closed) return
        socket.close()
        if (!closed) { closed = true; open = false; listener.onClosed?.('Standalone Wok connection closed.') }
      },
      path,
    }
    socket.onopen = () => { if (!closed) { open = true; listener.onOpen?.() } }
    socket.onmessage = event => { if (!closed && open && typeof event.data === 'string') listener.onText?.(event.data) }
    socket.onerror = () => {}
    socket.onclose = event => { if (!closed) { closed = true; open = false; listener.onClosed?.(event.reason || 'Standalone Wok connection closed.') } }
    return Promise.resolve(result)
  }
}

export class BrowserRoomConnections {
  constructor(private bothy: BrowserLink, private standalone: StandaloneRoomConnection) {}
  async pairedBoxes(account: string): Promise<PairedBox[]> {
    return [...await this.bothy.pairedBoxes(account), ...await this.standalone.pairedBoxes(account)]
  }
  boxes(): PairedBox[] { return [...this.bothy.boxes(), ...this.standalone.boxes()] }
  resume(account: string, relays?: string[]): Promise<PairedBox[]> { return this.bothy.resume(account, relays) }
  openSocket(url: string, routeId: string, listener: LinkListener): Promise<LinkSocket> {
    return this.standalone.handles(url, routeId)
      ? this.standalone.openSocket(url, routeId, listener)
      : this.bothy.openSocket(url, routeId, listener)
  }
}
