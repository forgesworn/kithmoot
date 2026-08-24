import { describe, it, expect } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../test/sim-relay.js'

function evt(kind: number, tags: string[][] = []) {
  return finalizeEvent(
    { kind, created_at: Math.floor(Date.now() / 1000), tags, content: 'x' },
    generateSecretKey(),
  )
}

describe('SimTransport satisfies RelayTransport', () => {
  it('publishes and delivers through the transport interface', async () => {
    const transport = new SimTransport(new SimRelay())
    const seen: string[] = []
    transport.subscribe([{ kinds: [20461] }], (e) => seen.push(e.id))
    const e = evt(20461)
    await transport.publish(e)
    expect(seen).toEqual([e.id])
  })

  it('stops delivering after the returned unsubscribe is called', async () => {
    const transport = new SimTransport(new SimRelay())
    const seen: string[] = []
    const unsub = transport.subscribe([{ kinds: [20461] }], (e) => seen.push(e.id))
    unsub()
    await transport.publish(evt(20461))
    expect(seen).toEqual([])
  })

  it('throws once closed', async () => {
    const transport = new SimTransport(new SimRelay())
    transport.close()
    await expect(transport.publish(evt(20461))).rejects.toThrow()
  })
})
