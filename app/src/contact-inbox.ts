import { base64 } from '@scure/base'
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils'
import type { Event } from 'nostr-tools/pure'
import { encryptEnvelope, decryptEnvelope } from '../../src/attachment.js'
import { contactInvitationRumor, readContactInvitation, isContactInvitationWrap, wrapContactInvitation,
  type ContactInvitation, type ContactInvitationIdentity, type ContactInvitationRumor } from '../../src/contact-invitation.js'
import { normaliseRelayConfig, type RelayTransport } from '../../src/relay-pool.js'
import type { DeviceStore } from './device-store.js'
import { openedInvitationRumor, type OpenedInvitation } from './nostr-opened-message.js'
import { parseNodeRoomLink } from '@forgesworn/fold-kit/node-room'

interface StoredInvitation { rumor: ContactInvitationRumor; dismissed: boolean }
interface Pending { outer: Event; recipient: string; peer: string; relays: string[]; invitation: string }
interface Journal { v: 1; invitations: StoredInvitation[]; pending: Pending[]; dismissed: string[] }
export interface ContactInboxSnapshot { ready: boolean; invitations: ContactInvitation[]; pending: { id: string; peer: string }[]; error?: string }
class ContactInboxError extends Error {}
const MAX_JOURNAL = 2 * 1024 * 1024
const enc = new TextEncoder(), dec = new TextDecoder()

/** Account-scoped invitation journal. Failed sends retain their exact signed
 * envelopes; relay acknowledgements, not UI optimism, clear the outbox. */
