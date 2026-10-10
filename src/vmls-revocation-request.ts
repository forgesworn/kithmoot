import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { nip44 } from 'nostr-tools'
import { finalizeEvent, generateSecretKey, getEventHash, type Event } from 'nostr-tools/pure'
import type { PeerCrypt } from './dm.js'
import { latestDmRelayList } from './dm-relays.js'
import type { ParticipantIdentity } from './identity.js'
import { randomFraction } from './random.js'
import { verifyEventUncached } from './verify.js'

/** Experimental inner-only kind from Vennel contract section 7.1. */
export const VMLS_REVOCATION_REQUEST_KIND = 21350
export const VMLS_REVOCATION_REQUEST_LABEL = 'vmls-revocation-request/1'
export const VMLS_REVOCATION_REQUEST_SECONDS = 7 * 24 * 60 * 60
export const VMLS_REVOCATION_FUTURE_SKEW_SECONDS = 10 * 60
export const VMLS_REVOCATION_GIFT_WRAP_KIND = 1059
export const VMLS_REVOCATION_SEAL_KIND = 13
export const VMLS_REVOCATION_LABELS = ['kithmoot/vmls-member-grant/v1'] as const

const MAX_RUMOR_BYTES = 16_384
const MAX_SEAL_BYTES = 24_000
const MAX_WRAP_BYTES = 40_000
const MAX_HINTS = 64
const TWO_DAYS = 2 * 24 * 60 * 60
const hex32 = /^[0-9a-f]{64}$/
const encoder = new TextEncoder()

export interface VmlsRevocationIdentity extends ParticipantIdentity, PeerCrypt {}

export interface VmlsRevocationRequest {
  sender: string
  keeper: string
  device: string
  sessions: string[]
  boxes: string[]
  createdAt: number
  expiration: number
}

export interface VmlsRevocationRumor {
  id: string
  pubkey: string
  created_at: number
  kind: typeof VMLS_REVOCATION_REQUEST_KIND
  tags: string[][]
  content: ''
}

export interface VmlsRevocationPublication {
  relays: string[]
  event: Event
  /** This public DM publish must never disclose the member through NIP-42. */
  authenticate: false
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === fields.length && keys.every(key => fields.includes(key))
}

function validate(request: VmlsRevocationRequest): VmlsRevocationRequest {
  if (!object(request) || !exact(request, ['sender','keeper','device','sessions','boxes','createdAt','expiration']) ||
      !hex32.test(request.sender) || !hex32.test(request.keeper) || !hex32.test(request.device) || request.sender === request.keeper ||
      !Array.isArray(request.sessions) || request.sessions.length < 1 || request.sessions.length > MAX_HINTS ||
      !Array.isArray(request.boxes) || request.boxes.length < 1 || request.boxes.length > MAX_HINTS ||
      request.sessions.some(value => typeof value !== 'string' || !hex32.test(value)) || request.boxes.some(value => typeof value !== 'string' || !hex32.test(value)) ||
      new Set(request.sessions).size !== request.sessions.length || new Set(request.boxes).size !== request.boxes.length ||
      !Number.isSafeInteger(request.createdAt) || request.createdAt < 0 || !Number.isSafeInteger(request.expiration) ||
      request.expiration <= request.createdAt || request.expiration - request.createdAt > VMLS_REVOCATION_REQUEST_SECONDS) {
    throw new Error('Invalid VMLS revocation request.')
  }
  return structuredClone(request)
}

function requestTags(request: VmlsRevocationRequest): string[][] {
  return [
    ['p', request.keeper],
    ['t', VMLS_REVOCATION_REQUEST_LABEL],
    ['device', request.device],
    ['expiration', String(request.expiration)],
    ...request.sessions.map(value => ['session', value]),
    ...request.boxes.map(value => ['box', value]),
  ]
}

/** Build the unsigned, canonical NIP-59 rumour. It must never be published directly. */
export function createVmlsRevocationRumor(input: VmlsRevocationRequest): VmlsRevocationRumor {
  const request = validate(input)
  const unsigned = { pubkey: request.sender, created_at: request.createdAt, kind: 21350 as const, tags: requestTags(request), content: '' as const }
  return { id: getEventHash(unsigned), ...unsigned }
}

