import type { Event } from 'nostr-tools/pure'
import type { RelayHealth, RelayTransport } from '../../src/relay-pool.js'
import type { DeviceStore } from './device-store.js'
import { OrdinaryMessageHistory, mergeSendStatus, ordinaryHistoryKey, readOrdinarySendStatuses,
  type OrdinaryHistoryLock, type OrdinaryOutgoingMessage, type OrdinarySendStatus } from './nostr-message-history.js'
import { captureOrdinaryCopy, ORDINARY_MAX_COPIES, ordinaryExpired, type OrdinaryText } from './nostr-message-wire.js'
import { openAccountMessage, type AccountMessageDecrypt, type OpenedInvitation } from './nostr-opened-message.js'

const HEX = /^[0-9a-f]{64}$/
const WINDOW_SECONDS = 32 * 86_400 // Includes NIP-17's two days of outer timestamp jitter.
const MAX_SEEN = 2_048
const BATCH = 16
export const peopleInboxReadKey = (account: string) => `kithmoot.nostr-people-read.v1.${account}`
export type ReadOutcome = 'saved' | 'skipped' | 'refused'
export const peopleInboxEnabledKey = (account: string) => `kithmoot.nostr-people-inbox.v1.${account}`

type InboxTransport = Pick<RelayTransport, 'subscribe' | 'close'> & {
  health?(): RelayHealth[]
  authenticate?(required: string[], current: () => boolean): boolean
}
interface Options {
  account: string
  store: DeviceStore
  acquire: OrdinaryHistoryLock
  receive: (current: () => boolean) => Promise<InboxTransport>
  decrypt: AccountMessageDecrypt
  keepNodeInvitation?(token: OpenedInvitation, current: () => boolean): Promise<boolean>
  blocked(peer: string): boolean
  current(): boolean
  changed(): void
  now?(): number
}

type ThreadMessage = OrdinaryText & { sendStatus?: OrdinarySendStatus }
export interface NostrPeopleThread {
  peer: string
  messages: readonly ThreadMessage[]
  unread: number
}

/** One foreground account listener. The durable history holds original
 * ciphertext and read wrap IDs. Decoded text lives in this account's view. */
export class PeopleNostrInbox {
  #transport?: InboxTransport
  #off?: () => void
  #queued = new Map<string, { copy: Event; saved: boolean }>()
  #seen = new Set<string>()
  #messages = new Map<string, { message: OrdinaryText; copies: Set<string>; expiresAt?: number }>()
  #sendStatuses = new Map<string, OrdinarySendStatus>()
  #read = new Set<string>()
  #started = false
  #draining = false
  #savingInvitations = 0
  #signerNeedsAttention = false
  #closed = false
  #timer?: ReturnType<typeof setTimeout>
  #status = 'Connecting to your Nostr inbox…'
  #found = false

