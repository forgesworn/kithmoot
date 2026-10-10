import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import type { LinkEngine, LinkRequest, LinkRoute } from './browser-link-types.js'
import type { CoordinatedMlsVault } from './mls-coordinated-vault.js'
import { base64Decode, base64Encode, type ConsentPrompt, type VaultContext, type VaultRefusal } from './mls-vault.js'
import { pairedWitnessIdentity } from './mls-writer-identity.js'
import { loadMlsEngine } from './mls-engine.js'

const HEX = /^[0-9a-f]{64}(?![\s\S])/
const CURSOR = /^[A-Za-z0-9+/=_-]{1,1024}(?![\s\S])/
export const MAX_MLS_ENVELOPE = 44 + 1_048_576
const MAX_JSON = 128 * 1024, MAX_FETCH = 2 * 1024 * 1024
const REFUSALS: Record<string, number> = {
  envelope: 400, cursor: 400, invalid: 400, path: 400, body: 400, authentication: 401, replay: 401,
  authority: 403, 'not-found': 404, conflict: 409, consumed: 409, expired: 410, withdrawn: 410,
  'body-too-large': 413, 'content-type': 415, busy: 429, 'rate-limited': 429, internal: 500,
  pending: 503, 'clock-unsafe': 503, 'restore-fenced': 503, disabled: 503,
  'quota-grant': 507, 'quota-mailbox': 507, 'quota-packages': 507, 'quota-slots': 507, full: 507,
}
const encoder = new TextEncoder()
export type BoxAnswer<T> =
  | { state: 'ok'; value: T; serverTime: number | null }
  | { state: 'refused'; status: number; code: string | null; serverTime: number | null }
  | { state: 'not-signed'; reason: VaultRefusal }
  | { state: 'unavailable' | 'malformed' }
export interface Deposited { duplicate: boolean; receipt: Uint8Array; welcomeAcknowledged: boolean | null }
export interface SlotDeposited { outcome: 'won' | 'duplicate' | 'taken'; attempt: number; receipt: Uint8Array; signedReceipt: Uint8Array | null }
export interface SlotState { state: 'empty' | 'filled' | 'expired' | 'void'; attempt?: number; receipt?: Uint8Array; signedReceipt?: Uint8Array; envelope?: Uint8Array }
export interface FetchRecord { mailbox: Uint8Array; receipt: Uint8Array; envelope: Uint8Array }
export interface AckItem { mailbox: Uint8Array; receipt: Uint8Array }
type Signer = Pick<CoordinatedMlsVault, 'signBoxRequestV1' | 'acceptBoxReply' | 'current'>
type Json = Record<string, unknown>

/** Development-only, strict Bothy client. The caller owns the Link engine and
 * must keep this verified paired route installed, invalidate before replacing
 * it, and await endpoint shutdown on account/privacy changes. Never borrow the
 * dedicated witness endpoint outside its persona lock. No constructor I/O.
 * This client verifies wire facts; the driver must compare capabilities
 * on open/replies and feed signed slot labels to the engine before acting. */