/** Strictly authenticate and decode an already opened kind-13 payload. */
export function parseVmlsRevocationRumor(text: string, sealAuthor: string, recipient: string,
  now = Math.floor(Date.now() / 1000)): VmlsRevocationRequest {
  if (typeof text !== 'string' || encoder.encode(text).byteLength > MAX_RUMOR_BYTES || !hex32.test(sealAuthor) || !hex32.test(recipient) ||
      !Number.isSafeInteger(now) || now < 0) throw new Error('Invalid VMLS revocation rumour.')
  const value: unknown = JSON.parse(text)
  if (!object(value) || !exact(value, ['id','pubkey','created_at','kind','tags','content']) || !hex32.test(value.id as string) ||
      value.pubkey !== sealAuthor || value.kind !== VMLS_REVOCATION_REQUEST_KIND || value.content !== '' ||
      !Number.isSafeInteger(value.created_at) || !Array.isArray(value.tags) || value.tags.length > 4 + MAX_HINTS * 2) {
    throw new Error('Invalid VMLS revocation rumour.')
  }
  const tags: string[][] = []
  for (const tag of value.tags) {
    if (!Array.isArray(tag) || tag.length !== 2 || typeof tag[0] !== 'string' || typeof tag[1] !== 'string' ||
        !['p','t','device','expiration','session','box'].includes(tag[0])) throw new Error('Invalid VMLS revocation rumour.')
    tags.push([tag[0], tag[1]])
  }
  const one = (name: string): string => {
    const matches = tags.filter(tag => tag[0] === name)
    if (matches.length !== 1) throw new Error('Invalid VMLS revocation rumour.')
    return matches[0]![1]!
  }
  if (one('p') !== recipient || one('t') !== VMLS_REVOCATION_REQUEST_LABEL) throw new Error('Invalid VMLS revocation rumour.')
  const expiration = Number(one('expiration'))
  if (!Number.isSafeInteger(expiration) || String(expiration) !== one('expiration')) throw new Error('Invalid VMLS revocation rumour.')
  const request = validate({
    sender: sealAuthor,
    keeper: recipient,
    device: one('device'),
    sessions: tags.filter(tag => tag[0] === 'session').map(tag => tag[1]!),
    boxes: tags.filter(tag => tag[0] === 'box').map(tag => tag[1]!),
    createdAt: value.created_at as number,
    expiration,
  })
  if (request.createdAt > now + VMLS_REVOCATION_FUTURE_SKEW_SECONDS || request.expiration <= now ||
      value.id !== getEventHash({ pubkey: request.sender, created_at: request.createdAt, kind: VMLS_REVOCATION_REQUEST_KIND, tags, content: '' })) {
    throw new Error('Invalid VMLS revocation rumour.')
  }
  return request
}

function backdated(at: number, random: () => number): number {
  const value = random()
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('Invalid VMLS revocation wrapping randomness.')
  return Math.max(0, at - Math.floor(value * (TWO_DAYS + 1)))
}

