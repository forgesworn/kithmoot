import { randomBytes, bytesToHex } from '@noble/hashes/utils'
import { acceptChannelCheck, beginChannelCheck, channelCheckHash, channelCheckWords,
  confirmChannelCheckRevealSent, createChannelCheckRequest, parseChannelCheckMessage,
  receiveChannelCheckAcceptance, receiveChannelCheckReveal,
  type ChannelCheckRequest, type ChannelCheckState } from '@forgesworn/signet-contacts'
import type { DeviceStore } from './device-store.js'

export const CHECK_CHANNEL = 'signet-checks-v1'
export interface StoredChannelCheck {
  request: ChannelCheckRequest
  state?: ChannelCheckState
  declined?: true
  sent?: string
  checkedAt?: number
}
interface Options {
  context: string; local: string; store: DeviceStore
  /** Receives only ChatLog's credential-authenticated participant and text. */
  send(text: string): Promise<void>
  current(): boolean
  allowed?(peer: string): boolean
  now?(): number
  lock?<T>(task: () => Promise<T>): Promise<T>
}
const HEX = /^[0-9a-f]{64}$/
/** A bounded durable protocol controller. Human acceptance and comparison are
 * separate from receipt. All writes and sends share a cross-tab lock. */
export class ChannelChecks {
  readonly #options: Options
  readonly #key: string
  readonly #now: () => number
  constructor(options: Options) {
    if (!HEX.test(options.context) || !HEX.test(options.local)) throw new Error('Invalid check context')
    this.#options = options
    this.#key = `kithmoot.channel-checks.v1.${options.local}.${options.context}`
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000))
  }
  #allowed(peer: string): boolean {
    try { return this.#options.allowed?.(peer) !== false } catch { return false }
  }
  #current(): void { if (!this.#options.current()) throw new Error('This room has closed') }
  async #locked<T>(task: () => Promise<T>): Promise<T> {
    const run = async () => { this.#current(); return task() }
    if (this.#options.lock) return this.#options.lock(run)
    if (typeof navigator === 'undefined' || !navigator.locks) throw new Error('This browser cannot safely coordinate checks across tabs')
    return navigator.locks.request(this.#key, { mode: 'exclusive' }, run)
  }
  #read(): StoredChannelCheck[] {
    this.#current()
    const raw = this.#options.store.get(this.#key)
    if (raw === null) return []
    if (raw.length > 1024 * 1024) throw new Error('Check history is too large')
    const rows = JSON.parse(raw) as StoredChannelCheck[]
    if (!Array.isArray(rows) || rows.length > 256) throw new Error('Invalid check history')
    const ids = new Set<string>()
    return rows.map(row => {
      const request = parseChannelCheckMessage(JSON.stringify(row?.request))
      if (!request || request.type !== 'channel-check-request' || request.context !== this.#options.context
        || (request.from !== this.#options.local && request.to !== this.#options.local)
        || ids.has(request.id) || (row.declined !== undefined && row.declined !== true)
        || (row.sent !== undefined && !HEX.test(row.sent))) throw new Error('Invalid saved check')
      ids.add(request.id)
      let state: ChannelCheckState | undefined
      if (row.state) {
        const saved = row.state
        if (channelCheckHash(saved.request) !== channelCheckHash(request)) throw new Error('Saved request changed')
        if (request.from === this.#options.local && saved.role === 'requester') {
          state = beginChannelCheck(request, saved.nonce)
          if (saved.acceptance) {
            if (!saved.reveal) throw new Error('Saved reveal missing')
            state = receiveChannelCheckAcceptance(state, saved.acceptance, saved.reveal.createdAt)
            if (channelCheckHash(state.reveal!) !== channelCheckHash(saved.reveal)) throw new Error('Saved reveal changed')
            if (saved.phase === 'complete') state = confirmChannelCheckRevealSent(state)
          } else if (saved.reveal) throw new Error('Unexpected saved reveal')
        } else if (request.to === this.#options.local && saved.role === 'recipient' && saved.acceptance) {
          state = acceptChannelCheck(request, saved.nonce, saved.acceptance.createdAt)
          if (channelCheckHash(state.acceptance!) !== channelCheckHash(saved.acceptance)) throw new Error('Saved acceptance changed')
          if (saved.reveal) state = receiveChannelCheckReveal(state, saved.reveal, saved.reveal.createdAt)
        } else throw new Error('Invalid saved check role')
        if (state.phase !== saved.phase || row.declined) throw new Error('Invalid saved check phase')
      } else if (request.from === this.#options.local) throw new Error('Saved request nonce missing')
      if (row.checkedAt !== undefined && (!Number.isSafeInteger(row.checkedAt) || row.checkedAt < (state?.reveal?.createdAt ?? Infinity)
        || state?.phase !== 'complete')) throw new Error('Invalid saved comparison')
      return { request, ...(state ? { state } : {}), ...(row.declined ? { declined: true as const } : {}),
        ...(row.sent ? { sent: row.sent } : {}), ...(row.checkedAt !== undefined ? { checkedAt: row.checkedAt } : {}) }
    })
  }
  #save(rows: StoredChannelCheck[]): void {
    this.#current()
    const raw = JSON.stringify(rows)
    if (rows.length > 256 || raw.length > 1024 * 1024) throw new Error('Check history is full')
    this.#options.store.set(this.#key, raw)
    if (this.#options.store.get(this.#key) !== raw) throw new Error('Could not save this check')
  }
  #add(rows: StoredChannelCheck[], row: StoredChannelCheck): void {
    const live = rows.filter(r => !r.declined && r.state?.phase !== 'complete' && r.request.expiresAt > this.#now())
    const peer = this.peer(row)
    if (rows.length >= 256 || live.length >= 16 || live.filter(r => this.peer(r) === peer).length >= 2) throw new Error('Too many pending checks')
    rows.push(row)
  }
  peer(row: StoredChannelCheck): string { return row.request.from === this.#options.local ? row.request.to : row.request.from }
  list(peer?: string): StoredChannelCheck[] { return this.#read().filter(row => !peer || this.peer(row) === peer) }
  words(id: string): { youSay: string; theySay: string } | undefined {
    const row = this.#read().find(r => r.request.id === id)
    const s = row && this.#allowed(this.peer(row)) ? row.state : undefined
    return s?.phase === 'complete' && s.acceptance && s.reveal ? channelCheckWords(s.request, s.acceptance, s.reveal, this.#options.local) : undefined
  }
  async #flush(rows: StoredChannelCheck[], row: StoredChannelCheck): Promise<void> {
    const s = row.state
    if (!s || row.declined || row.request.expiresAt <= this.#now()) return
    if (!this.#allowed(this.peer(row))) throw new Error('This person is blocked')
    const message = s.role === 'recipient' ? s.acceptance : s.reveal ?? s.request
    if (!message || row.sent === channelCheckHash(message)) return
    // The entire state (including the pinned acceptance) precedes publication.
    this.#save(rows); this.#current()
    await this.#options.send(JSON.stringify(message)); this.#current()
    row.sent = channelCheckHash(message)
    if (s.role === 'requester' && s.phase === 'reveal-pending') row.state = confirmChannelCheckRevealSent(s)
    this.#save(rows)
  }
  start(peer: string): Promise<string> {
    return this.#locked(async () => {
      if (!HEX.test(peer) || peer === this.#options.local) throw new Error('Invalid check recipient')
      if (!this.#allowed(peer)) throw new Error('This person is blocked')
      const rows = this.#read()
      const existing = rows.find(r => this.peer(r) === peer && !r.declined && r.state?.role === 'requester'
        && r.state.phase !== 'complete' && r.request.expiresAt > this.#now())
      if (existing) { await this.#flush(rows, existing); return existing.request.id }
      const nonce = bytesToHex(randomBytes(32))
      const request = createChannelCheckRequest({ id: bytesToHex(randomBytes(16)), context: this.#options.context,
        from: this.#options.local, to: peer, nonce, now: this.#now() })
      const row = { request, state: beginChannelCheck(request, nonce) }
      this.#add(rows, row); this.#save(rows); await this.#flush(rows, row)
      return request.id
    })
  }
  accept(id: string): Promise<void> {
    return this.#locked(async () => {
      const rows = this.#read(), row = rows.find(r => r.request.id === id)
      if (!row || row.declined || !this.#allowed(this.peer(row)) || row.request.to !== this.#options.local) throw new Error('This check cannot be accepted')
      if (!row.state) row.state = acceptChannelCheck(row.request, bytesToHex(randomBytes(32)), this.#now())
      this.#save(rows); await this.#flush(rows, row)
    })
  }
  decline(id: string): Promise<void> {
    return this.#locked(async () => {
      const rows = this.#read(), row = rows.find(r => r.request.id === id)
      if (!row || row.state || row.request.to !== this.#options.local) throw new Error('This check has already started')
      row.declined = true; this.#save(rows)
    })
  }
  retry(id: string): Promise<void> {
    return this.#locked(async () => {
      const rows = this.#read(), row = rows.find(r => r.request.id === id)
      if (row) { delete row.sent; this.#save(rows); await this.#flush(rows, row) }
    })
  }
  /** Explicit human comparison, never called just because the protocol ended. */
  confirm(id: string): Promise<void> {
    return this.#locked(async () => {
      const rows = this.#read(), row = rows.find(r => r.request.id === id)
      if (!row || !this.words(id)) throw new Error('The exchange is not complete')
      row.checkedAt = this.#now(); this.#save(rows)
    })
  }
  receive(participant: string, text: string): Promise<void> {
    const message = parseChannelCheckMessage(text)
    if (!message || participant !== message.from || message.to !== this.#options.local || message.context !== this.#options.context) return Promise.resolve()
    return this.#locked(async () => {
      if (message.createdAt > this.#now() || !this.#allowed(message.from)) return
      const rows = this.#read(), row = rows.find(r => r.request.id === message.id)
      if (message.type === 'channel-check-request') {
        if (message.expiresAt <= this.#now()) return
        if (row) {
          if (channelCheckHash(row.request) !== channelCheckHash(message)) throw new Error('Check ID already used')
          return
        }
        this.#add(rows, { request: message }); this.#save(rows); return
      }
      if (!row || row.declined || !row.state || row.request.expiresAt <= this.#now()) return
      if (message.type === 'channel-check-accept') row.state = receiveChannelCheckAcceptance(row.state, message, this.#now())
      else row.state = receiveChannelCheckReveal(row.state, message, this.#now())
      this.#save(rows); await this.#flush(rows, row)
    })
  }
}
