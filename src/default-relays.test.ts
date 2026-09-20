import { describe, expect, it } from 'vitest'
import { DEFAULT_RELAYS } from './agent.js'

describe('public room relay defaults', () => {
  it('keep the ForgeSworn relay in temporary-room links', () => {
    expect(DEFAULT_RELAYS).toContain('wss://relay.trotters.cc')
  })
})
