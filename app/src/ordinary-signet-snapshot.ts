import type { SignetAuthEvent } from 'signet-login'
import { verifyLogin } from 'signet-login/verify'
import { getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils'
import { OrdinaryStateHold, ORDINARY_VALUE_UNITS, ORDINARY_NAME_UNITS, ordinaryUtf8Length } from './ordinary-state-codec.js'

export const ORDINARY_SIGNET_KEYS = Object.freeze({
  pubkey: 'signet:login.pubkey', method: 'signet:login.method', authEvent: 'signet:login.authEvent',
  bunkerUri: 'signet:login.bunkerUri', bunkerClientSk: 'signet:login.bunkerClientSk',
  expiresAt: 'signet:login.expiresAt', displayName: 'signet:login.displayName',
  clientSk: 'signet:login.clientSk', pendingRedirect: 'signet:login.pendingRedirect',
  pendingRelayAuth: 'signet:login.pendingRelayAuth',
})
const SESSION: readonly string[] = Object.freeze(['pubkey', 'method', 'authEvent', 'bunkerUri', 'bunkerClientSk', 'expiresAt', 'displayName']
  .map(name => ORDINARY_SIGNET_KEYS[name as keyof typeof ORDINARY_SIGNET_KEYS]))
const ALL: readonly string[] = Object.values(ORDINARY_SIGNET_KEYS)
const HEX = /^[0-9a-f]{64}$/i
function hold(): never { throw new OrdinaryStateHold() }
function value(raw: unknown): asserts raw is string | null {
  if (raw !== null && (typeof raw !== 'string' || raw.length > ORDINARY_VALUE_UNITS)) hold()
}
function plain(raw: unknown, fields: readonly string[]): asserts raw is Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
      Reflect.ownKeys(raw).length !== fields.length || fields.some(name => !Object.hasOwn(raw, name))) hold()
}
function secret(raw: string): void {
  if (!HEX.test(raw)) hold()
  const bytes = hexToBytes(raw)
  try { getPublicKey(bytes) } catch { hold() } finally { bytes.fill(0) }
}
function relay(raw: unknown): void {
  if (typeof raw !== 'string') hold()
  try {
    const url = new URL(raw)
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) hold()
  } catch { hold() }
}
function integer(raw: unknown): raw is number { return Number.isSafeInteger(raw) && (raw as number) >= 0 }
export interface OrdinarySignetSnapshotOptions {
  kind: 'browser' | 'tab'
  origin: string
  appName: string
  account?: string
}
/** Shared offline SDK partition validation, before owner or tab allocation.
 * Counts only: a stored signed proof is integrity evidence at its signed time,
 * never fresh login, room membership, restore permission or SDK readiness.
 * Other namespaces still require the complete physical classifier. */
