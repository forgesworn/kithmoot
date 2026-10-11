import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Event } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils'
import { decodeChatEvent } from './chat.js'

const fixture: {
  roomId: string; roomKey: string; now: number
  vectors: { name: string; channel: string; accepted: boolean; event: Event; expected: unknown }[]
} = JSON.parse(readFileSync(new URL('../vectors/room-logo-chat-v1.json', import.meta.url), 'utf8'))

describe('credential-bound room logo cross-client vectors', () => {
  it.each(fixture.vectors)('$name', ({ channel, accepted, event, expected }) => {
    const decoded = decodeChatEvent(event, {
      roomId: fixture.roomId, roomKey: hexToBytes(fixture.roomKey), now: fixture.now, channel,
    })
    expect(decoded !== null).toBe(accepted)
    if (decoded) {
      expect(Object.fromEntries(['id', 'participant', 'device', 'text', 'sentAt', 'roomLogo']
        .map(key => [key, decoded[key as keyof typeof decoded]]))).toEqual(expected)
    }
  })
})
