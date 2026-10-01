import { expect, test } from 'vitest'
import { isMissingInvitation, linkOnlyRelays, widerInvitationRelays } from './invitation-lookup.js'

const noCircle = (): boolean => false

test('only a missing invitation widens the search', () => {
  expect(isMissingInvitation(new Error('the group invitation is not available on its relays'))).toBe(true)
  expect(isMissingInvitation(new Error('the group invitation could not be loaded from its relays'))).toBe(true)
  expect(isMissingInvitation(new Error('this invitation was retired'))).toBe(false)
  expect(isMissingInvitation(new Error('the group invitation names conflicting rooms'))).toBe(false)
})

test('asks this device’s relays, then the defaults, never the link’s again', () => {
  expect(widerInvitationRelays(
    ['wss://nos.lol', 'wss://relay.primal.net/'],
    ['wss://relay.damus.io', 'wss://NOS.LOL'],
    ['wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom', 'wss://relay.damus.io'],
    noCircle,
  )).toEqual(['wss://relay.damus.io', 'wss://nostr.mom'])
})

test('a sheltered link never goes looking on public relays', () => {
  const circle = (url: string): boolean => url === 'wss://box.example'
  expect(widerInvitationRelays(['wss://box.example'], ['wss://relay.damus.io'], ['wss://nos.lol'], circle)).toEqual([])
})

test('a circle relay of this device is not asked about somebody else’s link', () => {
  const circle = (url: string): boolean => url === 'wss://box.example'
  expect(widerInvitationRelays(['wss://nos.lol'], ['wss://box.example'], ['wss://nostr.mom'], circle)).toEqual(['wss://nostr.mom'])
})

test('a re-signed invitation also reaches the relays only the link names', () => {
  expect(linkOnlyRelays(['wss://relay.damus.io', 'wss://nos.lol'], ['wss://nos.lol/', 'wss://relay.primal.net'], noCircle))
    .toEqual(['wss://relay.primal.net'])
  expect(linkOnlyRelays(['wss://nos.lol'], ['wss://box.example'], url => url === 'wss://box.example')).toEqual([])
})