  constructor(private readonly options: Options) {}
  #now(): number { return this.options.now?.() ?? Math.floor(Date.now() / 1000) }
  #current = () => !this.#closed && this.options.current()
  #notify(): void {
    if (!this.#current()) return
    clearTimeout(this.#timer)
    const now = this.#now()
    for (const [id, row] of this.#messages) {
      if (row.expiresAt !== undefined && row.expiresAt <= now) this.#messages.delete(id)
    }
    const next = Math.min(...[...this.#messages.values()].map(row => row.expiresAt ?? Infinity))
    if (Number.isFinite(next)) this.#timer = setTimeout(() => this.#notify(), Math.min(2_147_000_000, (next - now) * 1000))
    this.options.changed()
  }

  get status(): string { return this.#status }
  threads(): NostrPeopleThread[] {
    if (!this.#current()) return []
    const threads = new Map<string, { peer: string; messages: ThreadMessage[]; unread: number; sent: number }>()
    for (const { message, copies, expiresAt } of this.#messages.values()) {
      const peer = message.peer!
      if (this.options.blocked(peer) || expiresAt !== undefined && expiresAt <= this.#now()) continue
      const thread = threads.get(peer) ?? { peer, messages: [], unread: 0, sent: 0 }
      if (message.author === this.options.account) {
        let sendStatus: OrdinarySendStatus | undefined
        for (const copy of copies) {
          const status = this.#sendStatuses.get(copy)
          if (status) sendStatus = mergeSendStatus(sendStatus, status)
        }
        thread.messages.push(sendStatus ? { ...message, sendStatus } : message)
        thread.sent++
      } else {
        thread.messages.push(message)
        if (![...copies].some(copy => this.#read.has(copy))) thread.unread++
      }
      threads.set(peer, thread)
    }
    for (const thread of threads.values()) thread.messages.sort((a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id))
    return [...threads.values()].sort((a, b) =>
      Number(b.unread > 0) - Number(a.unread > 0) ||
      (a.unread || b.unread ? 0 : b.sent - a.sent) ||
      b.messages.at(-1)!.sentAt - a.messages.at(-1)!.sentAt ||
      a.peer.localeCompare(b.peer))
  }

  async open(): Promise<void> {
    if (this.#started || !this.#current()) return
    this.#started = true
    try {
      this.#read = this.#storedRead()
      this.#sendStatuses = readOrdinarySendStatuses(this.options.store, this.options.account)
      const history = new OrdinaryMessageHistory(this.options.store, this.options.account, () => this.#now())
      for (const copy of history.copies()) this.#queued.set(copy.id, { copy, saved: true })
      void this.#drain()
      const transport = await this.options.receive(this.#current)
      if (!this.#current()) { transport.close(); return }
      this.#transport = transport
      this.#off = transport.subscribe([{ kinds: [1059], '#p': [this.options.account], since: this.#now() - WINDOW_SECONDS, limit: ORDINARY_MAX_COPIES }], event => this.#arrived(event), () => queueMicrotask(() => {
        if (!this.#current()) return
        this.#found = true
        const relays = transport.health?.().filter(relay => relay.read) ?? []
        const required = relays.filter(relay => relay.readEvidence === 'authentication-required').map(relay => relay.url)
        if (required.length && transport.authenticate?.(required, this.#current)) {
          this.#status = 'Checking the relays that require authentication…'
        } else if (required.length || relays.some(relay => relay.authentication === 'failed')) {
          this.#status = 'Some inbox relays require authentication. Messages from those relays could be missing.'
        } else if (relays.some(relay => relay.readEvidence !== 'confirmed')) {
          this.#status = 'Some inbox relays did not confirm their history. Messages from those relays could be missing.'
        } else if (!this.#status.startsWith('Some')) this.#status = ''
        this.#notify()
      }))
    } catch (error) {
      if (!this.#current()) return
      this.#status = error instanceof Error ? error.message : 'The Nostr inbox could not open.'
      this.#transport?.close(); this.#transport = undefined
      this.#notify()
    }
  }

  #arrived(input: Event): void {
    if (!this.#current() || this.#seen.has(input.id) || this.#queued.has(input.id)) return
    if (this.#queued.size >= 2 * ORDINARY_MAX_COPIES) {
      this.#status = 'Some encrypted copies are waiting on the relays. Refresh after this batch opens.'
      this.#notify(); return
    }
    const copy = captureOrdinaryCopy(input, this.options.account, this.#now())
    if (!copy) return
    this.#queued.set(copy.id, { copy, saved: false })
    void this.#drain()
  }

  async #drain(): Promise<void> {
    if (this.#draining || this.#signerNeedsAttention) return
    this.#draining = true
    try {
      while (this.#current() && this.#queued.size) {
        const accepted: Event[] = []
        for (const row of [...this.#queued.values()].slice(0, BATCH)) {
          if (!this.#current()) return
          this.#queued.delete(row.copy.id)
          this.#markSeen(row.copy.id)
          if (ordinaryExpired(row.copy, this.#now())) continue
          try {
            const decrypt: AccountMessageDecrypt = async (peer, ciphertext, current) => {
              try { return await this.options.decrypt(peer, ciphertext, current) }
              catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                if (/denied|reject|permission|not allowed|approval/i.test(message)) this.#signerNeedsAttention = true
                throw error
              }
            }
            const opened = await openAccountMessage(row.copy, this.options.account, decrypt, this.#current, this.options.blocked, () => this.#now())
            if (!this.#current()) return
            if (opened.kind === 'text' && opened.message.peer) {
              this.#remember(opened.message, row.copy)
              if (!row.saved) accepted.push(row.copy)
            }
            if (opened.kind === 'invitation' && opened.token.invitation.node && this.options.keepNodeInvitation) {
              if (!row.saved) accepted.push(row.copy)
              // An invitation may have to wait for the separate journal to
              // unlock. The text inbox can keep opening messages meanwhile.
              if (this.#savingInvitations < BATCH) {
                this.#savingInvitations++
                void this.options.keepNodeInvitation(opened.token, this.#current).catch(() => {
                  if (!this.#current()) return
                  this.#status = 'A private chat invitation could not be saved. Refresh to try again.'
                  this.#notify()
                }).finally(() => { this.#savingInvitations-- })
              } else this.#status = 'Some private invitations are waiting. Refresh when the invitation inbox is ready.'
            }
          } catch { /* An addressed wrap can contain unrelated or invalid data. */ }
          if (this.#signerNeedsAttention) break
        }
        if (accepted.length && this.#current()) {
          try {
            const release = await this.options.acquire(ordinaryHistoryKey(this.options.account))
            try {
              if (!this.#current()) return
              new OrdinaryMessageHistory(this.options.store, this.options.account, () => this.#now()).merge(accepted, this.#current)
            } finally { release() }
          } catch { if (this.#current()) this.#status = 'Some messages could not be saved on this device.' }
        }
        if (this.#found && this.#status.startsWith('Connecting')) this.#status = ''
        if (this.#signerNeedsAttention) this.#status = 'Allow Nostr inbox access in your signer, then refresh.'
        this.#notify()
        if (this.#signerNeedsAttention) break
      }
    } finally { this.#draining = false }
  }

  #remember(message: OrdinaryText, copy: Event): void {
    const previous = this.#messages.get(message.id)
    if (previous) {
      if (previous.copies.size < ORDINARY_MAX_COPIES || this.#read.has(copy.id)) previous.copies.add(copy.id)
      return
    }
    const expiration = Number(copy.tags.find(tag => tag[0] === 'expiration')?.[1]) || Infinity
    const expiresAt = Math.min(message.expiresAt ?? Infinity, expiration)
    this.#messages.set(message.id, { message, copies: new Set([copy.id]), ...(Number.isFinite(expiresAt) ? { expiresAt } : {}) })
    if (this.#messages.size > ORDINARY_MAX_COPIES) {
      const oldest = [...this.#messages.values()].sort((a, b) => a.message.sentAt - b.message.sentAt || a.message.id.localeCompare(b.message.id))[0]!
      this.#messages.delete(oldest.message.id)
      this.#status = 'Some older messages are outside the inbox’s recent history.'
    }
  }

  #markSeen(id: string): void {
    this.#seen.add(id)
    if (this.#seen.size > MAX_SEEN) this.#seen.delete(this.#seen.values().next().value!)
  }

  /** The explicit composer already has this signed-in account's clear text
   * and has saved its verified copy. Show it without asking to decrypt again. */
  recordOutgoing({ message, copy, status }: OrdinaryOutgoingMessage): void {
    if (!this.#current() || message.author !== this.options.account || !message.peer || this.options.blocked(message.peer)) return
    this.#updateSendStatus(copy.id, status)
    this.#queued.delete(copy.id)
    this.#markSeen(copy.id)
    this.#remember(message, copy)
    this.#notify()
  }

  #updateSendStatus(id: string, status: OrdinarySendStatus): void {
    const next = mergeSendStatus(this.#sendStatuses.get(id), status)
    this.#sendStatuses.delete(id)
    this.#sendStatuses.set(id, next)
    if (this.#sendStatuses.size > ORDINARY_MAX_COPIES) this.#sendStatuses.delete(this.#sendStatuses.keys().next().value!)
  }

  refreshSendStatuses(): void {
    if (!this.#current()) return
    for (const [id, status] of readOrdinarySendStatuses(this.options.store, this.options.account)) this.#updateSendStatus(id, status)
    this.#notify()
  }

  #storedRead(): Set<string> {
    const raw = this.options.store.get(peopleInboxReadKey(this.options.account))
    if (!raw || raw.length > MAX_SEEN * 67 + 2) return new Set()
    try {
      const value: unknown = JSON.parse(raw)
      return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && HEX.test(id)).slice(-MAX_SEEN) : [])
    } catch { return new Set() }
  }

  refreshRead(): void {
    if (!this.#current()) return
    try { this.#read = this.#storedRead() }
    catch { this.#status = 'The read position could not be loaded from this device.' }
    this.#notify()
  }

  /** Saves these messages as read on this device. `skipped` means nothing could be written yet
   *  (the inbox is closing, or their copies are not known); `refused` means the device would not take it. */
  async markRead(ids: ReadonlySet<string>): Promise<ReadOutcome> {
    const copies = [...ids].flatMap(id => [...(this.#messages.get(id)?.copies ?? [])])
    if (!copies.length || !this.#current()) return 'skipped'
    const key = peopleInboxReadKey(this.options.account)
    let outcome: ReadOutcome = 'saved'
    try {
      const release = await this.options.acquire(key)
      try {
        if (!this.#current()) return 'skipped'
        const next = [...new Set([...this.#storedRead(), ...copies])].slice(-MAX_SEEN)
        this.options.store.set(key, JSON.stringify(next))
        this.#read = new Set(next)
      } finally { release() }
    } catch {
      outcome = 'refused'
      if (this.#current()) this.#status = 'The latest read position could not be saved on this device.'
    }
    this.#notify()
    return outcome
  }

  close(): void {
    this.#closed = true
    clearTimeout(this.#timer)
    this.#off?.(); this.#off = undefined
    this.#transport?.close(); this.#transport = undefined
    this.#queued.clear(); this.#messages.clear(); this.#seen.clear(); this.#read.clear(); this.#sendStatuses.clear()
  }
}
