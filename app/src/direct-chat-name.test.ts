import { describe, expect, it } from 'vitest'
import { directChatName } from './direct-chat-name.js'

describe('personal direct-chat titles', () => {
  it('shows the counterpart on each side even when an old shared name is wrong', () => {
    expect(directChatName({ selfName: 'Rowan', peerName: 'Taylor', rememberedName: 'Taylor' })).toBe('Taylor')
    expect(directChatName({ selfName: 'Taylor', peerName: 'Rowan', rememberedName: 'Taylor' })).toBe('Rowan')
  })
  it('keeps a chosen personal label ahead of profile changes', () => {
    expect(directChatName({ chatLabel: 'Taylor at work', peerName: 'Taylor', rosterName: 'Taylor' })).toBe('Taylor at work')
  })
  it('uses roster or remembered counterpart names offline, without claiming our own name is theirs', () => {
    expect(directChatName({ rosterName: 'Rowan', rememberedName: 'Taylor', selfName: 'Taylor' })).toBe('Rowan')
    expect(directChatName({ rememberedName: 'Rowan', selfName: 'Taylor' })).toBe('Rowan')
    expect(directChatName({ rememberedName: 'Taylor', selfName: 'Taylor' })).toBe('Private chat')
  })
  it('allows two people with the same verified name and sanitises labels', () => {
    expect(directChatName({ peerName: 'Sam', selfName: 'Sam' })).toBe('Sam')
    expect(directChatName({ chatLabel: ' \u200b ', peerName: 'Taylor' })).toBe('Taylor')
  })
})
