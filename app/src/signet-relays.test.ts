import { describe, expect, it } from 'vitest'
import { parseBunkerInput } from 'nostr-tools/nip46'
import { SIGNET_RELAY, signinRelays, withSignetRelay } from './signet-relays.js'

const signer = 'a'.repeat(64)

describe('signinRelays', () => {
  it('keeps the first relay first and puts Signet\'s within the three a link carries', () => {
    expect(signinRelays(['wss://relay.primal.net', 'wss://nostr.mom', 'wss://relay.damus.io'])).toEqual(['wss://relay.primal.net', SIGNET_RELAY, 'wss://nostr.mom', 'wss://relay.damus.io'])
  })

  it('does not repeat Signet\'s relay already in the list', () => {
    expect(signinRelays(['wss://nos.lol/', 'wss://relay.primal.net'])).toEqual(['wss://nos.lol/', 'wss://relay.primal.net'])
    expect(signinRelays(['wss://relay.primal.net', 'wss://NOS.lol'])).toEqual(['wss://relay.primal.net', SIGNET_RELAY])
  })

  it('falls back to Signet\'s relay alone', () => {
    expect(signinRelays([])).toEqual([SIGNET_RELAY])
  })
})

describe('withSignetRelay', () => {
  it('adds Signet\'s relay to a stored link and keeps everything else', async () => {
    const stored = `bunker://${signer}?relay=wss%3A%2F%2Frelay.primal.net&secret=s3cret`
    const updated = withSignetRelay(stored)!
    const pointer = await parseBunkerInput(updated)
    expect(pointer).toEqual({ pubkey: signer, relays: ['wss://relay.primal.net', SIGNET_RELAY], secret: 's3cret' })
  })

  it('leaves a link that already names it, or is not a bunker link', () => {
    expect(withSignetRelay(`bunker://${signer}?relay=wss://nos.lol/`)).toBeUndefined()
    expect(withSignetRelay('nostrconnect://x?relay=wss://a')).toBeUndefined()
    expect(withSignetRelay('not a link')).toBeUndefined()
  })
})
