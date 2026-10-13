import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { ORDINARY_SIGNET_KEYS } from './ordinary-signet-snapshot.js'
import type { ordinaryPairCustodyFor } from './ordinary-state-owner.js'

export const ORDINARY_INITIAL_LOGIN_KEY = 'kithmoot.initial-login.v1'
export const ORDINARY_INITIAL_LOGIN_SCOPE = '@ordinary-signet'
export const ORDINARY_INITIAL_LOGIN_MS = 300_000
export const ORDINARY_INITIAL_LOGIN_BYTES = 4096
export const ORDINARY_SIGNET_SESSION_NAMES = ['pubkey', 'method', 'authEvent', 'bunkerUri', 'bunkerClientSk', 'expiresAt', 'displayName'] as const
const HEX = /^[0-9a-f]{64}$/
function hold(): never { throw new OrdinaryStateHold() }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function object(value: unknown, names: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).join(',') !== names.join(',')) hold()
}
export interface OrdinaryInitialLoginRecord {
  readonly version: 1
  readonly method: 'nip07'
  readonly origin: string
  readonly appName: 'KithMoot'
  readonly challenge: string
  readonly account: string | null
  readonly createdAt: number
  readonly expiresAt: number
  readonly browser: Readonly<{ generation: string; fence: number }>
  readonly tab: Readonly<{ purpose: string; generation: string; fence: number }>
}
/** A pending challenge is retained protocol state, never a login or room
 * authority. Expired records remain intact until explicit fenced cancellation. */
export function parseOrdinaryInitialLogin(raw: string, origin: string): OrdinaryInitialLoginRecord {
  try {
    if (typeof raw !== 'string' || raw.length > ORDINARY_INITIAL_LOGIN_BYTES) hold()
    const value: unknown = JSON.parse(raw)
    object(value, ['version', 'method', 'origin', 'appName', 'challenge', 'account', 'createdAt', 'expiresAt', 'browser', 'tab'])
    if (JSON.stringify(value) !== raw || value.version !== 1 || value.method !== 'nip07' || value.origin !== origin ||
        value.appName !== 'KithMoot' || typeof value.challenge !== 'string' || !HEX.test(value.challenge) ||
        value.account !== null && (typeof value.account !== 'string' || !HEX.test(value.account)) ||
        !integer(value.createdAt) || !integer(value.expiresAt) || value.expiresAt <= value.createdAt ||
        value.expiresAt - value.createdAt > ORDINARY_INITIAL_LOGIN_MS) hold()
    object(value.browser, ['generation', 'fence']); object(value.tab, ['purpose', 'generation', 'fence'])
    if (typeof value.browser.generation !== 'string' || !HEX.test(value.browser.generation) || !integer(value.browser.fence) ||
        typeof value.tab.purpose !== 'string' || !/^tab:[0-9a-f]{64}$/.test(value.tab.purpose) ||
        typeof value.tab.generation !== 'string' || !HEX.test(value.tab.generation) || !integer(value.tab.fence)) hold()
    return Object.freeze({ ...value, browser: Object.freeze({ ...value.browser }), tab: Object.freeze({ ...value.tab }) }) as unknown as OrdinaryInitialLoginRecord
  } catch { return hold() }
}
export function validateOrdinaryInitialLoginSnapshot(browser: ReadonlyMap<string, string>, tab: ReadonlyMap<string, string>,
  origin: string, custody?: ReturnType<typeof ordinaryPairCustodyFor>): number {
  if (browser.has(ORDINARY_INITIAL_LOGIN_KEY)) hold()
  const raw = tab.get(ORDINARY_INITIAL_LOGIN_KEY)
  if (raw === undefined) return 0
  const pending = parseOrdinaryInitialLogin(raw, origin), name = ORDINARY_INITIAL_LOGIN_SCOPE
  if (!custody || pending.browser.generation !== custody.browser.generation || pending.browser.fence !== (custody.browser.fences.get(name) ?? 0) ||
      pending.tab.purpose !== custody.tab.purpose || pending.tab.generation !== custody.tab.generation ||
      pending.tab.fence !== (custody.tab.fences.get(name) ?? 0) || pending.expiresAt > custody.tab.expiresAt ||
      ORDINARY_SIGNET_SESSION_NAMES.some(name => browser.has(ORDINARY_SIGNET_KEYS[name])) ||
      browser.has(ORDINARY_SIGNET_KEYS.pendingRedirect) || browser.has(ORDINARY_SIGNET_KEYS.pendingRelayAuth)) hold()
  return 1
}
