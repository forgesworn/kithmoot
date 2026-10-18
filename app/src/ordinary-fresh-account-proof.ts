import { SIGNET_VERIFIED_EVENT_SYMBOL, type SignetAuthEvent } from 'signet-login'
import { verifyEventUncached } from '../../src/verify.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'

const HEX = /^[0-9a-f]{64}$/
const FIELDS = ['kind', 'created_at', 'tags', 'content', 'pubkey', 'id', 'sig'] as const
/** Bounds surround the SDK's synchronous template construction, not the
 * potentially unabortable wallet wait. A clock jump refuses this attempt. */
export const ORDINARY_AUTH_STATEMENT_WINDOW_MS = 1_000
export interface OrdinaryFreshAccountProofExpectation {
  readonly account: string
  readonly challenge: string
  readonly origin: string
  readonly sdkStartedAt: number
  readonly sdkPreparedAt: number
}
function hold(): never { throw new OrdinaryStateHold() }
function own(input: object, name: PropertyKey): unknown {
  const field = Object.getOwnPropertyDescriptor(input, name)
  if (!field || !Object.hasOwn(field, 'value')) hold()
  return field.value
}
function exactArray(input: unknown, length: number): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype ||
      own(input, 'length') !== length || Reflect.ownKeys(input).length !== length + 1) hold()
  return Array.from({ length }, (_, index) => own(input, String(index)))
}

/** Pure detached verification, not an authority or custody receipt. The private
 * native producer must own the nonce, time bounds and selected account, repeat
 * its full native decision after verification, and consume the proof once in
 * its fixed foreground/member handoff. Historical stored auth stays unchanged. */
export function captureOrdinaryFreshAccountProof(
  input: unknown, expectation: OrdinaryFreshAccountProofExpectation,
): Readonly<SignetAuthEvent> {
  if (!expectation || Object.getPrototypeOf(expectation) !== Object.prototype ||
      Reflect.ownKeys(expectation).length !== 5) hold()
  const account = own(expectation, 'account'), challenge = own(expectation, 'challenge'),
    origin = own(expectation, 'origin'), before = own(expectation, 'sdkStartedAt'), after = own(expectation, 'sdkPreparedAt')
  if (typeof account !== 'string' || !HEX.test(account) || typeof challenge !== 'string' || !HEX.test(challenge) ||
      typeof origin !== 'string' || !origin || origin.length > 1024 ||
      typeof before !== 'number' || !Number.isSafeInteger(before) || before < 0 ||
      typeof after !== 'number' || !Number.isSafeInteger(after) || after < before ||
      after - before > ORDINARY_AUTH_STATEMENT_WINDOW_MS) hold()
  let url: URL
  try { url = new URL(origin) } catch { hold() }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) hold()
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) hold()
  const names = Reflect.ownKeys(input)
  if (FIELDS.some(name => !names.includes(name)) ||
      names.some(name => !FIELDS.includes(name as typeof FIELDS[number]) && name !== SIGNET_VERIFIED_EVENT_SYMBOL)) hold()
  if (names.includes(SIGNET_VERIFIED_EVENT_SYMBOL) && own(input, SIGNET_VERIFIED_EVENT_SYMBOL) !== true) hold()
  const kind = own(input, 'kind'), created_at = own(input, 'created_at'), content = own(input, 'content'),
    pubkey = own(input, 'pubkey'), id = own(input, 'id'), sig = own(input, 'sig'), tags = own(input, 'tags')
  if (kind !== 21236 || content !== '' || pubkey !== account ||
      typeof created_at !== 'number' || !Number.isSafeInteger(created_at) ||
      created_at < Math.floor(before / 1000) || created_at > Math.floor(after / 1000) ||
      typeof id !== 'string' || !HEX.test(id) || typeof sig !== 'string' || !/^[0-9a-f]{128}$/.test(sig)) hold()
  const expected = [['challenge', challenge], ['origin', origin], ['app', 'KithMoot']]
  const copied = exactArray(tags, 3).map((tag, index) => {
    const parts = exactArray(tag, 2)
    if (parts[0] !== expected[index]![0] || parts[1] !== expected[index]![1]) hold()
    return Object.freeze([parts[0] as string, parts[1] as string])
  })
  const event = { kind: 21236 as const, created_at, tags: copied.map(tag => [...tag]), content: '', pubkey: account, id, sig }
  // Never trust a provider/SDK cache flag, and never let verification mutate
  // the input or a retained native snapshot. The known flag is stripped above.
  if (!verifyEventUncached(event)) hold()
  return Object.freeze({ ...event, tags: Object.freeze(copied) }) as unknown as Readonly<SignetAuthEvent>
}
