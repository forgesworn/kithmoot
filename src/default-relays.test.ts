import { describe, expect, it } from 'vitest'
import { DEFAULT_RELAYS } from './agent.js'
import { DEFAULT_PUBLIC_RELAYS } from './public-relays.js'

describe('public room relay defaults', () => {
  it('are the three curated defaults, none run by the project', () => {
    expect(DEFAULT_RELAYS).toEqual(['wss://relay.primal.net/', 'wss://nostr.oxtr.dev/', 'wss://relay.nostr.net/'])
    expect(DEFAULT_RELAYS).toEqual(DEFAULT_PUBLIC_RELAYS.map(relay => relay.url))
  })
})
