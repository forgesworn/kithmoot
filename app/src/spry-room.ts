import { spryCredentials, spryGrant, spryPeers, spryRegisterDevices, spryRemoveGrant, spryVouch, newSpryKey, spryDeviceKey, SpryRequestError,
  type SpryOffer, type SpryPairing, type SpryCredential } from '../../src/spry.js'
import { spryDevicePublicKey } from '../../src/spry-key.js'
import { parseSpryControl, spryNodeCard } from '../../src/spry-link.js'
import type { RoomSession } from '../../src/session.js'

/** Keys registered per participant, so a link holder cannot churn devices to
 *  push genuine members out of a grant's 64 entries. A person's third device
 *  is let in by a member vouching for it on a call. */
export const SPRY_KEYS_PER_PARTICIPANT = 2
/** Stop adding other members' keys once the node reports this many entries,
 *  leaving room under its 64 for the owner's own devices and vouches. */
export const SPRY_GRANT_HEADROOM = 56
/** A node without the room-grant paths is not asked again for this long. */
export const SPRY_UNSUPPORTED_MS = 60 * 60 * 1000
/** Retries after a refused redemption in the first minute of an offer or call. */
export const SPRY_RETRY_MS: readonly number[] = [3000, 10000, 30000]
const RETRY_WINDOW_MS = 60_000
/** A member vouches only while its own redemption of the grant is this fresh. */
const VOUCH_FRESH_MS = 10 * 60 * 1000

export interface SpryRoomOptions {
  /**
   * Whether this device shares its own relay in this room: it publishes the
   * room's grant (with its node card, for a private node) to the room and
   * registers members' keys. Either way a paired device holds the grant for
   * its own calls and registers its own key. Defaults to true.
   */
  share?: boolean
  /** Test seam for the vouch delay, in milliseconds. */
  jitter?: () => number
}