export class ContactInbox {
  readonly key: string
  #journal: Journal = { v: 1, invitations: [], pending: [], dismissed: [] }
  #key?: Uint8Array
  #sealedKey?: string
  #ready = false
  #closed = false
  #release?: () => void
  #tail: Promise<unknown> = Promise.resolve()
  #publishing = false
  #error?: string
  #head: string | null = null
  constructor(readonly options: {
    identity: ContactInvitationIdentity; store: DeviceStore
    acquire(key: string): Promise<() => void>
    pool(relays: string[]): RelayTransport
    current(): boolean; allowed(peer: string): boolean; blocked(peer: string): boolean
    publicInvitations?: { allowed(peer: string): boolean; relayAllowed(url: string): boolean; pool(relays: string[]): RelayTransport
      sender(current: () => boolean): ContactInvitationIdentity | undefined }
    changed(): void; now?: () => number
  }) { this.key = `kithmoot.contact-inbox.v1.${options.identity.pubkey}` }
  #now(): number { return (this.options.now ?? (() => Math.floor(Date.now() / 1000)))() }
  #current(): boolean { return !this.#closed && this.options.current() }
  #live(): void { if (!this.#current()) throw new ContactInboxError('Your account changed. Reopen Contacts.') }
  #serial<T>(fn: () => Promise<T>): Promise<T> { const task = this.#tail.then(fn); this.#tail = task.catch(() => {}); return task }
  snapshot(): ContactInboxSnapshot {
    const self = this.options.identity.pubkey
    return { ready: this.#ready && this.#current(), invitations: this.#journal.invitations.filter(entry => !entry.dismissed)
      .map(entry => readContactInvitation(entry.rumor, self, this.#now())).filter((entry): entry is ContactInvitation => !!entry)
      .filter(entry => !this.options.blocked(entry.sender === self ? entry.recipient : entry.sender)),
      pending: this.#journal.pending.map(entry => ({ id: entry.invitation, peer: entry.peer })), ...(this.#error ? { error: this.#error } : {}) }
  }
  async #save(next: Journal, current: () => boolean = () => true): Promise<void> {
    this.#live()
    if (!current()) throw new ContactInboxError('Invitation opening is no longer current.')
    if (this.options.store.get(this.key) !== this.#head) throw new ContactInboxError('Your invitation cache changed in another view. Reopen Contacts.')
    if (!this.#key || !this.#sealedKey) throw new ContactInboxError('Wait for your private inbox to open.')
    next = { ...next, dismissed: [...new Set([...next.dismissed, ...next.invitations.filter(entry => entry.dismissed).map(entry => entry.rumor.id)])].slice(-2048),
      invitations: next.invitations.filter(entry => !entry.dismissed) }
    const source = enc.encode(JSON.stringify(next))
    if (source.length > MAX_JOURNAL) throw new ContactInboxError('Your invitation inbox is full. Dismiss older invitations first.')
    const sealed = encryptEnvelope(source, { name: 'private-invitations.json', type: 'application/json' }, { key: this.#key, maxSourceBytes: MAX_JOURNAL })
    this.#live()
    if (!current()) throw new ContactInboxError('Invitation opening is no longer current.')
    if (this.options.store.get(this.key) !== this.#head) throw new ContactInboxError('Your invitation cache changed in another view. Reopen Contacts.')
    const saved = JSON.stringify({ v: 1, account: this.options.identity.pubkey, key: this.#sealedKey, body: base64.encode(sealed.envelope) })
    this.options.store.set(this.key, saved)
    this.#head = saved
    this.#journal = next
    this.options.changed()
  }
  async open(): Promise<void> {
    try {
      const release = await this.options.acquire(this.key)
      if (!this.#current()) { release(); return }
      this.#release = release
      const raw = this.options.store.get(this.key), self = this.options.identity.pubkey
      this.#head = raw
      if (raw) {
        if (raw.length > MAX_JOURNAL * 3) throw new ContactInboxError('Your invitation cache exceeds its limit.')
        const saved = JSON.parse(raw)
        if (saved.v !== 1 || saved.account !== self || typeof saved.key !== 'string' || saved.key.length > 4096 || typeof saved.body !== 'string') throw new ContactInboxError('Your invitation cache belongs to another account or format.')
        const key = await this.options.identity.decrypt(self, saved.key)
        this.#live()
        if (!/^[0-9a-f]{64}$/.test(key)) throw new ContactInboxError('Your invitation cache key is invalid.')
        this.#key = hexToBytes(key); this.#sealedKey = saved.key
        const source = decryptEnvelope(base64.decode(saved.body), key).source
        if (source.length > MAX_JOURNAL) throw new ContactInboxError('Your invitation cache exceeds its limit.')
        const journal = JSON.parse(dec.decode(source)) as Journal
        journal.dismissed ??= []
        if (journal.v !== 1 || !Array.isArray(journal.invitations) || journal.invitations.length > 256 || !Array.isArray(journal.pending) || journal.pending.length > 128
          || !Array.isArray(journal.dismissed) || journal.dismissed.length > 2048 || journal.dismissed.some(id => !/^[0-9a-f]{64}$/.test(id))
          || journal.invitations.some(entry => typeof entry.dismissed !== 'boolean' || !readContactInvitation(entry.rumor, self, this.#now()))
          || journal.pending.some(entry => !isContactInvitationWrap(entry.outer, entry.recipient, this.#now()) || !journal.invitations.some(invite => invite.rumor.id === entry.invitation && invite.rumor.pubkey === self)
            || !Array.isArray(entry.relays) || !entry.relays.length || entry.relays.length > 12 || !/^[0-9a-f]{64}$/.test(entry.peer)
            || !journal.invitations.some(invite => invite.rumor.id === entry.invitation && invite.rumor.tags[0]?.[1] === entry.peer && (entry.recipient === self || entry.recipient === entry.peer)))) throw new ContactInboxError('Your invitation cache failed validation.')
        for (const pending of journal.pending) normaliseRelayConfig(pending.relays)
        this.#journal = journal
      } else {
        this.#key = randomBytes(32)
        this.#sealedKey = await this.options.identity.encrypt(self, bytesToHex(this.#key))
        this.#live()
        await this.#save(this.#journal)
      }
      // Journal restoration is not permission to decrypt arriving wrappers.
      // Incoming text/invitations share the separate explicit account receiver.
      this.#live(); this.#ready = true
      this.options.changed()
    } catch (error) { this.#ready = false; this.#fail(error); this.#release?.(); this.#release = undefined }
  }
  async keepOpenedInvitation(token: OpenedInvitation, current: () => boolean): Promise<boolean> {
    return this.#serial(async () => {
      const self = this.options.identity.pubkey
      const bound = () => openedInvitationRumor(token, self, this.#now(), current)
      const live = () => {
        const rumor = bound()
        return this.#current() && this.#ready && !!rumor && !this.options.blocked(rumor.pubkey === self ? rumor.tags[0]![1]! : rumor.pubkey)
      }
      if (!live()) throw new ContactInboxError('This invitation is no longer available to keep.')
      const rumor = bound()!
      if (this.#journal.dismissed.includes(rumor.id)) return false
      if (this.#journal.invitations.some(entry => entry.rumor.id === rumor.id)) return true
      if (this.#journal.invitations.length >= 256) throw new ContactInboxError('Your invitation inbox is full. Dismiss older invitations first.')
      await this.#save({ ...this.#journal, invitations: [...this.#journal.invitations, { rumor, dismissed: false }] }, live)
      return true
    })
  }
  #fail(error: unknown): void {
    if (!this.#current()) return
    this.#error = error instanceof ContactInboxError ? error.message : 'Your private invitation could not be saved or delivered. Check your signer, storage and relays, then retry.'
    this.options.changed()
  }
  async enqueue(peer: string, room: string, link: string, peerRelays: string[], selfRelays: string[]): Promise<ContactInvitation> {
    return this.#serial(async () => {
      this.#live()
      const destinationRelays = normaliseRelayConfig(peerRelays).map(relay => relay.url)
      const senderRelays = normaliseRelayConfig(selfRelays).map(relay => relay.url)
      const self = this.options.identity.pubkey, now = this.#now()
      const rumor = contactInvitationRumor(self, peer, room, link, now)
      const invite = readContactInvitation(rumor, self, now)!
      const current = () => this.#current() && this.#ready && this.#canSend(invite, peer, destinationRelays) && this.#canSend(invite, peer, senderRelays)
      if (!current()) throw new ContactInboxError('This contact or their public inbox relays are unavailable.')
      const sender = invite.node ? this.options.publicInvitations?.sender(current) : this.options.identity
      if (!sender) throw new ContactInboxError('This signer cannot send an invitation through the public inbox.')
      const recipientWrap = await wrapContactInvitation(rumor, sender, peer, now, current)
      const selfWrap = await wrapContactInvitation(rumor, sender, self, now, current)
      if (!current()) throw new ContactInboxError('This contact permission changed before the invitation was saved.')
      if (this.#journal.invitations.length >= 256 || this.#journal.pending.length > 126) throw new ContactInboxError('Your invitation inbox is full.')
      await this.#save({ ...this.#journal, invitations: [...this.#journal.invitations, { rumor, dismissed: false }], pending: [...this.#journal.pending,
        { outer: recipientWrap, recipient: peer, peer, relays: destinationRelays, invitation: rumor.id },
        { outer: selfWrap, recipient: self, peer, relays: senderRelays, invitation: rumor.id }] }, current)
      return invite
    })
  }
  #canSend(invite: ContactInvitation, peer: string, relays: string[]): boolean {
    if (!invite.node) return this.options.allowed(peer)
    const carrier = this.options.publicInvitations
    const node = parseNodeRoomLink(invite.link, this.#now())
    return !!node && !!carrier?.allowed(peer) && relays.length > 0 && relays.every(url => url !== node.relay && carrier.relayAllowed(url))
  }
  async retry(): Promise<void> {
    if (this.#publishing || !this.#ready || !this.#current()) return
    this.#publishing = true
    try {
      for (const pending of [...this.#journal.pending]) {
        const rumor = this.#journal.invitations.find(entry => entry.rumor.id === pending.invitation)?.rumor
        const invite = readContactInvitation(rumor, this.options.identity.pubkey, this.#now())
        if (!invite) continue
        const current = () => this.#current() && this.#canSend(invite, pending.peer, pending.relays)
          && this.#journal.pending.some(entry => entry.outer.id === pending.outer.id)
        if (!current()) continue
        const pool = invite.node ? this.options.publicInvitations!.pool(pending.relays) : this.options.pool(pending.relays)
        try {
          if (!pool.publishGuarded) throw new ContactInboxError('This relay connection cannot safely send private invitations.')
          await pool.publishGuarded(pending.outer, current)
          await this.#serial(async () => {
            this.#live()
            await this.#save({ ...this.#journal, pending: this.#journal.pending.filter(entry => entry.outer.id !== pending.outer.id) })
          })
        } finally { pool.close() }
      }
      this.#error = undefined
    } catch (error) { this.#fail(error) }
    finally { this.#publishing = false; if (this.#current()) this.options.changed() }
  }
  async dismiss(id: string): Promise<void> {
    await this.#serial(async () => {
      if (this.#journal.pending.some(entry => entry.invitation === id)) throw new ContactInboxError('Retry the pending invitation before dismissing it.')
      await this.#save({ ...this.#journal, invitations: this.#journal.invitations.map(entry => entry.rumor.id === id ? { ...entry, dismissed: true } : entry) })
    })
  }
  async forgetRoom(room: string): Promise<void> {
    await this.#serial(async () => {
      const removed = new Set(this.#journal.invitations.filter(entry => entry.rumor.tags[1]?.[2] === room).map(entry => entry.rumor.id))
      if (!removed.size) return
      await this.#save({ ...this.#journal, invitations: this.#journal.invitations.map(entry => removed.has(entry.rumor.id) ? { ...entry, dismissed: true } : entry),
        pending: this.#journal.pending.filter(entry => !removed.has(entry.invitation)) })
    })
  }
  close(): void {
    this.#closed = true; this.#ready = false
    // Hold the writer fence until delayed operations observe cancellation.
    void this.#tail.finally(() => { this.#key?.fill(0); this.#key = undefined; this.#release?.(); this.#release = undefined })
  }
}
