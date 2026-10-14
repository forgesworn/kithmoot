/** @internal Fixed renewal statements and results are data, never authority
 * to invoke a signer, clear a journal or adopt a Session. */
import { getPublicKey, verifiedSymbol } from 'nostr-tools/pure'
import { SIGNET_VERIFIED_EVENT_SYMBOL } from 'signet-login'
import type { EventTemplate, NostrEvent } from 'signet-login'
import { createDeviceCredential } from '../../src/credential.js'
import { verifyEventUncached } from '../../src/verify.js'
import { OrdinaryStateHold, ordinaryUtf8Length } from './ordinary-state-codec.js'
import { readOrdinaryRenewalRequest } from './ordinary-renewal-request.js'
import { captureOrdinarySigningStatement, captureOrdinaryForegroundProof } from './ordinary-foreground-signer.js'

export const ORDINARY_RENEWAL_RESULT_BYTES = 4096
function hold(): never { throw new OrdinaryStateHold() }
const verificationCacheSymbols = new Set<symbol>([verifiedSymbol, SIGNET_VERIFIED_EVENT_SYMBOL])
function exactTags(input: unknown, expected: string[][]): void {
  const array = (raw: unknown, size: number): unknown[] => {
    if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) hold()
    const fields = Object.getOwnPropertyDescriptors(raw) as Record<string, PropertyDescriptor>, length = fields.length
    if (!length || !Object.hasOwn(length, 'value') || length.value !== size || Reflect.ownKeys(fields).length !== size + 1) hold()
    return Array.from({ length: size }, (_, i) => {
      const field = fields[String(i)]
      if (!field || !Object.hasOwn(field, 'value') || !field.enumerable) hold()
      return field.value
    })
  }
  const tags = array(input, expected.length)
  for (let i = 0; i < tags.length; i++) {
    const parts = array(tags[i], expected[i]!.length)
    if (parts.some((part, j) => typeof part !== 'string' || part !== expected[i]![j])) hold()
  }
}
/** Ask the pinned Fold-kit implementation for its exact unsigned statement.
 * The local capture stops before signing; it allocates no secret, invokes no
 * provider and does not relax Fold-kit's credential semantics. */
export async function ordinaryRenewalStatement(request: string, seal: Uint8Array): Promise<Required<EventTemplate>> {
  const intent = readOrdinaryRenewalRequest(request).intent
  if (!(seal instanceof Uint8Array) || seal.length !== 32) hold()
  let publicSeal: string
  try { publicSeal = getPublicKey(seal) } catch { return hold() }
  const capturedOnly = Object.freeze({})
  let captured: Required<EventTemplate> | undefined
  try {
    await createDeviceCredential({
      identity: { pubkey: intent.participant, signEvent: event => {
        captured = captureOrdinarySigningStatement(event)
        return Promise.reject(capturedOnly)
      } },
      roomId: intent.roomId, devicePubkey: intent.device, expiresAt: intent.expiresAt,
      seal: publicSeal, now: () => intent.issuedAt,
    })
    hold()
  } catch (error) { if (error !== capturedOnly) return hold() }
  if (!captured) hold()
  return Object.freeze({ ...captured, tags: Object.freeze(captured.tags.map(tag => Object.freeze([...tag]))) }) as unknown as Required<EventTemplate>
}
/** Retain one canonical representation of the exact signed statement. A
 * valid signature on changed terms, a restamped event, additional fields or
 * a cached verification flag cannot substitute for the requested result. */
export async function ordinaryRenewalResult(request: string, seal: Uint8Array, input: NostrEvent): Promise<string> {
  const statement = await ordinaryRenewalStatement(request, seal)
  return ordinaryRenewalResultForStatement(request, statement, input)
}
/** Capture and freshly verify a provider fulfilment without yielding. The
 * statement was fixed before provider invocation; this supplies data only. */
export function ordinaryRenewalResultForStatement(request: string, statement: Required<EventTemplate>, input: NostrEvent): string {
  const intent = readOrdinaryRenewalRequest(request).intent
  const fields = ['kind','created_at','tags','content','pubkey','id','sig']
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) hold()
  const names = Object.getOwnPropertyNames(input), symbols = Object.getOwnPropertySymbols(input)
  if (names.length !== fields.length || names.some(name => !fields.includes(name)) || symbols.length > 1 ||
      symbols.some(symbol => !verificationCacheSymbols.has(symbol))) hold()
  for (const name of names) {
    const field = Object.getOwnPropertyDescriptor(input, name)
    if (!field || !Object.hasOwn(field, 'value') || !field.enumerable) hold()
  }
  if (symbols.length) {
    const cache = Object.getOwnPropertyDescriptor(input, symbols[0]!)!
    if (!Object.hasOwn(cache, 'value') || cache.value !== true) hold()
  }
  exactTags(Object.getOwnPropertyDescriptor(input, 'tags')!.value, statement.tags)
  const event = captureOrdinaryForegroundProof(input)
  if (event.pubkey !== intent.participant || JSON.stringify(captureOrdinarySigningStatement(event)) !== JSON.stringify(statement) ||
      !verifyEventUncached(event)) hold()
  const result = JSON.stringify({ kind: event.kind, created_at: event.created_at, tags: event.tags, content: event.content,
    pubkey: event.pubkey, id: event.id, sig: event.sig })
  ordinaryUtf8Length(result, ORDINARY_RENEWAL_RESULT_BYTES)
  return result
}