/** One room owns its credentials and timers, including while its call is docked. */
export class SpryRoom {
  #offer?: SpryOffer
  #own?: SpryOffer
  #shared?: SpryOffer
  #credentialUntil = 0
  #credentials = new Map<string, SpryCredential>()
  #applied = ''
  #key: string
  #spryPublic: string
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
  #registration?: ReturnType<typeof setTimeout>
  #waiters = new Set<() => void>()
  #share: boolean
  #jitter: () => number
  /** Tokens this device withdrew; never republished. */
  #withdrawn = new Set<string>()
  // Registrar state for the grant `#registeredFor`, this session only.
  #registeredFor?: string
  #registered = new Map<string, string>()
  #seen = new Map<string, Set<string>>()
  #sealed = false
  #grantDevices = 0
  #revision = Date.now()
  #unsupportedUntil = 0
  // Member state: when each offer last redeemed, and whom this session vouched for.
  #redeemedAt = new Map<string, number>()
  #vouched = new Set<string>()
  /** Devices present when this device could first vouch: not newcomers. */
  #vouchBase?: Set<string>
  #vouchedPer = new Map<string, number>()
  #vouchTimers = new Set<ReturnType<typeof setTimeout>>()
  // Early retry after a refusal.
  #windowStart = 0
  #retryStep = 0
  #retryTimer?: ReturnType<typeof setTimeout>
  /** Status of the last refused redemption of another member's relay. */
  #sharedRefusal = 0
  constructor(private session: RoomSession, private pairing: SpryPairing | undefined,
    private apply: (servers: RTCIceServer[]) => void, private fetcher: typeof fetch = fetch,
    deviceKey?: Uint8Array, saved?: SpryOffer, private retain: (offer: SpryOffer) => void = () => {}, options: SpryRoomOptions = {}) {
    this.#key = deviceKey ? spryDeviceKey(deviceKey) : newSpryKey()
    this.#spryPublic = deviceKey ? spryDevicePublicKey(deviceKey) : ''
    this.#share = options.share ?? true
    this.#jitter = options.jitter ?? (() => 1000 + Math.floor(Math.random() * 4000))
    // A saved offer from this device's own node is its own old grant: not
    // reused or republished while it does not share here.
    this.#offer = saved
    if (this.#offer) this.#windowStart = Date.now()
    this.#unsub.push(session.onDescriptor(descriptor => {
      if (this.#closed || !descriptor.spry) return
      const next = descriptor.spry
      // Private adverts travel to our paired node; they never open foreign sockets.
      if (next.endpoint.startsWith('spry:') && next.endpoint !== this.pairing?.endpoint) return
      if (this.#withdrawn.has(next.token)) return
      const fresh = this.#shared?.token !== next.token
      this.#shared = next
      if (fresh) { this.#windowStart = Date.now(); this.#retryStep = 0 }
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
      if (this.#closed) return
      this.#scheduleVouches()
      const roster = views.flatMap(view => view.devices).sort().join(',')
      if (roster === this.#roster) return
      this.#roster = roster
      // A registrar adds newcomers' keys and drops removed participants'.
      if (this.#registrar() && this.#registration === undefined) {
        this.#registration = setTimeout(() => {
          this.#registration = undefined
          if (this.#work) this.#peerUpdatePending = true
          else void this.refresh().catch(() => {})
        }, 1000)
      }
      if (!this.#publishable() || this.#publication !== undefined) return
      this.#publication = setTimeout(() => {
        this.#publication = undefined
        void this.publish().catch(() => {})
      }, Math.max(0, 1000 - (Date.now() - this.#lastPublication)))
    }))
    this.#timer = setInterval(() => {
      if (this.#closed) return
      this.#applyCredentials()
      if (this.#asksOwnNode() || session.call) void this.refresh().catch(() => {})
    }, 30000)
    if (this.#asksOwnNode()) void this.refresh().catch(() => {})
  }
  /** Whether this device shares its own relay in this room. */
  get sharing(): boolean { return this.#shares() }
  #shares(): boolean { return this.#share }
  #ownNode(offer: SpryOffer): boolean { return !!this.pairing && offer.endpoint === this.pairing.endpoint }
  /** A paired device always holds its room grant, for its own calls. */
  #asksOwnNode(): boolean { return !!this.pairing }
  #registrar(): boolean { return this.#asksOwnNode() && !!this.#own }
  /** The offer this device republishes: its own grant when it shares, or the
   *  one another member shared, never a grant it withdrew or keeps to itself. */
  #publishable(): SpryOffer | undefined {
    const offer = this.#shares() ? this.#own ?? this.#offer : this.#offer
    if (!offer || this.#withdrawn.has(offer.token)) return undefined
    if (!this.#shares() && this.#ownNode(offer) && offer.token !== this.#shared?.token) return undefined
    return offer
  }
  async publish(): Promise<void> {
    const offer = this.#publishable()
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
  /** One registration request, retried once with a fresh revision when the
   *  node says it is out of date. Every answer re-decides the seal. */
  async #send(pair: SpryPairing, offer: SpryOffer, change: { add?: string[]; remove?: string[]; seal?: boolean }): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      this.#revision = Math.max(Date.now(), this.#revision + 1)
      try {
        const answer = await spryRegisterDevices(pair, offer, change, this.#revision, this.fetcher)
        this.#sealed = answer.sealed
        this.#grantDevices = answer.devices
        return
      } catch (error) {
        if (error instanceof SpryRequestError && error.status === 409 && attempt === 0) continue
        if (error instanceof SpryRequestError && error.status === 404) this.#unsupportedUntil = Date.now() + SPRY_UNSUPPORTED_MS
        throw error
      }
    }
  }
  /**
   * The registrar's delta: removals for participants removed from the room,
   * then this device's own key and present members' keys, then a seal once
   * no present device that is not an agent lacks a key. Each in a request of
   * its own, since the node drops a whole refused request. Keys are never
   * removed because a device left: presence is not membership.
   */
  async #registerDevices(): Promise<void> {
    const pair = this.pairing, offer = this.#own
    if (!pair || !offer || Date.now() < this.#unsupportedUntil || this.#closed) return
    if (this.#registeredFor !== offer.token) {
      this.#registeredFor = offer.token
      this.#registered.clear(); this.#sealed = false; this.#grantDevices = 0
    }
    const roster = this.session.spryRoster?.() ?? []
    const removed = this.session.removed
    for (const row of roster) {
      if (!row.spryKey || row.spryKey === this.#spryPublic || removed.has(row.participant)) continue
      const keys = this.#seen.get(row.participant) ?? new Set<string>()
      keys.add(row.spryKey); this.#seen.set(row.participant, keys)
    }
    const remove: string[] = []
    for (const [participant, keys] of this.#seen) {
      if (!removed.has(participant)) continue
      for (const key of keys) { remove.push(key); this.#registered.delete(key) }
      this.#seen.delete(participant)
    }
    for (let i = 0; i < remove.length; i += 32) await this.#send(pair, offer, { remove: remove.slice(i, i + 32) })

    const add: { key: string; participant: string }[] = []
    if (this.#spryPublic && !this.#registered.has(this.#spryPublic)) add.push({ key: this.#spryPublic, participant: this.session.participant })
    const perParticipant = new Map<string, number>()
    for (const owner of this.#registered.values()) perParticipant.set(owner, (perParticipant.get(owner) ?? 0) + 1)
    // Not shared here: nobody else holds the token, so only this device's key.
    for (const row of this.#shares() ? roster : []) {
      const key = row.spryKey
      // Agents redeem no Spry offers: their keys would only spend the grant's slots.
      if (!key || row.agent || key === this.#spryPublic || this.#registered.has(key) || removed.has(row.participant) || add.some(item => item.key === key)) continue
      const count = perParticipant.get(row.participant) ?? 0
      if (count >= SPRY_KEYS_PER_PARTICIPANT) continue
      perParticipant.set(row.participant, count + 1)
      add.push({ key, participant: row.participant })
    }
    while (add.length) {
      // This device's own key always goes; others only while the grant has room.
      const own = add[0]!.key === this.#spryPublic
      const room = own ? 32 : Math.min(32, SPRY_GRANT_HEADROOM - this.#grantDevices)
      if (room <= 0) break
      const batch = add.splice(0, room)
      await this.#send(pair, offer, { add: batch.map(item => item.key) })
      for (const item of batch) this.#registered.set(item.key, item.participant)
    }

    // Sealed only while every present person's device announces a key: an
    // older client present keeps the grant open, as it was, until it leaves.
    const ready = roster.length > 0 && roster.every(row => row.agent || row.spryKey) && this.#registered.has(this.#spryPublic)
    if (!this.#sealed && ready) await this.#send(pair, offer, { seal: true })
  }
  /**
   * Members vouch for a device admitted to the room after them, once each,
   * after a random delay, while their own redemption of that grant is fresh:
   * so a newcomer, relay-only or not, gets the room's relay while the owner
   * is away. Devices already present when this one could first vouch are not
   * newcomers (every key named counts against its daily allowance), and at
   * most two keys per participant, as the registrar allows.
   */
  #scheduleVouches(): void {
    if (!this.session.spryRoster || Date.now() < this.#unsupportedUntil) return
    const offer = [this.#shared, this.#offer].find(candidate => candidate && candidate.token !== this.#own?.token &&
      Date.now() - (this.#redeemedAt.get(candidate.endpoint + ':' + candidate.token) ?? 0) < VOUCH_FRESH_MS)
    if (!offer) return
    const rows = this.session.spryRoster()
    if (!this.#vouchBase) { this.#vouchBase = new Set(rows.map(row => row.device)); return }
    for (const row of rows) {
      if (!row.spryKey || row.agent || row.device === this.session.device || row.spryKey === this.#spryPublic || this.#vouchBase.has(row.device) || this.#vouched.has(row.device)) continue
      const count = this.#vouchedPer.get(row.participant) ?? 0
      if (count >= SPRY_KEYS_PER_PARTICIPANT) continue
      this.#vouchedPer.set(row.participant, count + 1)
      this.#vouched.add(row.device)
      const key = row.spryKey
      const timer = setTimeout(() => {
        this.#vouchTimers.delete(timer)
        if (this.#closed) return
        spryVouch(offer, this.#key, [key], this.fetcher).catch(error => {
          if (error instanceof SpryRequestError && error.status === 404) this.#unsupportedUntil = Date.now() + SPRY_UNSUPPORTED_MS
        })
      }, this.#jitter())
      this.#vouchTimers.add(timer)
    }
  }
  /** After a refusal in the first minute of an offer or a call: 3, 10 and 30
   *  seconds, then the ordinary 30-second timer. */
  #scheduleRetry(): void {
    if (this.#closed || this.#retryTimer !== undefined || this.#retryStep >= SPRY_RETRY_MS.length) return
    if (Date.now() - this.#windowStart > RETRY_WINDOW_MS) return
    const delay = SPRY_RETRY_MS[this.#retryStep++]!
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined
      void this.refresh().catch(() => {})
    }, delay)
  }
  async #refresh(): Promise<void> {
    if (this.#closed) return
    const revision = this.#pairRevision
    const now = Date.now() / 1000
    let failure: unknown, ownFailure: unknown
    this.#sharedRefusal = 0
    if (this.pairing && (!this.#own || this.#own.expiresAt - now < 360)) {
      try {
        const own = await spryGrant(this.pairing, this.session.roomId, this.fetcher)
        if (this.#closed || revision !== this.#pairRevision) return
        this.#offer = this.#own = own
        this.retain(own)
        await this.publish().catch(() => {})
      } catch (error) { failure = ownFailure = error }
    }
    // Registered before the first redemption, so a node that seals every
    // grant still serves this device from its first call.
    await this.#registerDevices().catch(() => {})
    if (this.#closed || revision !== this.#pairRevision) return
    const seen = new Set<string>()
    for (const offer of [this.#own, this.#offer, this.#shared]) {
      if (!offer || offer.expiresAt <= now || offer.endpoint.startsWith('spry:') && offer.endpoint !== this.pairing?.endpoint) continue
      if (this.#withdrawn.has(offer.token)) continue
      const id = offer.endpoint + ':' + offer.token
      if (seen.has(id)) continue
      seen.add(id)
      if ((this.#credentials.get(id)?.expiresAt ?? 0) - now > 90) continue
      const mine = this.#own?.token === offer.token && this.#own.endpoint === offer.endpoint
      try {
        const credential = await spryCredentials(offer, this.#key, this.fetcher, this.pairing)
        if (this.#closed || revision !== this.#pairRevision) return
        this.#credentials.set(id, credential)
        this.#redeemedAt.set(id, Date.now())
        const renewed = { ...offer, expiresAt: credential.accessExpiresAt, ...(credential.node ? { node: credential.node } : {}) }
        if (mine) {
          const changed = credential.node?.id !== this.#own!.node?.id
          this.#own = renewed
          if (changed) await this.publish().catch(() => {})
        }
        if (!this.#own || mine) this.#offer = renewed
        this.retain(renewed)
      } catch (error) {
        failure = error
        if (mine) {
          ownFailure = error
          // The grant was removed or lapsed on the node: ask again next time.
          if (error instanceof SpryRequestError && error.status === 403) this.#own = undefined
        } else if (error instanceof SpryRequestError && error.status === 403) {
          this.#sharedRefusal = 403
          this.#scheduleRetry()
        }
      }
    }
    this.#applyCredentials()
    this.#scheduleVouches()
    await this.#registerPeers().catch(error => { failure = error })
    // This device's own pairing speaks first: its hint is the useful one.
    if ((ownFailure ?? failure) && !this.#credentialUntil) throw ownFailure ?? failure
  }
  /**
   * Ready the room's relay before a call. `patient` is for a call that may
   * not go direct (Hide my IP address): a refusal of another member's relay
   * is retried at 3 and 10 seconds first, since the owner's app registers a
   * newcomer's key only once it has seen it join.
   */
  async prepare(patient = false): Promise<void> {
    this.#windowStart = Date.now(); this.#retryStep = 0
    if (!this.#offer && !this.#shared && !this.pairing) {
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); this.#waiters.delete(finish); resolve() }
        const timer = setTimeout(finish, 2500)
        this.#waiters.add(finish)
      })
    }
    for (let step = 0; ; step++) {
      try { await this.refresh(); break } catch (error) {
        if (this.#credentialUntil > Date.now() / 1000) break
        if (!patient || this.#sharedRefusal !== 403 || step >= 2 || this.#closed) throw error
        clearTimeout(this.#retryTimer); this.#retryTimer = undefined
        this.#retryStep = step + 1
        await new Promise(resolve => setTimeout(resolve, SPRY_RETRY_MS[step]))
      }
    }
    this.#applyCredentials()
  }
  /**
   * Start or stop sharing this device's relay in this room. Starting
   * publishes the grant this device already holds and registers members.
   * Stopping stops publishing it, asks the node to drop that grant, so access
   * already handed out ends within five minutes, and takes a fresh grant,
   * never published, for this device's own calls; credentials it already
   * holds carry its call over the gap. Resolves false only when the removal
   * could not be confirmed.
   */
  async setShare(on: boolean): Promise<boolean> {
    if (this.#closed || on === this.#share) return true
    this.#share = on
    if (on) {
      void this.refresh().catch(() => {}).then(() => this.publish()).catch(() => {})
      return true
    }
    const pair = this.pairing, own = this.#own ?? (this.#offer && this.#ownNode(this.#offer) ? this.#offer : undefined)
    this.#pairRevision++
    this.#own = undefined
    this.#registeredFor = undefined; this.#registered.clear(); this.#sealed = false
    if (own) this.#withdrawn.add(own.token)
    this.#offer = this.#shared && !this.#withdrawn.has(this.#shared.token) ? this.#shared : undefined
    let removed = true
    if (pair && own) {
      try { await spryRemoveGrant(pair, own, this.fetcher) }
      catch (error) { removed = error instanceof SpryRequestError && error.status === 403 }
    }
    if (this.#closed) return removed
    if (this.#work) this.#peerUpdatePending = true
    else void this.refresh().catch(() => {})
    return removed
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
    this.#registeredFor = undefined; this.#registered.clear(); this.#sealed = false; this.#unsupportedUntil = 0
    for (const finish of this.#waiters) finish()
    if (this.#work) this.#peerUpdatePending = true
    else void this.refresh().catch(() => {})
  }
  close(): void {
    this.#closed = true; clearInterval(this.#timer)
    clearTimeout(this.#publication); clearTimeout(this.#registration); clearTimeout(this.#retryTimer)
    for (const timer of this.#vouchTimers) clearTimeout(timer)
    this.#vouchTimers.clear()
    for (const unsubscribe of this.#unsub) unsubscribe()
    for (const finish of this.#waiters) finish()
    this.#waiters.clear()
    if (this.pairing?.endpoint.startsWith('spry:')) void spryPeers(this.pairing, this.session.roomId, this.#key, [], this.fetcher, ++this.#peerRevision).catch(() => {})
  }
}
