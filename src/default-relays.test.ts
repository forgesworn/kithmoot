import { describe, expect, it } from 'vitest'
import { DEFAULT_RELAYS } from './agent.js'

describe('public room relay defaults', () => {
  it('are third-party public relays only, none run by the project', () => {
    expect(DEFAULT_RELAYS).toEqual(['wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom'])
  })
})