/** Seal with the account identity and gift-wrap with a fresh throwaway key. */
export async function wrapVmlsRevocationRequest(identity: VmlsRevocationIdentity, input: VmlsRevocationRequest,
  random: () => number = randomFraction, current: () => boolean = () => true): Promise<Event> {
  const request = validate(input)
  if (identity.pubkey !== request.sender || !current()) throw new Error('Sign in as the requesting member.')
  const rumor = JSON.stringify(createVmlsRevocationRumor(request))
  const encrypted = await identity.encrypt(request.keeper, rumor)
  if (!current()) throw new Error('The requesting account changed.')
  if (typeof encrypted !== 'string' || encoder.encode(encrypted).byteLength > MAX_SEAL_BYTES) throw new Error('The VMLS revocation seal is too large.')
  const sealAt = backdated(request.createdAt, random)
  const seal = await identity.signEvent({ kind: VMLS_REVOCATION_SEAL_KIND, created_at: sealAt, tags: [], content: encrypted })
  if (!current()) throw new Error('The requesting account changed.')
  if (seal.pubkey !== request.sender || seal.kind !== VMLS_REVOCATION_SEAL_KIND || seal.created_at !== sealAt || seal.content !== encrypted ||
      !Array.isArray(seal.tags) || seal.tags.length !== 0 || !verifyEventUncached(seal)) throw new Error('The signer changed or refused the VMLS revocation seal.')
  const ephemeral = generateSecretKey()
  try {
    const content = nip44.v2.encrypt(JSON.stringify(seal), nip44.v2.utils.getConversationKey(ephemeral, request.keeper))
    if (encoder.encode(content).byteLength > MAX_WRAP_BYTES) throw new Error('The VMLS revocation gift wrap is too large.')
    return finalizeEvent({ kind: VMLS_REVOCATION_GIFT_WRAP_KIND, created_at: backdated(request.createdAt, random), tags: [['p', request.keeper]], content }, ephemeral)
  } finally {
    ephemeral.fill(0)
  }
}

/**
 * Publish only to the keeper's verified latest kind-10050 list. Resolving means
 * the publisher observed at least one `OK true`; only then may a journal set
 * `NotAuthorised.requested`. The publisher is explicitly denied identity AUTH.
 */
export async function sendVmlsRevocationRequest(input: {
  identity: VmlsRevocationIdentity
  request: VmlsRevocationRequest
  directoryEvents: readonly Event[]
  publish: (publication: VmlsRevocationPublication) => Promise<void>
  current?: () => boolean
  random?: () => number
}): Promise<VmlsRevocationPublication> {
  const current = input.current ?? (() => true)
  const request = validate(input.request)
  if (input.identity.pubkey !== request.sender || !current()) throw new Error('Sign in as the requesting member.')
  const relays = latestDmRelayList(input.directoryEvents, request.keeper)
  if (!relays.length) throw new Error('The keeper has no DM relay list. No revocation request was sent.')
  const event = await wrapVmlsRevocationRequest(input.identity, request, input.random, current)
  if (!current()) throw new Error('The requesting account changed.')
  const publication = { relays, event, authenticate: false as const }
  await input.publish(publication)
  if (!current()) throw new Error('The requesting account changed.')
  return publication
}

/** Open one bounded wrapper. Invalid or unrelated relay material is dropped silently. */
export async function unwrapVmlsRevocationRequest(wrapper: Event, identity: VmlsRevocationIdentity,
  now = Math.floor(Date.now() / 1000)): Promise<VmlsRevocationRequest | undefined> {
  try {
    if (!wrapper || wrapper.kind !== VMLS_REVOCATION_GIFT_WRAP_KIND || !Number.isSafeInteger(now) || now < 0 ||
        JSON.stringify(wrapper.tags) !== JSON.stringify([['p', identity.pubkey]]) || encoder.encode(wrapper.content).byteLength > MAX_WRAP_BYTES ||
        !verifyEventUncached(wrapper)) return
    const seal: unknown = JSON.parse(await identity.decrypt(wrapper.pubkey, wrapper.content))
    if (!object(seal) || seal.kind !== VMLS_REVOCATION_SEAL_KIND || !hex32.test(seal.pubkey as string) || !Array.isArray(seal.tags) || seal.tags.length !== 0 ||
        typeof seal.content !== 'string' || encoder.encode(seal.content).byteLength > MAX_SEAL_BYTES || !verifyEventUncached(seal as unknown as Event)) return
    const rumor = await identity.decrypt(seal.pubkey as string, seal.content)
    return parseVmlsRevocationRumor(rumor, seal.pubkey as string, identity.pubkey, now)
  } catch {
    return
  }
}

/** Stable member-side reference where the member cannot know the keeper's grant id. */
export function vmlsMemberGrantReference(box: string, device: string): string {
  if (!hex32.test(box) || !hex32.test(device)) throw new Error('Invalid VMLS member grant reference.')
  return bytesToHex(sha256(concatBytes(encoder.encode(VMLS_REVOCATION_LABELS[0]), hexToBytes(box), hexToBytes(device))))
}
