import { newSpryKey, spryDeviceKey, spryCredentials, spryGrant, type SpryOffer, type SpryPairing } from '../../src/spry.js'
import type { RoomSession } from '../../src/session.js'

/** One room owns its credentials and timers, including while its call is docked. */
export class SpryRoom {
  #offer?: SpryOffer
  #own?: SpryOffer
  #credentialUntil = 0
  #key: string
  #closed = false
  #work?: Promise<void>
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
      if (this.#closed || this.pairing || !descriptor.spry) return
      const next = descriptor.spry
      this.#offer = this.#offer?.token === next.token && this.#offer.endpoint === next.endpoint
        ? { ...next, expiresAt: Math.max(next.expiresAt, this.#offer.expiresAt) } : next
      this.retain(this.#offer)
      for (const wake of this.#waiters) wake()
      if (session.call) void this.refresh().catch(() => {})
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
      if (this.#credentialUntil && this.#credentialUntil <= Date.now() / 1000) { this.#credentialUntil = 0; this.apply([]) }
      if (this.pairing || session.call) void this.refresh().catch(() => {})
    }, 30000)
    if (pairing) void this.refresh().catch(() => {})
  }
  async publish(): Promise<void> {
    if (!this.#offer || this.#closed || this.#offer.expiresAt <= Date.now() / 1000) return
    this.#lastPublication = Date.now()
    const old = this.session.descriptor
    await this.session.publishDescriptor({ forwarders: old?.forwarders, iceServers: old?.iceServers, spry: this.#offer })
  }
  refresh(): Promise<void> {
    if (this.#work) return this.#work
    this.#work = this.#refresh().finally(() => { this.#work = undefined })
    return this.#work
  }
  async #refresh(): Promise<void> {
    if (this.#closed) return
    const now = Date.now() / 1000
    if (this.pairing && (!this.#own || this.#own.expiresAt - now < 360)) {
      const own = await spryGrant(this.pairing, this.session.roomId, this.fetcher)
      if (this.#closed) return
      this.#offer = this.#own = own
      this.retain(own)
      await this.publish()
    }
    if (!this.#offer || this.#offer.expiresAt <= now || this.#credentialUntil - now > 90) return
    const credential = await spryCredentials(this.#offer, this.#key, this.fetcher)
    if (this.#closed) return
    this.#credentialUntil = credential.expiresAt
    this.#offer = { ...this.#offer, expiresAt: credential.accessExpiresAt }
    if (this.#own) this.#own = this.#offer
    this.retain(this.#offer)
    this.apply([{ urls: credential.urls, username: credential.username, credential: credential.credential }])
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
    if (this.#credentialUntil && this.#credentialUntil <= Date.now() / 1000) { this.#credentialUntil = 0; this.apply([]) }
  }
  close(): void {
    this.#closed = true; clearInterval(this.#timer)
    clearTimeout(this.#publication)
    for (const unsubscribe of this.#unsub) unsubscribe()
    for (const finish of this.#waiters) finish()
    this.#waiters.clear()
  }
}
