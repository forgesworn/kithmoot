import { describe, it, expect } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { SimRelay } from './sim-relay.js'

function evt(kind: number, tags: string[][] = []) {
  return finalizeEvent(
    { kind, created_at: Math.floor(Date.now() / 1000), tags, content: 'x' },
    generateSecretKey(),
  )
}

describe('SimRelay', () => {
  it('delivers a published event to a matching subscriber', () => {
    const relay = new SimRelay()
    const seen: string[] = []
    relay.subscribe([{ kinds: [20461] }], (e) => seen.push(e.id))
    const e = evt(20461)
    relay.publish(e)
    expect(seen).toEqual([e.id])
  })

  it('does not deliver an event to a non-matching subscriber', () => {
    const relay = new SimRelay()
    const seen: string[] = []
    relay.subscribe([{ kinds: [20461] }], (e) => seen.push(e.id))
    relay.publish(evt(20462))
    expect(seen).toEqual([])
  })

  it('matches on tag filters', () => {
    const relay = new SimRelay()
    const seen: string[] = []
    relay.subscribe([{ kinds: [20461], '#d': ['room-a'] }], (e) => seen.push(e.id))
    relay.publish(evt(20461, [['d', 'room-b']]))
    expect(seen).toEqual([])
    const wanted = evt(20461, [['d', 'room-a']])
    relay.publish(wanted)
    expect(seen).toEqual([wanted.id])
  })

  it('stops delivering after unsubscribe', () => {
    const relay = new SimRelay()
    const seen: string[] = []
    const unsub = relay.subscribe([{ kinds: [20461] }], (e) => seen.push(e.id))
    unsub()
    relay.publish(evt(20461))
    expect(seen).toEqual([])
  })

  it('records everything published so tests can assert on the wire', () => {
    const relay = new SimRelay()
    const e = evt(20461)
    relay.publish(e)
    expect(relay.published.map((x) => x.id)).toEqual([e.id])
  })
})