export function validateOrdinarySignetSnapshot(records: ReadonlyMap<string, string>, options: OrdinarySignetSnapshotOptions):
  Readonly<{ sessions: number; clientKeys: number; pendingRedirects: number; pendingRelayAuths: number }> {
  options = { ...options }
  const counts = { sessions: 0, clientKeys: 0, pendingRedirects: 0, pendingRelayAuths: 0 }
  try {
    if (!['browser', 'tab'].includes(options.kind) || !options.origin || options.origin === 'null' || !options.appName ||
        options.account !== undefined && !/^[0-9a-f]{64}$/.test(options.account)) hold()
    if (new URL(options.origin).origin !== options.origin) hold()
    const selected = new Map<string, string>()
    for (const [name, raw] of records) {
      if (name.startsWith('kithmoot.account.') && name.includes('.signet:login')) hold()
      if (name !== 'signet:login' && !name.startsWith('signet:login.')) continue
      if (options.kind !== 'browser' || !ALL.includes(name) || name.length > ORDINARY_NAME_UNITS) hold()
      value(raw); ordinaryUtf8Length(raw); selected.set(name, raw)
    }
    counts.clientKeys = Number(selected.has(ORDINARY_SIGNET_KEYS.clientSk))
    counts.pendingRedirects = Number(selected.has(ORDINARY_SIGNET_KEYS.pendingRedirect))
    counts.pendingRelayAuths = Number(selected.has(ORDINARY_SIGNET_KEYS.pendingRelayAuth))
    const values = Object.fromEntries(ALL.map(key => [key, selected.get(key) ?? null]))
    for (const raw of Object.values(values)) value(raw)
    const k = ORDINARY_SIGNET_KEYS
    if (values[k.clientSk] !== null) secret(values[k.clientSk]!)
    for (const [key, fields] of [
      [k.pendingRedirect, ['challenge', 'origin', 'appName', 'createdAt']],
      [k.pendingRelayAuth, ['challenge', 'origin', 'appName', 'relayUrl', 'sessionSkHex', 'issuedAt']],
    ] as const) if (values[key] !== null) {
      let record: unknown
      try { record = JSON.parse(values[key]!) } catch { hold() }
      plain(record, fields)
      if (typeof record.challenge !== 'string' || !HEX.test(record.challenge) || record.origin !== options.origin || record.appName !== options.appName) hold()
      if (key === k.pendingRedirect) { if (!integer(record.createdAt)) hold() }
      else {
        if (!integer(record.issuedAt) || typeof record.sessionSkHex !== 'string') hold()
        secret(record.sessionSkHex); relay(record.relayUrl)
      }
    }
    if (SESSION.every(key => values[key] === null)) return Object.freeze(counts)
    const pubkey = values[k.pubkey], method = values[k.method], proof = values[k.authEvent]
    if (!pubkey || !HEX.test(pubkey) || !method || !['nip07', 'redirect', 'bunker', 'amber'].includes(method) || !proof ||
        options.account !== undefined && pubkey.toLowerCase() !== options.account) hold()
    let parsed: unknown
    try { parsed = JSON.parse(proof) } catch { hold() }
    plain(parsed, ['id', 'pubkey', 'kind', 'created_at', 'tags', 'content', 'sig'])
    if (!integer(parsed.created_at) || !Array.isArray(parsed.tags) || parsed.tags.length > 128 ||
        parsed.tags.some(tag => !Array.isArray(tag) || tag.length > 32 || tag.some(part => typeof part !== 'string' || part.length > 1024))) hold()
    const bindings = (name: string) => (parsed.tags as string[][]).filter(tag => tag[0] === name)
    const challenge = bindings('challenge'), origin = bindings('origin'), app = bindings('app')
    if (challenge.length !== 1 || challenge[0]!.length !== 2 || origin.length !== 1 || origin[0]!.length !== 2 ||
        app.length > 1 || app.length === 1 && (app[0]!.length !== 2 || app[0]![1] !== options.appName)) hold()
    const event = parsed as unknown as SignetAuthEvent
    if (event.pubkey !== pubkey) hold()
    // Stored proof integrity is checked at its signed time. It is not a fresh
    // server login and is never accepted as MLS membership evidence here.
    const checked = verifyLogin(event, { expectedOrigin: options.origin,
      expectedChallenge: challenge[0]![1]!, now: () => event.created_at * 1000 })
    if (!checked.valid || checked.pubkey !== pubkey) hold()
    const expires = values[k.expiresAt]
    if (expires !== null && (!integer(Number(expires)) || String(Number(expires)) !== expires)) hold()
    if (method === 'bunker') {
      if (!values[k.bunkerClientSk] || !values[k.bunkerUri]) hold()
      secret(values[k.bunkerClientSk]!)
      try {
        const url = new URL(values[k.bunkerUri]!)
        if (url.protocol !== 'bunker:' || !HEX.test(url.hostname) || url.username || url.password || url.hash || url.pathname || !url.searchParams.getAll('relay').length) hold()
        for (const item of url.searchParams.getAll('relay')) relay(item)
      } catch { hold() }
    } else if (values[k.bunkerClientSk] !== null || values[k.bunkerUri] !== null) hold()
    counts.sessions = 1
    return Object.freeze(counts)
  } catch { return hold() }
}
