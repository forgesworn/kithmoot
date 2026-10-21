import type { Event, EventTemplate } from 'nostr-tools/pure'
import type { ParticipantIdentity } from '../../src/identity.js'
import { verifyEventUncached } from '../../src/verify.js'
import { normaliseAttachment, type ChatAttachment } from '../../src/chat.js'
import { privateAttachmentLocation, privateAttachmentUrl } from '../../src/private-attachment.js'
import { encryptEnvelopeBlob, decryptEnvelopeBlob, sha256Hex, encodeBlossomAuthorisation, type DecryptedEnvelopeBlob } from '../../src/attachment.js'
import type { BrowserLink } from './browser-link.js'
import { validateConsent, type RoomConsent } from './browser-room-consent.js'
import { PrivateFileVault, sameFileScope, type PrivateFileScope, type PrivateFileTicket, type PrivateFileUpload } from './private-file-vault.js'
import type { NostrMessageIdentity } from './nostr-message.js'

export const MAX_PRIVATE_FILE_BYTES = 64 * 1024 * 1024
export interface PrivateFileContext {
  room: string; generation: number; device: string; participant: string
  identity: ParticipantIdentity; endsAt?: number
}
export interface PrivateFileOwner { identity: ParticipantIdentity; generation: number }
export type PrivateFileRemoval = 'deleted' | 'claim-removed' | 'absent'
interface Options {
  current: () => PrivateFileContext | undefined
  owner: () => PrivateFileOwner | undefined
  selected: (room: string) => Promise<RoomConsent | undefined>
  link: Pick<BrowserLink, 'boxes' | 'request'>
  vault: PrivateFileVault
  signer: (identity: ParticipantIdentity) => Pick<NostrMessageIdentity, 'pubkey' | 'signEvent'> | undefined
  now?: () => number
  lease?: (room: string, signal: AbortSignal) => Promise<() => Promise<void>>
}
interface Authority { context: PrivateFileContext; scope: PrivateFileScope; until: number }
interface Operation extends Authority { ticket: PrivateFileTicket }
const empty = new Uint8Array()
const hold = (): Error => new Error('This room, account or private file permission changed. The file stays held.')

/** Share the existing activation lock: route changes cannot replace the
 * selected box between the last authority read and the request's dispatch. */
export async function privateFileRouteLease(room: string, signal: AbortSignal): Promise<() => Promise<void>> {
  if (!navigator.locks) throw new Error('Private files need Web Locks.')
  let release!: () => void, acquired!: () => void, failed!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => { acquired = resolve; failed = reject })
  const held = navigator.locks.request(`kithmoot.room-activation.${room}`, { mode: 'shared', signal }, async () => {
    await new Promise<void>(resolve => { release = resolve; acquired() })
  })
  void held.catch(failed)
  await ready
  return async () => { release(); await held }
}

/** App integration over the existing encryption and pinned Link request API.
 * No fetch, resolver, public announcement or replacement transport exists here.
 * Pairing permits box-wide ciphertext reads; the room message carries its key.
 * This does not treat storage writes or room consent as MLS membership. */
