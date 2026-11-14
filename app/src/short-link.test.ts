import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { encodeNodeRoomLink, encodeShortNodeRoomLink, signNodeRoom } from '@forgesworn/fold-kit/node-room'
import { appLinkForShort } from './short-link.js'

const record = (now: number, endsAt?: number) => signNodeRoom({ authoritySk: generateSecretKey(), room: getPublicKey(generateSecretKey()),
  origin: 'https://node.example', serviceKey: getPublicKey(generateSecretKey()), now, ...(endsAt === undefined ? {} : { endsAt }) })
const now = 1_800_000_000

describe('the short-link page', () => {
  it('sends an open short link to the app as the long link the app itself would write', () => {
    const event = record(now, now + 3600)
    const short = encodeShortNodeRoomLink('https://kithmoot.forgesworn.dev/n/', event, now)
    expect(appLinkForShort(short, now)).toBe(encodeNodeRoomLink('https://kithmoot.forgesworn.dev/j/', event, now))
  })

  it('keeps the query, and works from the page with or without its slash', () => {
    const event = record(now)
    const short = encodeShortNodeRoomLink('https://host.example/n/?via=qr', event, now)
    expect(appLinkForShort(short, now)).toBe(encodeNodeRoomLink('https://host.example/j/?via=qr', event, now))
    const hash = new URL(short).hash
    expect(appLinkForShort(`https://host.example/n/index.html?via=qr${hash}`, now)).toBe(encodeNodeRoomLink('https://host.example/j/?via=qr', event, now))
  })

  it('passes an ended or early link on unchanged, so the door can say why', () => {
    const ended = record(now - 7200, now - 3600), early = record(now + 3600)
    for (const [event, signedAt] of [[ended, now - 7200], [early, now + 3600]] as const) {
      const hash = new URL(encodeShortNodeRoomLink('https://host.example/n/', event, signedAt)).hash
      expect(appLinkForShort(`https://host.example/n/${hash}`, now)).toBe(`https://host.example/j/${hash}`)
    }
  })

  it('passes a long link, a broken one or none at all on unchanged', () => {
    const long = encodeNodeRoomLink('https://host.example/n/', record(now), now)
    expect(appLinkForShort(long, now)).toBe(`https://host.example/j/${new URL(long).hash}`)
    expect(appLinkForShort('https://host.example/n/#not-a-link', now)).toBe('https://host.example/j/#not-a-link')
    expect(appLinkForShort('https://host.example/n/', now)).toBe('https://host.example/j/')
  })

  it('never leaves the page’s own origin', () => {
    expect(new URL(appLinkForShort('https://host.example/n/#//evil.example/', now)).origin).toBe('https://host.example')
  })
})
