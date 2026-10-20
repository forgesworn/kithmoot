import { base64 } from '@scure/base'
import { getEventHash, type Event } from 'nostr-tools/pure'
import { verifyEventUncached } from '../../src/verify.js'
import { latestDmRelayList } from '../../src/dm-relays.js'

const HEX = /^[0-9a-f]{64}$/
export const ORDINARY_MAX_COPIES = 128
export const ORDINARY_MAX_WIRE_BYTES = 128 * 1024
export const ORDINARY_MAX_HISTORY_BYTES = 2 * 1024 * 1024
export const ORDINARY_MAX_TEXT_BYTES = 64 * 1024
const bytes = (value: string) => new TextEncoder().encode(value).byteLength
const signed = ['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig']
const unsigned = signed.filter(name => name !== 'sig')

/** Copy only bounded own data fields, never getters, aliases or cached
 * verification symbols. Network input and saved browser data are untrusted. */
function capture(value: unknown, signature: boolean): Event | undefined {
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return
    const names = signature ? signed : unsigned
    const own = Object.getOwnPropertyNames(value)
    if (own.length !== names.length || own.some(name => !names.includes(name))) return
    const copy: Record<string, unknown> = {}
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name)
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return
      copy[name] = descriptor.value
    }
    if (typeof copy.id !== 'string' || !HEX.test(copy.id) || typeof copy.pubkey !== 'string' || !HEX.test(copy.pubkey) ||
        !Number.isSafeInteger(copy.kind) || (copy.kind as number) < 0 || !Number.isSafeInteger(copy.created_at) || (copy.created_at as number) < 0 ||
        typeof copy.content !== 'string' || copy.content.length > ORDINARY_MAX_WIRE_BYTES ||
        signature && (typeof copy.sig !== 'string' || !/^[0-9a-f]{128}$/.test(copy.sig)) ||
        !Array.isArray(copy.tags) || copy.tags.length > 128) return
    const tags: string[][] = []
    let units = 0
    for (let i = 0; i < copy.tags.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(copy.tags, String(i))
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !Array.isArray(descriptor.value) || descriptor.value.length > 16) return
      const row: string[] = []
      for (let j = 0; j < descriptor.value.length; j++) {
        const field = Object.getOwnPropertyDescriptor(descriptor.value, String(j))
        if (!field || !Object.hasOwn(field, 'value') || typeof field.value !== 'string' ||
            field.value.length > 4096 || (units += field.value.length) > 16384) return
        row.push(field.value)
      }
      tags.push(row)
    }
    const result = { ...copy, tags } as unknown as Event
    if (bytes(JSON.stringify(result)) > ORDINARY_MAX_WIRE_BYTES) return
    if (signature ? !verifyEventUncached(result) : getEventHash(result) !== result.id) return
    for (const tag of tags) Object.freeze(tag)
    Object.freeze(tags)
    return Object.freeze(result)
  } catch { return undefined }
}

/** Invalid/ambiguous expiration refuses the event rather than extends it. */
export function ordinaryExpired(event: Pick<Event, 'tags'>, now: number): boolean {
  const tags = event.tags.filter(tag => tag[0] === 'expiration')
  if (!tags.length) return false
  const tag = tags[0]!
  return tags.length !== 1 || tag.length !== 2 || !/^[0-9]{1,16}$/.test(tag[1]!) ||
    !Number.isSafeInteger(Number(tag[1])) || Number(tag[1]) <= now
}

function payload(value: string): boolean {
  try {
    if (value.length < 132 || value.length > ORDINARY_MAX_WIRE_BYTES) return false
    const decoded = base64.decode(value)
    return decoded.length >= 99 && decoded[0] === 2
  } catch { return false }
}

export function captureOrdinaryCopy(value: unknown, self: string, now: number, allowExpired = false): Event | undefined {
  const event = capture(value, true)
  if (!HEX.test(self) || !event || event.kind !== 1059 || event.created_at > now + 60 || !payload(event.content) ||
      !allowExpired && ordinaryExpired(event, now)) return
  const recipients = event.tags.filter(tag => tag[0] === 'p')
  // Relay hints and bounded additional routing/PoW tags are not identities.
  return recipients.length === 1 && recipients[0]![1] === self ? event : undefined
}

export function captureOrdinarySeal(value: unknown, now: number): Event | undefined {
  const seal = capture(value, true)
  return seal?.kind === 13 && seal.created_at <= now + 60 && seal.tags.length === 0 && payload(seal.content) ? seal : undefined
}

export interface OrdinaryText {
  id: string; author: string; sentAt: number; text: string; members: readonly string[]; peer?: string; expiresAt?: number
}

export function captureOrdinaryText(value: unknown, seal: Event, self: string, now: number): OrdinaryText | undefined {
  const rumor = capture(value, false)
  if (!rumor || rumor.kind !== 14 || rumor.pubkey !== seal.pubkey || rumor.created_at > now + 60 || ordinaryExpired(rumor, now) ||
      bytes(rumor.content) > ORDINARY_MAX_TEXT_BYTES || rumor.tags.some(tag => tag[0] === 'kithmoot-invitation')) return
  const recipients = rumor.tags.filter(tag => tag[0] === 'p').map(tag => tag[1])
  if (!recipients.length || recipients.some(key => typeof key !== 'string' || !HEX.test(key)) ||
      rumor.pubkey !== self && !recipients.includes(self)) return
  const members = [...new Set([rumor.pubkey, ...recipients as string[]])].sort()
  return { id: rumor.id, author: rumor.pubkey, sentAt: rumor.created_at, text: rumor.content, members: Object.freeze(members),
    ...(rumor.tags.some(tag => tag[0] === 'expiration') ? { expiresAt: Number(rumor.tags.find(tag => tag[0] === 'expiration')![1]) } : {}),
    ...(members.length === 2 ? { peer: members.find(key => key !== self)! } : {}) }
}

export function ordinaryInboxRelays(statements: readonly Event[], self: string, now: number): string[] {
  const verified = statements.slice(0, 64).map(value => capture(value, true))
    .filter((event): event is Event => !!event && event.kind === 10050 && event.pubkey === self && event.created_at <= now + 60)
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
  const latest = verified[0]
  if (!latest || ordinaryExpired(latest, now)) return []
  // The existing parser caches verification on its argument. Give it a new
  // mutable JSON copy, never the captured/frozen statement or caller data.
  return latestDmRelayList([JSON.parse(JSON.stringify(latest)) as Event], self)
}