export class BrowserMlsBoxClient {
  readonly box!: string
  readonly #routeId: string
  readonly #context: VaultContext
  #epoch = 0
  #pending = new Set<() => void>()
  #occupied = 0
  constructor(private readonly transport: Pick<LinkEngine, 'request'>, route: LinkRoute, expectedBox: string,
    private readonly vault: Signer, context: VaultContext, private readonly consent: ConsentPrompt,
    private readonly current: () => boolean, private readonly timeoutMs = 20_000) {
    if (!HEX.test(expectedBox) || !/^[A-Za-z0-9._:-]{1,128}(?![\s\S])/.test(route.routeId) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid MLS box route.')
    const actual = pairedWitnessIdentity({ routeId: route.routeId, card: bytesToHex(route.card), cardSerial: String(route.cardSerial),
      cardVerifiedAt: String(route.cardVerifiedAt), pairedRouteSecret: '', relayUrls: [] })
    if (actual !== expectedBox) throw new Error('MLS box and paired Link identity differ.')
    Object.defineProperty(this, 'box', { value: actual, enumerable: true })
    this.#routeId = route.routeId; this.#context = Object.freeze({ ...context })
  }
  /** Suppress and wake pending work. A dispatched request may have committed;
   * its durable outbox must survive for fresh-authentication reconciliation. */
  invalidate(): void { this.#epoch++; for (const cancel of this.#pending) cancel() }

  /** Current account/privacy scope, also used by the owner of a round. */
  isCurrent(): boolean { return this.current() && this.vault.current(this.#context) }

  /** Compare immutable constructor bindings before a caller trusts this route. */
  usesBinding(routeId: string, box: string, context: VaultContext): boolean {
    return routeId === this.#routeId && box === this.box && JSON.stringify(context) === JSON.stringify(this.#context)
  }

  capabilities(current: () => boolean = () => true): Promise<BoxAnswer<{ installation: string }>> {
    return this.#request('GET', '/vmls/v1/capabilities', new Uint8Array(), MAX_JSON, async (status, raw) => {
      if (status !== 200) return undefined
      const wasm = await loadMlsEngine()
      try { return { value: { installation: bytesToHex(wasm.parseCapabilities(raw)) }, serverTime: null } }
      catch { return undefined }
    }, current)
  }
  deposit(mailbox: Uint8Array, envelope: Uint8Array, current: () => boolean = () => true): Promise<BoxAnswer<Deposited>> {
    const id = idOf(mailbox); envelope = bounded(envelope, MAX_MLS_ENVELOPE)
    const hash = bytesToHex(sha256(envelope))
    return this.#request('PUT', `/vmls/v1/mailboxes/${id}/records`, envelope, MAX_JSON, (status, raw) => {
      const a = answer(raw, ['receipt'], ['welcome'])
      if (!a || !((status === 201 && a.code === 'stored') || (status === 200 && a.code === 'duplicate')) || a.receipt !== hash) return
      let welcomeAcknowledged: boolean | null = null
      if ('welcome' in a) {
        if (!object(a.welcome) || !keys(a.welcome, ['acknowledged']) || typeof a.welcome.acknowledged !== 'boolean') return
        welcomeAcknowledged = a.welcome.acknowledged
      }
      return parsed(a, { duplicate: a.code === 'duplicate', receipt: hexToBytes(hash), welcomeAcknowledged })
    }, current)
  }
  depositSlot(slot: Uint8Array, attempt: number, envelope: Uint8Array, current: () => boolean = () => true): Promise<BoxAnswer<SlotDeposited>> {
    const id = idOf(slot); uint(attempt, 0xffff_ffff); envelope = bounded(envelope, MAX_MLS_ENVELOPE)
    const hash = bytesToHex(sha256(envelope))
    return this.#request('PUT', `/vmls/v1/slots/${id}/${attempt}`, envelope, MAX_JSON, (status, raw) => {
      const a = answer(raw, ['receipt', 'attempt'], ['signed_receipt'])
      if (!a || !((status === 201 && a.code === 'won') || (status === 200 && a.code === 'duplicate') || (status === 409 && a.code === 'taken')) ||
        !isUint(a.attempt, 0xffff_ffff) || !isId(a.receipt)) return
      if (a.code !== 'taken' && (a.attempt !== attempt || a.receipt !== hash)) return
      const signed = 'signed_receipt' in a ? binary(a.signed_receipt, 197) : null
      if ('signed_receipt' in a && (!signed || !this.#receipt(signed, id, a.attempt, a.receipt))) return
      return parsed(a, { outcome: a.code as SlotDeposited['outcome'], attempt: a.attempt, receipt: hexToBytes(a.receipt), signedReceipt: signed ?? null })
    }, current)
  }
  slotStatus(slot: Uint8Array, attempt: number, current: () => boolean = () => true): Promise<BoxAnswer<SlotState>> {
    const id = idOf(slot); uint(attempt, 0xffff_ffff)
    return this.#request<SlotState>('POST', `/vmls/v1/slots/${id}/${attempt}/status`, json({ v: 1 }), MAX_FETCH, (status, raw) => {
      if (status !== 200) return
      const a = answer(raw, [], ['receipt', 'attempt', 'signed_receipt', 'envelope'])
      if (!a) return
      if (a.code === 'empty') return keys(a, ['v', 'code', 'server_time']) ? parsed(a, { state: 'empty' as const }) : undefined
      if (!['filled', 'expired', 'void'].includes(a.code) || !isUint(a.attempt, 0xffff_ffff) || !isId(a.receipt) ||
        (a.code === 'void') === (a.attempt === attempt)) return
      const signed = binary(a.signed_receipt, 197)
      if (!signed || !this.#receipt(signed, id, a.attempt, a.receipt)) return
      let envelope: Uint8Array | undefined
      if (a.code === 'filled') {
        envelope = binary(a.envelope, MAX_MLS_ENVELOPE)
        if (!envelope || bytesToHex(sha256(envelope)) !== a.receipt) return
      } else if ('envelope' in a) return
      return parsed(a, { state: a.code as SlotState['state'], attempt: a.attempt, receipt: hexToBytes(a.receipt), signedReceipt: signed, ...(envelope ? { envelope } : {}) })
    }, current)
  }
  fetch(mailboxes: readonly Uint8Array[], after?: string, current: () => boolean = () => true): Promise<BoxAnswer<{ records: FetchRecord[]; next: string | null }>> {
    if (mailboxes.length < 1 || mailboxes.length > 16) throw new Error('Invalid MLS mailbox count.')
    const ids = mailboxes.map(idOf), asked = new Set(ids)
    if (asked.size !== ids.length || (after !== undefined && !CURSOR.test(after))) throw new Error('Invalid MLS fetch cursor or mailboxes.')
    return this.#request('POST', '/vmls/v1/fetch', json({ v: 1, mailboxes: ids, ...(after === undefined ? {} : { after }) }), MAX_FETCH, (status, raw) => {
      const a = answer(raw, ['records'], ['next'])
      if (status !== 200 || !a || a.code !== 'ok' || !Array.isArray(a.records) || a.records.length > 64 ||
        (a.next !== undefined && a.next !== null && (typeof a.next !== 'string' || !CURSOR.test(a.next)))) return
      const records: FetchRecord[] = [], seen = new Set<string>()
      for (const r of a.records) {
        if (!object(r) || !keys(r, ['mailbox', 'receipt', 'envelope']) || !isId(r.mailbox) || !asked.has(r.mailbox) || !isId(r.receipt)) return
        const envelope = binary(r.envelope, MAX_MLS_ENVELOPE), key = `${r.mailbox}:${r.receipt}`
        if (!envelope || bytesToHex(sha256(envelope)) !== r.receipt || seen.has(key)) return
        seen.add(key); records.push({ mailbox: hexToBytes(r.mailbox), receipt: hexToBytes(r.receipt), envelope })
      }
      return parsed(a, { records, next: typeof a.next === 'string' ? a.next : null })
    }, current)
  }
  ack(items: readonly AckItem[], current: () => boolean = () => true): Promise<BoxAnswer<{ deleted: boolean; acked: number }>> {
    if (items.length < 1 || items.length > 64) throw new Error('Invalid MLS acknowledgement count.')
    const records = items.map(r => ({ mailbox: idOf(r.mailbox), receipt: idOf(r.receipt) }))
    if (new Set(records.map(r => `${r.mailbox}:${r.receipt}`)).size !== records.length) throw new Error('Duplicate MLS acknowledgement.')
    return this.#request('POST', '/vmls/v1/ack', json({ v: 1, records }), MAX_JSON, (status, raw) => {
      const a = answer(raw, ['acked'])
      if (status !== 200 || !a || !['deleted', 'marked'].includes(a.code) || !isUint(a.acked, records.length)) return
      return parsed(a, { deleted: a.code === 'deleted', acked: a.acked })
    }, current)
  }
  registerPackage(packageId: Uint8Array, welcomeMailbox: Uint8Array, expiresAt: number, serverTime: number): Promise<BoxAnswer<{ fresh: boolean }>> {
    const id = idOf(packageId), mailbox = idOf(welcomeMailbox)
    uint(serverTime); uint(expiresAt)
    if (expiresAt <= serverTime || expiresAt - serverTime > 7 * 86400) throw new Error('Invalid MLS package expiry.')
    const ciphertext = sha256(concatBytes(encoder.encode('VMLS/1 package'), hexToBytes(id), hexToBytes(mailbox)))
    return this.#request('PUT', `/vmls/v1/packages/${id}`, json({ v: 1, welcome_mailbox: mailbox, expires_at: expiresAt, ciphertext: base64Encode(ciphertext) }), MAX_JSON, (status, raw) => {
      const a = answer(raw, [])
      if (!a || !((status === 201 && a.code === 'registered') || (status === 200 && a.code === 'unchanged'))) return
      return parsed(a, { fresh: a.code === 'registered' })
    })
  }
  withdrawPackage(packageId: Uint8Array): Promise<BoxAnswer<void>> {
    return this.#request('DELETE', `/vmls/v1/packages/${idOf(packageId)}`, new Uint8Array(), MAX_JSON, (status, raw) => {
      const a = answer(raw, [])
      return status === 200 && a?.code === 'withdrawn' ? parsed(a, undefined) : undefined
    })
  }

  #receipt(signed: Uint8Array, slot: string, attempt: number, receipt: string): boolean {
    return signed.length === 197 && signed[0] === 1 && bytesToHex(signed.subarray(1, 33)) === this.box &&
      bytesToHex(signed.subarray(65, 97)) === slot && new DataView(signed.buffer, signed.byteOffset).getUint32(97) === attempt &&
      bytesToHex(signed.subarray(101, 133)) === receipt
  }
  async #request<T>(method: LinkRequest['method'], path: string, input: Uint8Array, limit: number,
    parse: (status: number, raw: Uint8Array) => { value: T; serverTime: number | null } | undefined | Promise<{ value: T; serverTime: number | null } | undefined>, requestCurrent: () => boolean = () => true): Promise<BoxAnswer<T>> {
    if (this.#occupied >= 32) return { state: 'not-signed', reason: 'busy' }
    const body = input.slice(), epoch = this.#epoch
    const request = Object.freeze({ v: 1 as const, box: this.box, method, path, payload: bytesToHex(sha256(body)) })
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined, wake!: () => void
    const active = () => !cancelled && epoch === this.#epoch && requestCurrent() && this.current() && this.vault.current(this.#context)
    const waiting = new Promise<BoxAnswer<T>>(resolve => { wake = () => { cancelled = true; resolve({ state: 'unavailable' }) } })
    this.#pending.add(wake)
    this.#occupied++
    try {
      timer = setTimeout(wake, this.timeoutMs)
      const work = async (): Promise<BoxAnswer<T>> => {
        if (!active()) return { state: 'unavailable' }
        const signed = await this.vault.signBoxRequestV1(this.#context, request, async scope => {
          if (!active()) return 'deny'
          const decision = await this.consent(scope)
          return active() ? decision : 'deny'
        })
        if (!active()) return { state: 'unavailable' }
        if (!signed.ok) return { state: 'not-signed', reason: signed.refusal }
        const accepted = this.vault.acceptBoxReply(request, signed.value)
        if (!accepted.ok) return { state: 'not-signed', reason: accepted.refusal }
        if (!active()) return { state: 'unavailable' }
        let response
        try { response = await this.transport.request({ routeId: this.#routeId, method, path, authorization: accepted.value.authorization, body }) }
        catch { return { state: 'unavailable' } }
        if (!active()) return { state: 'unavailable' }
        if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599 || !(response.body instanceof Uint8Array) || response.body.length > limit) return { state: 'malformed' }
        // Copy before the asynchronous capabilities parser can yield to callers.
        const raw = response.body.slice(), status = response.status
        if (status < 300 || status === 409) {
          const result = await parse(status, raw)
          if (!active()) return { state: 'unavailable' }
          if (result) return { state: 'ok', ...result }
          if (status !== 409) return { state: 'malformed' }
        }
        if (!raw.length) return { state: 'refused', status, code: null, serverTime: null }
        const refused = raw.length <= MAX_JSON ? answer(raw, []) : undefined
        if (!refused || !Object.hasOwn(REFUSALS, refused.code) || REFUSALS[refused.code] !== status) return { state: 'malformed' }
        return { state: 'refused', status, code: refused.code, serverTime: refused.server_time }
      }
      // An abandoned prompt/request can still be running. Keep its capacity
      // until it actually settles; timeout must not create an unbounded queue.
      return await Promise.race([work().finally(() => { this.#occupied-- }), waiting])
    } finally { cancelled = true; clearTimeout(timer); this.#pending.delete(wake) }
  }
}

const json = (v: unknown) => encoder.encode(JSON.stringify(v))
const isId = (v: unknown): v is string => typeof v === 'string' && v.length === 64 && HEX.test(v)
const idOf = (v: Uint8Array) => { if (!(v instanceof Uint8Array) || v.length !== 32) throw new Error('Invalid MLS identifier.'); return bytesToHex(v) }
const isUint = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max
const uint = (v: number, max = Number.MAX_SAFE_INTEGER) => { if (!isUint(v, max)) throw new Error('Invalid MLS integer.') }
const bounded = (v: Uint8Array, max: number) => { if (!(v instanceof Uint8Array) || v.length < 1 || v.length > max) throw new Error('Invalid MLS envelope.'); return v.slice() }
const object = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)
const keys = (v: Json, required: string[], optional: string[] = []) => required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k))
function binary(v: unknown, max: number): Uint8Array | undefined {
  if (typeof v !== 'string' || v.length > Math.ceil(max / 3) * 4) return
  const decoded = base64Decode(v)
  return decoded && decoded.length <= max && decoded.length > 0 && base64Encode(decoded) === v ? decoded : undefined
}
function parsed<T>(a: Json & { server_time: number }, value: T) { return { value, serverTime: a.server_time } }
function answer(raw: Uint8Array, required: string[], optional: string[] = []): (Json & { code: string; server_time: number }) | undefined {
  try {
    const a = strictJson(raw)
    if (!object(a) || !keys(a, ['v', 'code', 'server_time', ...required], optional) || a.v !== 1 || typeof a.code !== 'string' || !isUint(a.server_time)) return
    return a as Json & { code: string; server_time: number }
  } catch { return undefined }
}

/** Response JSON only: bounded depth, exact unsigned integer spelling and no
 * duplicate keys (including escaped aliases). JSON.parse alone loses both. */
function strictJson(raw: Uint8Array): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  let i = 0
  const space = () => { while (' \r\n\t'.includes(text[i] ?? '\0')) i++ }
  const string = (): string => {
    const start = i++
    while (i < text.length) {
      const ch = text[i++]
      if (ch === '"') return JSON.parse(text.slice(start, i))
      if (ch === '\\') i++
    }
    throw new Error('Unclosed JSON string')
  }
  const value = (depth: number): unknown => {
    if (depth > 8) throw new Error('JSON depth')
    space()
    if (text[i] === '"') return string()
    if (text[i] === '{' || text[i] === '[') {
      const obj = text[i++] === '{', end = obj ? '}' : ']'
      const result: any = obj ? Object.create(null) : [], seen = new Set<string>()
      space(); if (text[i] === end) { i++; return result }
      for (;;) {
        space()
        if (obj) {
          if (text[i] !== '"') throw new Error('JSON key')
          const key = string(); space()
          if (seen.has(key) || text[i++] !== ':') throw new Error('Duplicate JSON key')
          seen.add(key); result[key] = value(depth + 1)
        } else result.push(value(depth + 1))
        space()
        if (text[i] === end) { i++; return result }
        if (text[i++] !== ',') throw new Error('JSON separator')
      }
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(token, i)) { i += token.length; return result }
    }
    const number = /^(0|[1-9][0-9]*)/.exec(text.slice(i))?.[0]
    if (!number || !isUint(Number(number))) throw new Error('JSON integer')
    i += number.length; return Number(number)
  }
  const result = value(0); space()
  if (i !== text.length) throw new Error('Trailing JSON')
  return result
}
