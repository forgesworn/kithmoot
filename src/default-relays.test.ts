import { describe, expect, it } from 'vitest'
import { DEFAULT_RELAYS } from './agent.js'
import { DEFAULT_PUBLIC_RELAYS } from './public-relays.js'

describe('public room relay defaults', () => {
  it('are our own relay first, then the three curated public defaults', () => {
    expect(DEFAULT_RELAYS).toEqual(['wss://relay.trotters.cc/', 'wss://relay.primal.net/', 'wss://relay.ditto.pub/', 'wss://offchain.pub/'])
    expect(DEFAULT_RELAYS).toEqual(DEFAULT_PUBLIC_RELAYS.map(relay => relay.url))
  })
})
