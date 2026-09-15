import { finalizeEvent, generateSecretKey, getEventHash, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import type { PeerCrypt } from './dm.js'
import type { ParticipantIdentity } from './identity.js'
import { randomFraction } from './random.js'
import type { RelayTransport } from './relay-pool.js'
import { verifyEventUncached } from './verify.js'

/** Inner NIP-59 kinds, private to the Vennel migration contract. */
export const PRIVATE_MIGRATION_KIND = 24644
export const PRIVATE_MIGRATION_REPLY_KIND = 24645
export const GIFT_WRAP_KIND = 1059
export const SEAL_KIND = 13
export const MAX_PRIVATE_MIGRATION_EVENTS = 8
export const MAX_PRIVATE_MIGRATION_BYTES = 512 * 1024

const hex = /^[0-9a-f]{64}$/
const nonce = /^[0-9a-f]{16}$/
const encoder = new TextEncoder()

/** The account signer must support NIP-44 as well as signing. No nsec is
 * copied into KithMoot merely to move a recovery batch. */
export interface PrivateMigrationIdentity extends ParticipantIdentity, PeerCrypt {}

export type PrivateMigrationOperation =
  | { op: 'retain'; events: readonly Event[] }
  | { op: 'delete'; id: string }

export interface PrivateMigrationRequest {
  /** The outer NIP-59 gift wrap to publish to the box's command relays. */
  wrapper: Event
  /** Canonical unsigned rumour ID, used to correlate the encrypted receipt. */
  requestId: string
}

export interface PrivateMigrationReply {
  re: string
  ok: boolean
  result?: { outcomes?: string[]; outcome?: 'recorded' | 'duplicate' }
  error?: { code: string; message: string }
}

/** Publish one request and wait for its correlated NIP-59 receipt. The inbox
 * subscription begins before publishing, so a fast box response cannot race
 * past the caller. This uses only the selected account's normal relays; it
 * does not send raw history to a box's public event-relay door. */
export async function submitPrivateMigrationRequest(input: {
  identity: PrivateMigrationIdentity
  node: string
  operation: PrivateMigrationOperation
  nonce: string
  transport: Pick<RelayTransport, 'publish' | 'subscribe'>
  now?: number
  timeoutMs?: number
}): Promise<PrivateMigrationReply> {
  const request = await createPrivateMigrationRequest(input)
  const timeoutMs = input.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw new Error('Private migration receipt timeout must be 1-120 seconds.')
  return await new Promise<PrivateMigrationReply>((resolve, reject) => {
    let finished = false
    let unsubscribe: (() => void) | undefined
    const finish = (result: { reply?: PrivateMigrationReply; error?: Error }) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      try { unsubscribe?.() } catch { /* The authenticated result is already decided. */ }
      if (result.reply) resolve(result.reply)
      else reject(result.error ?? new Error('Private migration request did not receive a receipt.'))
    }
    const timer = setTimeout(() => finish({ error: new Error('Private migration request timed out waiting for the box receipt.') }), timeoutMs)
    try {
      unsubscribe = input.transport.subscribe([{ kinds: [GIFT_WRAP_KIND], '#p': [input.identity.pubkey] }], event => {
        void readPrivateMigrationReply({ wrapper: event, identity: input.identity, node: input.node, requestId: request.requestId })
          .then(reply => { if (reply) finish({ reply }) })
      })
      void input.transport.publish(request.wrapper).catch(error => finish({ error: error instanceof Error ? error : new Error(String(error)) }))
    } catch (error) {
      finish({ error: error instanceof Error ? error : new Error(String(error)) })
    }
  })
}

/** Build one bounded private-custody request. It is an explicit operation,
 * never a background sync and never a public Nostr event. */
export async function createPrivateMigrationRequest(input: {
  identity: PrivateMigrationIdentity
  node: string
  operation: PrivateMigrationOperation
  nonce: string
  now?: number
}): Promise<PrivateMigrationRequest> {
  const { identity } = input
  const node = validKey(input.node, 'Invalid Bothy public key.')
  const pubkey = validKey(identity.pubkey, 'Invalid signing public key.')
  if (!nonce.test(input.nonce)) throw new Error('Private migration nonce must be 16 lowercase hex characters.')
  const now = input.now ?? Math.floor(Date.now() / 1000)
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid private migration time.')
  const body = requestBody(input.operation, input.nonce)
  const content = JSON.stringify(body)
  if (encoder.encode(content).byteLength > MAX_PRIVATE_MIGRATION_BYTES) throw new Error('Private migration request is too large.')
  const rumor = {
    pubkey,
    kind: PRIVATE_MIGRATION_KIND,
    created_at: now,
    tags: [['p', node]],
    content,
  }
  const requestId = getEventHash(rumor)
  const unsignedRumor = { ...rumor, id: requestId }
  const ephemeral = generateSecretKey()
  try {
    const encryptedRumor = await identity.encrypt(node, JSON.stringify(unsignedRumor))
    const seal = await identity.signEvent({ kind: SEAL_KIND, created_at: now, tags: [], content: encryptedRumor })
    if (seal.pubkey !== pubkey || seal.kind !== SEAL_KIND || seal.created_at !== now || seal.content !== encryptedRumor || seal.tags.length !== 0 || !verifyEventUncached(seal)) throw new Error('The signer changed or refused the private migration seal.')
    const wrapped = nip44.v2.encrypt(JSON.stringify(seal), nip44.v2.utils.getConversationKey(ephemeral, node))
    return {
      requestId,
      wrapper: finalizeEvent({
        kind: GIFT_WRAP_KIND,
        created_at: Math.max(0, now - Math.floor(randomFraction() * 172_800)),
        tags: [['p', node]],
        content: wrapped,
      }, ephemeral),
    }
  } finally {
    ephemeral.fill(0)
  }
}

