import { describe, it, expect } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import {
  KIND_DM_RELAYS,
  KIND_RELAY_LIST,
  MAX_DM_RELAYS,
  inboxRelays,
  dmRelayListTemplate,
  latestDmRelayList,
  parseDmRelayList,
  relaysForPrivateConversation,
} from './dm-relays.js'
import { normaliseRelayConfig } from './relay-pool.js'

/** The project's canonical relay form, which is what every list returns. */
const c = (...urls: string[]) => urls.map(url => normaliseRelayConfig([url])[0]!.url)

const NOW = 1_800_000_000

/** A copy as a relay would deliver it: nostr-tools caches a verified flag on
 *  the object it signed, and a spread would carry that flag onto a forgery. */
const wire = <T,>(event: T): T => JSON.parse(JSON.stringify(event)) as T

function list(sk: Uint8Array, relays: string[], at = NOW, kind = KIND_DM_RELAYS) {
  return finalizeEvent({ kind, created_at: at, tags: relays.map(url => ['relay', url]), content: '' }, sk)
}

describe('DM relay lists', () => {
  it('builds the NIP-17 kind 10050 event, and reads it back canonical', () => {
    const template = dmRelayListTemplate(['wss://relay.trotters.cc/', 'wss://Nos.lol'], NOW)
    expect(template.kind).toBe(10050)
    expect(template.content).toBe('')
    const sk = generateSecretKey()
    const event = finalizeEvent(template, sk)
    expect(parseDmRelayList(event, getPublicKey(sk))).toEqual(c('wss://relay.trotters.cc', 'wss://nos.lol'))
  })

  it('refuses to publish a list with an unsafe address, none at all, or too many', () => {
    expect(() => dmRelayListTemplate(['ws://relay.example'], NOW)).toThrow()
    expect(() => dmRelayListTemplate(['https://relay.example'], NOW)).toThrow()
    expect(() => dmRelayListTemplate([], NOW)).toThrow()
    expect(() => dmRelayListTemplate(Array.from({ length: MAX_DM_RELAYS + 1 }, (_, i) => `wss://r${i}.example`), NOW)).toThrow()
  })

  it('reads nothing from another kind, another author, a forged event, or an unsafe relay', () => {
    const sk = generateSecretKey()
    expect(parseDmRelayList(list(sk, ['wss://a.example'], NOW, 10002), getPublicKey(sk))).toEqual([])
    expect(parseDmRelayList(list(sk, ['wss://a.example']), getPublicKey(generateSecretKey()))).toEqual([])
    expect(parseDmRelayList({ ...wire(list(sk, ['wss://a.example'])), tags: [['relay', 'wss://b.example']] })).toEqual([])
    expect(parseDmRelayList(list(sk, ['ws://a.example', 'wss://b.example', 'not a url']))).toEqual(c('wss://b.example'))
  })

  it('takes the latest list for an author, even one that names nothing usable', () => {
    const sk = generateSecretKey()
    const me = getPublicKey(sk)
    const older = list(sk, ['wss://old.example'], NOW - 10)
    const newer = list(sk, ['wss://new.example'], NOW)
    expect(latestDmRelayList([older, newer], me)).toEqual(c('wss://new.example'))
    const emptied = list(sk, ['ws://plain.example'], NOW + 10)
    expect(latestDmRelayList([older, newer, emptied], me)).toEqual([])
    const forged = { ...wire(list(sk, ['wss://forged.example'], NOW + 20)), sig: '0'.repeat(128) }
    expect(latestDmRelayList([newer, forged], me)).toEqual(c('wss://new.example'))
  })
})

describe('relaysForPrivateConversation', () => {
  const fallback = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom']

  it('uses the room it was started from when neither person has a list, as before', () => {
    expect(relaysForPrivateConversation({ mine: [], theirs: [], fallback })).toEqual(c(...fallback))
  })

  it('alternates the other person and the starter, theirs first, without repeats', () => {
    expect(relaysForPrivateConversation({
      mine: ['wss://mine1.example', 'wss://shared.example'],
      theirs: ['wss://shared.example', 'wss://theirs2.example'],
      fallback,
    })).toEqual(c('wss://shared.example', 'wss://mine1.example', 'wss://theirs2.example'))
  })

  it('tops a single relay up from the fallback, so one relay down is not the conversation down', () => {
    expect(relaysForPrivateConversation({ mine: ['wss://relay.trotters.cc'], theirs: [], fallback }))
      .toEqual(c('wss://relay.trotters.cc', 'wss://nos.lol'))
  })

  it('caps the conversation at the most a list may name', () => {
    const many = (who: string) => Array.from({ length: MAX_DM_RELAYS }, (_, i) => `wss://${who}${i}.example`)
    const chosen = relaysForPrivateConversation({ mine: many('m'), theirs: many('t'), fallback })
    expect(chosen).toHaveLength(MAX_DM_RELAYS)
    expect(chosen.slice(0, 2)).toEqual(c('wss://t0.example', 'wss://m0.example'))
  })
})

describe('inbox relays', () => {
  const sk = generateSecretKey(), pk = getPublicKey(sk)
  const nip65 = (tags: string[][], at = NOW) => finalizeEvent({ kind: KIND_RELAY_LIST, created_at: at, tags, content: '' }, sk)

  it('prefers the NIP-17 DM relay list', () => {
    const events = [wire(list(sk, ['wss://dm.example'])), wire(nip65([['r', 'wss://read.example']]))]
    expect(inboxRelays(events, pk)).toEqual(c('wss://dm.example'))
  })

  it('falls back to the relays a NIP-65 list reads from, never write-only ones', () => {
    const events = [wire(nip65([['r', 'wss://both.example'], ['r', 'wss://read.example', 'read'], ['r', 'wss://write.example', 'write']]))]
    expect(inboxRelays(events, pk)).toEqual(c('wss://both.example', 'wss://read.example'))
  })

  it('takes the latest list, ignores other authors and forgeries, and is empty with none', () => {
    const other = generateSecretKey()
    const forged = { ...wire(nip65([['r', 'wss://forged.example']], NOW + 5)), sig: '0'.repeat(128) }
    const events = [wire(nip65([['r', 'wss://old.example']], NOW - 10)), wire(nip65([['r', 'wss://new.example']])), forged,
      wire(finalizeEvent({ kind: KIND_RELAY_LIST, created_at: NOW + 9, tags: [['r', 'wss://theirs.example']], content: '' }, other))]
    expect(inboxRelays(events, pk)).toEqual(c('wss://new.example'))
    expect(inboxRelays([], pk)).toEqual([])
  })
})
