import { spryCredentials, spryGrant, spryPeers, newSpryKey, spryDeviceKey, type SpryOffer, type SpryPairing, type SpryCredential } from '../../src/spry.js'
import { parseSpryControl, spryNodeCard } from '../../src/spry-link.js'
import type { RoomSession } from '../../src/session.js'

/** One room owns its credentials and timers, including while its call is docked. */
export class SpryRoom {
  #offer?: SpryOffer
  #own?: SpryOffer
  #shared?: SpryOffer
  #credentialUntil = 0
  #credentials = new Map<string, SpryCredential>()
  #applied = ''
  #key: string
  #closed = false
  #work?: Promise<void>
  #pairRevision = 0
  #peerUpdatePending = false
  #peerRevision = Date.now()
  #timer: ReturnType<typeof setInterval>
  #unsub: Array<() => void> = []
  #roster = ''
  #lastPublication = 0
  #publication?: ReturnType<typeof setTimeout>
  #waiters = new Set<() => void>()
  constructor(private session: RoomSession, private pairing: SpryPairing | undefined,
    private apply: (servers: RTCIceServer[]) => void, private fetcher: typeof fetch = fetch,
    deviceKey?: Uint8Array, saved?: SpryOffer, private retain: (offer: SpryOffer) => void = () => {}) {
    this.#key = deviceKey ? spryDeviceKey(deviceKey) : newSpryKey()
    this.#offer = saved
    this.#unsub.push(session.onDescriptor(descriptor => {
      if (this.#closed || !descriptor.spry) return
      const next = descriptor.spry
      // Private adverts travel to our paired node; they never open foreign sockets.
      if (next.endpoint.startsWith('spry:') && next.endpoint !== this.pairing?.endpoint) return
      this.#shared = next
      if (this.pairing && this.#own) return
      this.#offer = this.#offer?.token === next.token && this.#offer.endpoint === next.endpoint
        ? { ...next, expiresAt: Math.max(next.expiresAt, this.#offer.expiresAt) } : next
      this.retain(this.#offer)
      for (const wake of this.#waiters) wake()
      if (session.call) void this.refresh().catch(() => {})
    }))
    if (session.onPeerDescriptors) this.#unsub.push(session.onPeerDescriptors(() => {
      if (!this.#closed && this.pairing?.endpoint.startsWith('spry:')) {
        if (this.#work) this.#peerUpdatePending = true
        else void this.refresh().catch(() => {})
      }
    }))
    this.#unsub.push(session.onChange(views => {
      const roster = views.flatMap(view => view.devices).sort().join(',')
      if (roster === this.#roster) return
      this.#roster = roster
      if (!this.#offer || this.#publication !== undefined) return
      this.#publication = setTimeout(() => {
        this.#publication = undefined
        void this.publish().catch(() => {})
      }, Math.max(0, 1000 - (Date.now() - this.#lastPublication)))
    }))
    this.#timer = setInterval(() => {
      if (this.#closed) return
      this.#applyCredentials()
      if (this.pairing || session.call) void this.refresh().catch(() => {})
    }, 30000)
    if (pairing) void this.refresh().catch(() => {})
  }
  async publish(): Promise<void> {
    const offer = this.#own ?? this.#offer
    if (!offer || this.#closed || offer.expiresAt <= Date.now() / 1000) return
    this.#lastPublication = Date.now()
    const old = this.session.descriptor
    await this.session.publishDescriptor({ forwarders: old?.forwarders, iceServers: old?.iceServers, spry: offer })
  }
  refresh(): Promise<void> {
    if (this.#work) return this.#work
    this.#work = this.#refresh().finally(() => {
      this.#work = undefined
      if (this.#peerUpdatePending && !this.#closed) { this.#peerUpdatePending = false; void this.refresh().catch(() => {}) }
    })
    return this.#work
  }
  #applyCredentials(): void {
    const now = Date.now() / 1000
    for (const [key, credential] of this.#credentials) if (credential.expiresAt <= now) this.#credentials.delete(key)
    this.#credentialUntil = Math.max(0, ...[...this.#credentials.values()].map(value => value.expiresAt))
    const servers = [...this.#credentials.values()].map(value => ({ urls: value.urls, username: value.username, credential: value.credential }))
    const encoded = JSON.stringify(servers)
    if (encoded !== this.#applied && (servers.length || this.#applied)) { this.#applied = encoded; this.apply(servers) }
  }
  async #registerPeers(): Promise<void> {
    const pair = this.pairing
    if (!pair?.endpoint.startsWith('spry:')) return
    const own = parseSpryControl(pair.endpoint).publicKey
    const peers = new Map<string, NonNullable<SpryOffer['node']>>()
    for (const descriptor of this.session.peerDescriptors()) {
      const node = spryNodeCard(descriptor.spry?.node)
      if (!node || node.pubkey === own) continue
      const old = peers.get(node.pubkey)
      if (!old || node.created_at > old.created_at || node.created_at === old.created_at && node.id > old.id) peers.set(node.pubkey, node)
    }
    await spryPeers(pair, this.session.roomId, this.#key, [...peers.values()].sort((a, b) => a.pubkey.localeCompare(b.pubkey)).slice(0, 8), this.fetcher, ++this.#peerRevision)
  }
  async #refresh(): Promise<void> {
    if (this.#closed) return
    const revision = this.#pairRevision
    const now = Date.now() / 1000
    let failure: unknown
    if (this.pairing && (!this.#own || this.#own.expiresAt - now < 360)) {
      try {
        const own = await spryGrant(this.pairing, this.session.roomId, this.fetcher)
        if (this.#closed || revision !== this.#pairRevision) return
        this.#offer = this.#own = own
        this.retain(own)
        await this.publish().catch(() => {})
      } catch (error) { failure = error }
    }
    const seen = new Set<string>()
    for (const offer of [this.#own, this.#offer, this.#shared]) {
      if (!offer || offer.expiresAt <= now || offer.endpoint.startsWith('spry:') && offer.endpoint !== this.pairing?.endpoint) continue
      const id = offer.endpoint + ':' + offer.token
      if (seen.has(id)) continue
      seen.add(id)
      if ((this.#credentials.get(id)?.expiresAt ?? 0) - now > 90) continue
      try {
        const credential = await spryCredentials(offer, this.#key, this.fetcher, this.pairing)
        if (this.#closed || revision !== this.#pairRevision) return
        this.#credentials.set(id, credential)
        const renewed = { ...offer, expiresAt: credential.accessExpiresAt, ...(credential.node ? { node: credential.node } : {}) }
        if (this.#own?.token === offer.token && this.#own.endpoint === offer.endpoint) {
          const changed = credential.node?.id !== this.#own.node?.id
          this.#own = renewed
          if (changed) await this.publish().catch(() => {})
        }
        if (!this.#own || this.#own.token === offer.token && this.#own.endpoint === offer.endpoint) this.#offer = renewed
        this.retain(renewed)
      } catch (error) { failure = error }
    }
    this.#applyCredentials()
    await this.#registerPeers().catch(error => { failure = error })
    if (failure && !this.#credentialUntil) throw failure
  }
  async prepare(): Promise<void> {
    if (!this.#offer && !this.pairing) {
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); this.#waiters.delete(finish); resolve() }
        const timer = setTimeout(finish, 2500)
        this.#waiters.add(finish)
      })
    }
    try { await this.refresh() } catch (error) { if (this.#credentialUntil <= Date.now() / 1000) throw error }
    this.#applyCredentials()
  }
  /** Account sync can arrive after the room opens; no room rejoin is needed. */
  setPairing(pair: SpryPairing | undefined): void {
    if (this.#closed || pair?.id === this.pairing?.id && pair?.endpoint === this.pairing?.endpoint && pair?.secretKey === this.pairing?.secretKey) return
    this.#pairRevision++
    this.pairing = pair
    this.#own = undefined
    this.#offer = this.#shared
    this.#credentials.clear()
    this.#credentialUntil = 0
    this.#applied = ''
    for (const finish of this.#waiters) finish()
    if (this.#work) this.#peerUpdatePending = true
    else void this.refresh().catch(() => {})
  }
  close(): void {
    this.#closed = true; clearInterval(this.#timer)
    clearTimeout(this.#publication)
    for (const unsubscribe of this.#unsub) unsubscribe()
    for (const finish of this.#waiters) finish()
    this.#waiters.clear()
    if (this.pairing?.endpoint.startsWith('spry:')) void spryPeers(this.pairing, this.session.roomId, this.#key, [], this.fetcher, ++this.#peerRevision).catch(() => {})
  }
}
