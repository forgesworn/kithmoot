import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { encodeNodeRoomLink, longNodeRoomLink, parseNodeRoomLink, signNodeRoom } from '@forgesworn/fold-kit/node-room'
import { shareableRoomLink, shortLinkPageFor } from './share-link.js'
import { appLinkForShort } from './short-link.js'

const now = 1_800_000_000
const base = 'https://kithmoot.app/j/'
const record = () => signNodeRoom({
  authoritySk: generateSecretKey(),
  room: getPublicKey(generateSecretKey()),
  origin: 'https://node.example',
  serviceKey: getPublicKey(generateSecretKey()),
  now,
})

describe('shareableRoomLink', () => {
  it('shares a node room short, on the page beside the app', () => {
    expect(shortLinkPageFor(base)).toBe('https://kithmoot.app/n/')
    expect(shortLinkPageFor('https://host.example/j/index.html')).toBe('https://host.example/n/')
    const node = record()
    const kept = encodeNodeRoomLink(base, node, now)
    const shared = shareableRoomLink(shortLinkPageFor(base), node, now, () => kept)
    expect(shared.startsWith('https://kithmoot.app/n/#')).toBe(true)
    expect(shared.length * 2).toBeLessThan(kept.length)
    expect(parseNodeRoomLink(shared, now)?.event.id).toBe(node.id)
    // The page turns it into exactly the link the device keeps.
    expect(appLinkForShort(shared, now)).toBe(kept)
    expect(longNodeRoomLink(appLinkForShort(shared, now), now)).toBe(kept)
  })

  it('shares the long link while short links are off', () => {
    const node = record()
    const kept = encodeNodeRoomLink(base, node, now)
    expect(shareableRoomLink(undefined, node, now, () => kept)).toBe(kept)
  })

  it('leaves an ordinary room link as it is', () => {
    const ordinary = `${base}#ordinary-room-link`
    expect(shareableRoomLink(shortLinkPageFor(base), undefined, now, () => ordinary)).toBe(ordinary)
  })
})
