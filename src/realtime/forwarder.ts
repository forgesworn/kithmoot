import { inspectDatagram } from './wire.js'

export interface DatagramSender { send(bytes: Uint8Array, options?: { deadlineMs?: number }): boolean; close(): void }
interface AttachedPeer { link: DatagramSender; publications: Set<string>; subscriptions: Set<string> }
const ID = /^[0-9a-f]{32}$/

/** A transport operator explicitly attaches authenticated links. This object
 * knows opaque routes only, has no room key API and writes no call logs. A
 * subscription is a bandwidth request, never proof of room membership. */
export class RealtimeForwarder {
  #peers = new Map<string, AttachedPeer>()
  #owners = new Map<string, string>()
  #closed = false
  #counters = { receivedDatagrams: 0, receivedBytes: 0, forwardedDatagrams: 0, forwardedBytes: 0, rejected: 0, dropped: 0 }
  constructor(readonly maxPeers = 16, readonly now = () => performance.now()) {
    if (!Number.isSafeInteger(maxPeers) || maxPeers < 2 || maxPeers > 64) throw new Error('Invalid forwarding capacity')
  }
  attach(id: string, link: DatagramSender, publications: readonly string[], subscriptions: readonly string[]): void {
    if (this.#closed || typeof id !== 'string' || id.length > 128 || id.length < 1 || this.#peers.has(id)
      || this.#peers.size >= this.maxPeers || publications.length > 4 || subscriptions.length > this.maxPeers * 4
      || [...publications, ...subscriptions].some(v => !ID.test(v)) || new Set(publications).size !== publications.length
      || publications.some(v => this.#owners.has(v))) throw new Error('Invalid forwarding attachment')
    this.#peers.set(id, { link, publications: new Set(publications), subscriptions: new Set(subscriptions) })
    for (const publication of publications) this.#owners.set(publication, id)
  }
  receive(id: string, bytes: Uint8Array): void {
    const from = this.#peers.get(id), meta = inspectDatagram(bytes)
    if (this.#closed || !from || !meta || !from.publications.has(meta.publication)) { this.#counters.rejected++; return }
    this.#counters.receivedDatagrams++; this.#counters.receivedBytes += bytes.length
    // Local residence deadline only. Sender clocks are neither trusted nor
    // synchronised with this process. No timer, disk queue or retransmission.
    const deadlineMs = this.now() + (meta.kind === 'audio' ? 80 : 200)
    for (const [peerId, peer] of this.#peers) {
      if (peerId === id || !peer.subscriptions.has(meta.publication)) continue
      try {
        if (peer.link.send(bytes, { deadlineMs })) { this.#counters.forwardedDatagrams++; this.#counters.forwardedBytes += bytes.length }
        else this.#counters.dropped++
      } catch { this.#counters.dropped++; this.detach(peerId) }
    }
  }
  detach(id: string): void {
    const peer = this.#peers.get(id)
    if (!peer) return
    this.#peers.delete(id)
    for (const publication of peer.publications) this.#owners.delete(publication)
    try { peer.link.close() } catch { /* One failed transport cannot retain the other peers. */ }
  }
  snapshot() {
    return { peers: this.#peers.size, routes: this.#owners.size, ...this.#counters }
  }
  close(): void { this.#closed = true; for (const id of [...this.#peers.keys()]) this.detach(id) }
}
