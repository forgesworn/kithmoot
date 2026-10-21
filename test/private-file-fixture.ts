import { finalizeEvent, getPublicKey, type EventTemplate } from 'nostr-tools/pure'
import { vi } from 'vitest'
import { BrowserBothyFiles, type PrivateFileContext, type PrivateFileOwner } from '../app/src/browser-bothy-files.js'
import { PrivateFileVault } from '../app/src/private-file-vault.js'
import type { EncryptedRendezvousRecord, RendezvousVaultStorage } from '../app/src/rendezvous-vault.js'
import type { RoomConsent } from '../app/src/browser-room-consent.js'
import type { LinkRequest, LinkResponse } from '../app/src/browser-link-types.js'
import { Nip07Signer } from 'signet-login'
import { signetFixtureSession } from './signet-session-fixture.js'
import { nostrEventSigner } from '../app/src/nostr-message-signer.js'

export const node = 'ugq2dinbugq2dinbugq2dinbugq2dinbugq2dinbugq2dinbugqq'
export const otherNode = 'a'.repeat(52)
export const room = 'a'.repeat(64), device = 'b'.repeat(64)
export const hash = 'cd'.repeat(32)
export const accountKey = new Uint8Array(32).fill(7)
export const account = getPublicKey(accountKey)
export const scope = { account, room, node, routeId: 'selected-route' }
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export class FileStorage implements RendezvousVaultStorage {
  storedKey?: CryptoKey
  value?: EncryptedRendezvousRecord
  nonce = ''
  fail = false
  beforePut?: () => Promise<void>
  #queue = Promise.resolve()
  revision(): string { return this.nonce }
  invalidate(): void { this.nonce = crypto.randomUUID() }
  withLock<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work)
    this.#queue = result.then(() => {}, () => {})
    return result
  }
  async key(): Promise<CryptoKey | undefined> { return this.storedKey }
  async saveKey(key: CryptoKey): Promise<void> { this.storedKey = key }
  async record(): Promise<EncryptedRendezvousRecord | undefined> { return this.value && structuredClone(this.value) }
  async put(value: EncryptedRendezvousRecord): Promise<void> {
    await this.beforePut?.()
    if (this.fail) throw new Error('disk full')
    this.value = structuredClone(value)
  }
  async remove(): Promise<void> { this.value = undefined }
  async erase(): Promise<void> { this.value = undefined; this.storedKey = undefined; this.nonce = '' }
}
export function fileFixture() {
  let now = 1000, context: PrivateFileContext | undefined
  const identity = { pubkey: account, signEvent: vi.fn(async (event: EventTemplate) => finalizeEvent(event, accountKey)) }
  const signer = new Nip07Signer(account, { getPublicKey: async () => account,
    signEvent: identity.signEvent, nip44: { encrypt: async () => 'unused', decrypt: async () => 'unused' } })
  const session = signetFixtureSession(signer, accountKey)
  let owner: PrivateFileOwner | undefined = {identity:signer,generation:1}
  context = { room, device, participant: account, generation: 1, identity: signer }
  let selected: RoomConsent | undefined = { account, room, device, box: { routeId: scope.routeId, eventUrl: `ws://${node}/events` }, scopes: [room], aliases: [], grants: [], expires: 2000, phase: 'active' }
  let paired = true, leased = false
  const pairedBox = structuredClone(selected.box)
  const storage = new FileStorage(), vault = new PrivateFileVault(storage), blobs = new Map<string, Uint8Array>()
  const response = (body: Uint8Array, status = 200): LinkResponse => ({ status, body, witnessRefused: false, path: { status: 'relayed', relay: 'fixture', direct: null, cause: 'test' } })
  const reply = (value: unknown): LinkResponse => response(new TextEncoder().encode(JSON.stringify(value)))
  const request = vi.fn(async (r: LinkRequest): Promise<LinkResponse> => {
    if (!leased) throw new Error('route lock was not held')
    if (r.method === 'PUT') {
      const intent = (await vault.uploads(account, room)).at(-1)
      if (!intent || intent.status !== 'uncertain') throw new Error('network dispatch preceded durable intent')
      blobs.set(intent.hash, r.body.slice())
      return reply({ sha256: intent.hash, size: r.body.length, url: 'https://untrusted.invalid/redirect' })
    }
    if (r.method === 'GET') return blobs.has(r.path.slice(1)) ? response(blobs.get(r.path.slice(1))!.slice()) : response(new Uint8Array(),404)
    if (!blobs.has(r.path.slice(1))) return response(new Uint8Array(),404)
    return reply({ sha256: r.path.slice(1), blobDeleted: blobs.delete(r.path.slice(1)) })
  })
  const release = vi.fn(async () => { leased = false })
  const lease = vi.fn(async (_room: string, signal: AbortSignal) => { signal.throwIfAborted(); leased = true; return release })
  const controller = new BrowserBothyFiles({ current: () => context, owner: () => owner, selected: async () => selected, link: { boxes: () => paired ? [pairedBox] : [], request }, vault, now: () => now, lease,
    signer: expected => expected === signer ? nostrEventSigner(session, () => owner?.identity === signer ? session : undefined) : undefined })
  const file = new File(['private content: unchanged after decryption'], 'private.txt', { type: 'text/plain' })
  return { controller, vault, storage, identity, request, lease, release, file, blobs, reply,
    get owner() { return owner }, set owner(value: PrivateFileOwner | undefined) { owner = value },
    get context() { return context }, set context(value: PrivateFileContext | undefined) { context = value },
    get selected() { return selected }, set selected(value: RoomConsent | undefined) { selected = value },
    set paired(value: boolean) { paired = value }, advance: (seconds: number) => { now += seconds } }
}