/** Open and validate a private migration receipt locally. Bad relay material
 * yields `undefined`; it never becomes a successful box outcome. */
export async function readPrivateMigrationReply(input: {
  wrapper: Event
  identity: PrivateMigrationIdentity
  node: string
  requestId: string
}): Promise<PrivateMigrationReply | undefined> {
  try {
    const node = validKey(input.node, 'Invalid Bothy public key.')
    const mine = validKey(input.identity.pubkey, 'Invalid signing public key.')
    if (!hex.test(input.requestId) || input.wrapper.kind !== GIFT_WRAP_KIND || !onlyTag(input.wrapper.tags, 'p', mine) || !verifyEventUncached(input.wrapper)) return
    const seal = JSON.parse(await input.identity.decrypt(input.wrapper.pubkey, input.wrapper.content)) as Event
    if (!seal || seal.kind !== SEAL_KIND || seal.pubkey !== node || seal.tags.length !== 0 || !verifyEventUncached(seal)) return
    const rumor = JSON.parse(await input.identity.decrypt(node, seal.content)) as Record<string, unknown>
    if (!validRumor(rumor, node, mine) || rumor.kind !== PRIVATE_MIGRATION_REPLY_KIND || !onlyTag(rumor.tags, 'p', mine) || rumor.id !== getEventHash(rumor)) return
    const reply = JSON.parse(rumor.content) as PrivateMigrationReply
    if (!validReply(reply) || reply.re !== input.requestId) return
    return structuredClone(reply)
  } catch { return }
}

function requestBody(operation: PrivateMigrationOperation, value: string): Record<string, unknown> {
  if (operation.op === 'delete') {
    if (!hex.test(operation.id)) throw new Error('Private migration delete needs a lowercase 64-hex event ID.')
    return { v: 1, op: 'delete', nonce: value, id: operation.id }
  }
  if (!Array.isArray(operation.events) || operation.events.length < 1 || operation.events.length > MAX_PRIVATE_MIGRATION_EVENTS) throw new Error(`Private migration retain needs 1-${MAX_PRIVATE_MIGRATION_EVENTS} events.`)
  for (const event of operation.events) {
    if (!hex.test(event.id) || !hex.test(event.pubkey) || !verifyEventUncached(event)) throw new Error('Private migration retains only verified signed events.')
  }
  return { v: 1, op: 'retain', nonce: value, events: operation.events }
}

function validKey(value: string, message: string): string {
  if (!hex.test(value)) throw new Error(message)
  return value
}
function onlyTag(value: unknown, name: string, target: string): value is string[][] {
  return Array.isArray(value) && value.length === 1 && Array.isArray(value[0]) && value[0].length === 2 && value[0][0] === name && value[0][1] === target
}
function validRumor(value: Record<string, unknown>, node: string, mine: string): value is { id: string; pubkey: string; kind: number; created_at: number; tags: string[][]; content: string } {
  return hex.test(value.id as string) && value.pubkey === node && Number.isSafeInteger(value.kind) && Number.isSafeInteger(value.created_at) && typeof value.content === 'string' && onlyTag(value.tags, 'p', mine)
}
function validReply(value: PrivateMigrationReply): value is PrivateMigrationReply {
  if (!value || typeof value !== 'object' || !hex.test(value.re) || typeof value.ok !== 'boolean' || (value.result === undefined) === (value.error === undefined)) return false
  if (value.error !== undefined) return typeof value.error.code === 'string' && typeof value.error.message === 'string'
  const result = value.result
  return !!result && ((Array.isArray(result.outcomes) && result.outcomes.every(outcome => typeof outcome === 'string') && result.outcome === undefined) || ((result.outcome === 'recorded' || result.outcome === 'duplicate') && result.outcomes === undefined))
}
