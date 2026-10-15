import { acceptChannelCheck, beginChannelCheck, channelCheckHash, confirmChannelCheckRevealSent,
  parseChannelCheckMessage, receiveChannelCheckAcceptance, receiveChannelCheckReveal,
  type ChannelCheckMessage, type ChannelCheckRequest, type ChannelCheckState } from '@forgesworn/signet-contacts'
import { OrdinaryStateHold, ORDINARY_NAME_UNITS } from './ordinary-state-codec.js'

const FAMILY = 'kithmoot.channel-checks'
const KEY = /^kithmoot\.channel-checks\.v1\.([0-9a-f]{64})\.([0-9a-f]{64})$/
const HEX = /^[0-9a-f]{64}$/
function hold(): never { throw new OrdinaryStateHold() }
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) hold()
}
function message(value: unknown): ChannelCheckMessage {
  object(value, ['v', 'id', 'context', 'from', 'to', 'createdAt', 'type'], ['expiresAt', 'commitment', 'requestHash', 'acceptanceHash', 'nonce'])
  const fields = value.type === 'channel-check-request' ? ['expiresAt', 'commitment'] :
    value.type === 'channel-check-accept' ? ['requestHash', 'nonce'] :
      value.type === 'channel-check-reveal' ? ['requestHash', 'acceptanceHash', 'nonce'] : hold()
  object(value, ['v', 'id', 'context', 'from', 'to', 'createdAt', 'type', ...fields])
  const parsed = parseChannelCheckMessage(JSON.stringify(value))
  if (!parsed) hold()
  return parsed
}
// Constructors and parsers use different key orders. Compare every allowed
// field without normalising or replacing the retained JSON bytes.
function same(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && same(a[key], b[key]))
}
function state(value: unknown, request: ChannelCheckRequest, local: string): ChannelCheckState {
  object(value, ['role', 'request', 'nonce', 'phase'], ['acceptance', 'reveal'])
  if (!same(message(value.request), request) || typeof value.nonce !== 'string' || !HEX.test(value.nonce)) hold()
  const acceptance = Object.hasOwn(value, 'acceptance') ? message(value.acceptance) : undefined
  const reveal = Object.hasOwn(value, 'reveal') ? message(value.reveal) : undefined
  if (acceptance && acceptance.type !== 'channel-check-accept' || reveal && reveal.type !== 'channel-check-reveal') hold()
  let restored: ChannelCheckState
  if (local === request.from && value.role === 'requester') {
    restored = beginChannelCheck(request, value.nonce)
    if (acceptance) {
      if (!reveal || acceptance.type !== 'channel-check-accept') hold()
      restored = receiveChannelCheckAcceptance(restored, acceptance, reveal.createdAt)
      if (value.phase === 'complete') restored = confirmChannelCheckRevealSent(restored)
    }
  } else if (local === request.to && value.role === 'recipient' && acceptance?.type === 'channel-check-accept') {
    restored = acceptChannelCheck(request, value.nonce, acceptance.createdAt)
    if (reveal) {
      if (reveal.type !== 'channel-check-reveal') hold()
      restored = receiveChannelCheckReveal(restored, reveal, reveal.createdAt)
    }
  } else hold()
  if (!same(restored, value)) hold()
  return restored
}

/** Offline custody only: historical transcript consistency cannot authenticate
 * the original channel or establish a human comparison. No nonce, words,
 * participant identifiers or protocol state escape the count-only result.
 * The complete composite must classify all other private families. */
export function validateOrdinaryChannelCheckSnapshot(records: ReadonlyMap<string, string>, _migrated: boolean,
  options: { kind: 'browser' | 'tab' }): Readonly<{ histories: number; checks: number; localComparisons: number }> {
  if (!['browser', 'tab'].includes(options.kind)) hold()
  const counts = { histories: 0, checks: 0, localComparisons: 0 }
  try {
    for (const [name, raw] of records) {
      if (name.startsWith('kithmoot.account.') && name.includes('.' + FAMILY)) hold()
      if (name !== FAMILY && !name.startsWith(FAMILY + '.')) continue
      const key = KEY.exec(name)
      if (!key || options.kind !== 'browser' || name.length > ORDINARY_NAME_UNITS || typeof raw !== 'string' || raw.length > 1024 * 1024) hold()
      const local = key[1]!, context = key[2]!, rows: unknown = JSON.parse(raw)
      // The controller never deletes rows or writes an empty history. Its
      // empty in-memory list comes only from an absent physical key.
      if (JSON.stringify(rows) !== raw || !Array.isArray(rows) || rows.length < 1 || rows.length > 256) hold()
      const ids = new Set<string>()
      for (const row of rows) {
        object(row, ['request'], ['state', 'declined', 'sent', 'checkedAt'])
        const request = message(row.request)
        if (request.type !== 'channel-check-request' || request.context !== context ||
            request.from !== local && request.to !== local || ids.has(request.id)) hold()
        ids.add(request.id)
        const saved = Object.hasOwn(row, 'state') ? state(row.state, request, local) : undefined
        if (!saved && request.from === local || Object.hasOwn(row, 'declined') && (row.declined !== true || saved)) hold()
        if (Object.hasOwn(row, 'sent')) {
          // Preserve the old request hash across the requester state-advance
          // before flush, and the absent sent marker after an explicit retry.
          // A recipient can only have emitted its own acceptance.
          const sent = saved?.role === 'recipient' ? saved.acceptance :
            saved?.phase === 'complete' ? saved.reveal : saved?.request
          if (!sent || row.sent !== channelCheckHash(sent)) hold()
        }
        if (Object.hasOwn(row, 'checkedAt')) {
          if (!Number.isSafeInteger(row.checkedAt) || saved?.phase !== 'complete' || !saved.reveal ||
              (row.checkedAt as number) < saved.reveal.createdAt) hold()
          counts.localComparisons++
        }
        counts.checks++
      }
      counts.histories++
    }
    return Object.freeze(counts)
  } catch { return hold() }
}