export class BrowserBothyFiles {
  constructor(private options: Options) {}
  async allow(signal: AbortSignal = new AbortController().signal): Promise<void> {
    await this.#leased(signal, true, async context => {
      const authority = await this.#authority(context)
      const current = (): void => {
        signal.throwIfAborted(); this.#context(authority.context); this.#paired(authority.scope)
        if (authority.until <= this.#now() || !this.options.signer(context.identity)) throw hold()
      }
      current()
      await this.options.vault.allow(authority.scope, authority.until, current)
      current()
    })
  }
  async revoke(): Promise<void> {
    const context = this.#capture()
    await this.options.vault.revoke(context.identity.pubkey, context.room)
    this.#context(context)
  }
  async enabled(): Promise<boolean> {
    const a = await this.#authority()
    if (!this.options.signer(a.context.identity)) throw new Error('Private file approvals currently need a supported browser extension signer.')
    const ticket = await this.options.vault.permission(a.scope, this.#now())
    this.#context(a.context)
    return !!ticket
  }
  async upload(file: File, signal: AbortSignal): Promise<ChatAttachment> {
    return this.#leased(signal, true, context => this.#upload(file, signal, context))
  }
  async #upload(file: File, signal: AbortSignal, context: PrivateFileContext): Promise<ChatAttachment> {
    const operation = await this.#operation(signal, context)
    if (!file.size || file.size > MAX_PRIVATE_FILE_BYTES) throw new Error('Choose a non-empty file that fits within 64 MiB after encryption.')
    const sealed = await encryptEnvelopeBlob(file, { name: file.name, type: file.type }, { maxSourceBytes: MAX_PRIVATE_FILE_BYTES })
    try {
      await this.#guard(operation, signal)
      if (sealed.envelope.size > MAX_PRIVATE_FILE_BYTES) throw new Error('This file is larger than 64 MiB after encryption. Nothing was uploaded.')
      const body = new Uint8Array(await sealed.envelope.arrayBuffer())
      try {
        await this.#guard(operation, signal)
        const signed = await this.#sign(operation.context, operation.scope, 'upload', sealed.sha256, () => this.#live(operation, signal), operation.until)
        await this.#guard(operation, signal)
        const receipt = await this.options.vault.intent(operation.ticket, sealed.sha256, body.length, this.#now())
        await this.#guard(operation, signal)
        this.#live(operation, signal)
        this.#unexpired(signed)
        // A lost reply is uncertain; do not automatically retry this write.
        const reply = await this.options.link.request({ routeId: operation.scope.routeId, method: 'PUT', path: '/upload', authorization: encodeBlossomAuthorisation(signed), body })
        if (reply.status !== 200 && reply.status !== 201) throw new Error(`The selected Bothy refused the upload (${reply.status}). The upload record was retained.`)
        const descriptor = this.#json(reply.body)
        if (!descriptor || descriptor.sha256 !== sealed.sha256 || descriptor.size !== body.length) throw new Error('The Bothy upload result did not match this file; its uncertain record was retained.')
        // Ignore the server URL. In particular, never follow its loopback URL.
        await this.options.vault.outcome(receipt, 'stored')
        await this.#guard(operation, signal)
        return { url: privateAttachmentUrl(operation.scope.node, sealed.sha256), sha256: sealed.sha256,
          key: sealed.key, name: sealed.name, type: sealed.type, size: body.length }
      } finally { body.fill(0) }
    } finally { await sealed.dispose?.() }
  }
  async download(input: ChatAttachment, signal: AbortSignal): Promise<DecryptedEnvelopeBlob> {
    const captured = structuredClone(input)
    return this.#leased(signal, true, context => this.#download(captured, signal, context))
  }
  async #download(input: ChatAttachment, signal: AbortSignal, context: PrivateFileContext): Promise<DecryptedEnvelopeBlob> {
    const attachment = normaliseAttachment(structuredClone(input))
    if (!attachment) throw new Error('Invalid private file reference.')
    const location = privateAttachmentLocation(attachment.url, attachment.sha256)
    if (!location || !Number.isSafeInteger(attachment.size) || !attachment.size || attachment.size > MAX_PRIVATE_FILE_BYTES) throw new Error('This is not a bounded private file reference.')
    const operation = await this.#operation(signal, context)
    if (location.node !== operation.scope.node) throw new Error('This file belongs to a different Bothy. No other destination was contacted.')
    await this.#guard(operation, signal)
    this.#live(operation, signal)
    const reply = await this.options.link.request({ routeId: operation.scope.routeId, method: 'GET', path: `/${location.hash}`, authorization: '', body: empty })
    await this.#guard(operation, signal)
    if (reply.status !== 200) throw new Error(`The selected Bothy refused the download (${reply.status}).`)
    if (reply.body.length !== attachment.size || reply.body.length > MAX_PRIVATE_FILE_BYTES || sha256Hex(reply.body) !== location.hash) throw new Error('The download is not the encrypted file this message named.')
    const bytes = reply.body.slice()
    try {
      const file = await decryptEnvelopeBlob(new Blob([bytes.buffer]), attachment.key)
      await this.#guard(operation, signal)
      return file
    } finally { bytes.fill(0) }
  }
  async uploads(): Promise<PrivateFileUpload[]> {
    const context = this.#capture()
    const rows = await this.options.vault.uploads(context.identity.pubkey, context.room)
    this.#context(context); return rows
  }
  /** Explicit owner cleanup can remove a recorded upload after local file
   * consent or the room expired. It requires the exact recorded paired box
   * and current signing account, never discovery or a substitute destination. */
  async remove(input: PrivateFileUpload, signal: AbortSignal): Promise<PrivateFileRemoval> {
    const captured = structuredClone(input)
    const owner = this.options.owner()
    if (!owner || captured.account !== owner.identity.pubkey || !/^[0-9a-f]{64}$/.test(captured.room)) throw hold()
    const context = { ...owner }
    return this.#routeLease(captured.room, signal, () => this.#owner(context), () => this.#remove(captured, signal, context))
  }
  async #remove(receipt: PrivateFileUpload, signal: AbortSignal, context: PrivateFileOwner): Promise<PrivateFileRemoval> {
    if (receipt.account !== context.identity.pubkey) throw hold()
    const rows = await this.options.vault.uploads(receipt.account, receipt.room)
    this.#owner(context)
    const saved = rows.find(row => row.id === receipt.id)
    if (!saved || JSON.stringify(saved) !== JSON.stringify(receipt)) throw new Error('The recorded private file changed; nothing was deleted.')
    const check = (): void => {
      signal.throwIfAborted(); this.#owner(context)
      // Withdrawal removes room delivery authority, not the owner's right
      // to clean up their exact recorded upload on an already paired box.
      this.#paired(receipt)
    }
    check()
    const signed = await this.#sign(context, receipt, 'delete', receipt.hash, check)
    check(); this.#unexpired(signed)
    const reply = await this.options.link.request({ routeId: receipt.routeId, method: 'DELETE', path: `/${receipt.hash}`, authorization: encodeBlossomAuthorisation(signed), body: empty })
    check()
    if (reply.status === 404) {
      // The first DELETE may have committed before its acknowledgement was
      // lost. Confirm reported absence through the same recorded Full pair;
      // neither a failed delete nor a generic refusal establishes absence.
      const read = await this.options.link.request({ routeId: receipt.routeId, method: 'GET', path: `/${receipt.hash}`, authorization: '', body: empty })
      check()
      if (read.status !== 404) throw new Error('The recorded Bothy did not confirm this file’s absence. Its upload record stays.')
      await this.options.vault.outcome(receipt, 'deleted')
      this.#owner(context)
      return 'absent'
    }
    if (reply.status !== 200) throw new Error(`The selected Bothy refused file deletion (${reply.status}). Its record was retained.`)
    const result = this.#json(reply.body)
    if (!result || result.sha256 !== receipt.hash || typeof result.blobDeleted !== 'boolean') throw new Error('The Bothy deletion result could not be verified; its record was retained.')
    // Shelter's 200/false means our claim was removed successfully while
    // other owners retain the blob; repeating our DELETE would return 403.
    const status = result.blobDeleted ? 'deleted' : 'claim-removed'
    await this.options.vault.outcome(receipt, 'deleted')
    this.#owner(context)
    return status
  }
  async #leased<T>(signal: AbortSignal, live: boolean, work: (context: PrivateFileContext) => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    const context = this.#capture(live)
    return this.#routeLease(context.room, signal, () => this.#context(context, live), () => work(context))
  }
  async #routeLease<T>(room: string, signal: AbortSignal, current: () => void, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted(); current()
    const release = await (this.options.lease ?? privateFileRouteLease)(room, signal)
    let aborted!: () => void
    try {
      signal.throwIfAborted(); current()
      const cancelled = new Promise<never>((_, reject) => {
        aborted = () => reject(signal.reason)
        signal.addEventListener('abort', aborted, { once: true })
      })
      // A signer or already dispatched upload may finish late. All remaining
      // effects are guarded, and upload intent was saved before dispatch.
      // Cancellation must not hold a room's activation lock indefinitely.
      return await Promise.race([work(), cancelled])
    } finally {
      if (aborted) signal.removeEventListener('abort', aborted)
      await release()
    }
  }
  #owner(expected: PrivateFileOwner): void {
    const actual = this.options.owner()
    if (!actual || actual.identity !== expected.identity || actual.generation !== expected.generation || actual.identity.pubkey !== expected.identity.pubkey) throw hold()
  }
  #capture(requireLiveRoom = true): PrivateFileContext {
    const current = this.options.current()
    if (!current || current.participant !== current.identity.pubkey || !/^[0-9a-f]{64}$/.test(current.room) || !/^[0-9a-f]{64}$/.test(current.device)) throw new Error('Open this room as its signed-in account before using private files.')
    const context = { ...current }
    this.#context(context, requireLiveRoom); return context
  }
  #context(expected: PrivateFileContext, requireLiveRoom = true): void {
    const actual = this.options.current()
    if (!actual || actual.room !== expected.room || actual.generation !== expected.generation || actual.device !== expected.device || actual.participant !== expected.participant || actual.identity !== expected.identity || actual.identity.pubkey !== expected.participant || actual.endsAt !== expected.endsAt) throw hold()
    if (requireLiveRoom && expected.endsAt !== undefined && expected.endsAt <= this.#now()) throw new Error('This room has ended. Private file access is held.')
  }
  async #authority(context = this.#capture()): Promise<Authority> {
    const selection = structuredClone(await this.options.selected(context.room))
    this.#context(context)
    if (!selection) throw new Error('Select this room’s Bothy before using private files.')
    validateConsent(selection)
    if (selection.phase !== 'active' || selection.account !== context.identity.pubkey || selection.room !== context.room || selection.device !== context.device || selection.expires <= this.#now()) throw hold()
    const node = /^ws:\/\/([a-z2-7]{51}[aq])\/events$/.exec(selection.box.eventUrl)?.[1]
    if (!node) throw new Error('The selected Bothy is not a canonical paired node.')
    const scope = { account: selection.account, room: selection.room, routeId: selection.box.routeId, node }
    this.#paired(scope)
    return { context, scope, until: Math.min(selection.expires, context.endsAt ?? selection.expires) }
  }
  async #operation(signal: AbortSignal, context: PrivateFileContext): Promise<Operation> {
    signal.throwIfAborted()
    const authority = await this.#authority(context)
    const ticket = await this.options.vault.permission(authority.scope, this.#now())
    this.#context(authority.context); signal.throwIfAborted()
    if (!ticket) throw new Error('Allow encrypted files on this room’s selected Bothy first.')
    const operation = { ...authority, ticket }
    await this.#guard(operation, signal); return operation
  }
  async #guard(operation: Operation, signal: AbortSignal): Promise<void> {
    this.#live(operation, signal)
    const authority = await this.#authority(operation.context)
    this.#live(operation, signal)
    if (!sameFileScope(authority.scope, operation.scope) || authority.until !== operation.until || !await this.options.vault.current(operation.ticket, this.#now())) throw hold()
    this.#live(operation, signal)
  }
  #live(operation: Operation, signal: AbortSignal): void {
    signal.throwIfAborted(); this.#context(operation.context); this.#paired(operation.scope)
    if (operation.ticket.revision !== this.options.vault.revision() || operation.ticket.until <= this.#now() || operation.until <= this.#now()) throw hold()
  }
  #paired(scope: PrivateFileScope): void {
    if (!this.options.link.boxes().some(box => box.routeId === scope.routeId && box.eventUrl === `ws://${scope.node}/events`)) throw new Error('Connect this room’s selected Bothy. No other route was used.')
  }
  async #sign(context: Pick<PrivateFileContext, 'identity'>, scope: PrivateFileScope, action: 'upload' | 'delete', hash: string, current: () => void, until?: number): Promise<Event> {
    const now = this.#now(), created = Math.max(0, now - 1)
    const expires = Math.min(created + 90, until ?? created + 90)
    if (!/^[0-9a-f]{64}$/.test(hash) || expires <= now) throw hold()
    const template: EventTemplate = { kind: 24242, created_at: created, tags: [['t', action], ['expiration', String(expires)], ['server', scope.node], ['x', hash]], content: `${action === 'upload' ? 'Upload' : 'Delete'} blob ${hash}` }
    current()
    const signer = this.options.signer(context.identity)
    if (!signer || signer.pubkey !== scope.account) throw new Error('Private file approvals currently need a supported browser extension signer.')
    const live = (): boolean => {
      current()
      if (expires <= this.#now()) throw new Error('File approval expired. Review the operation again.')
      return true
    }
    const signed: Event = JSON.parse(JSON.stringify(await signer.signEvent(structuredClone(template), live)))
    current()
    if (signed.pubkey !== scope.account || signed.kind !== template.kind || signed.created_at !== template.created_at || signed.content !== template.content || JSON.stringify(signed.tags) !== JSON.stringify(template.tags) || !verifyEventUncached(signed)) throw new Error('The signer did not approve this exact private file operation.')
    this.#unexpired(signed); return signed
  }
  #unexpired(signed: Event): void {
    if (Number(signed.tags.find(t => t[0] === 'expiration')?.[1]) <= this.#now()) throw new Error('File approval expired. Review the operation again.')
  }
  #now(): number {
    const n = this.options.now?.() ?? Math.floor(Date.now() / 1000)
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('Private files need a valid clock.')
    return n
  }
  #json(bytes: Uint8Array): Record<string, unknown> | undefined {
    if (bytes.length > 64 * 1024) return undefined
    try {
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
    } catch { return undefined }
  }
}
