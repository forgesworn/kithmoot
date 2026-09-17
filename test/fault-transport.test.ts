import { describe, it, expect } from 'vitest'
import type { Event } from 'nostr-tools/pure'
import { FaultRelay } from './fault-transport.js'

const WRAP = 21_059
const CHAT = 20_462

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

let counter = 0
function signal(from: string, to: string, kind = WRAP): Event {
  counter += 1
  return {
    id: `event-${counter}`,
    pubkey: from,
    created_at: 1_700_000_000 + counter,
    kind,
    tags: [['p', to]],
    content: '',
    sig: '',
  } as Event
}

/** Both devices listening for what is addressed to them, as a real client does. */
function room(seed = 1) {
  const hub = new FaultRelay({ seed })
  const a = hub.transport(A)
  const b = hub.transport(B)
  const atB: Event[] = []
  const atA: Event[] = []
  b.subscribe([{ kinds: [WRAP, CHAT], '#p': [B] }], (event) => atB.push(event))
  a.subscribe([{ kinds: [WRAP, CHAT], '#p': [A] }], (event) => atA.push(event))
  return { hub, a, b, atA, atB }
}

describe('fault-transport', () => {
  it('delivers by p tag and by nothing else when no fault is set', async () => {
    const { a, b, atA, atB } = room()
    await a.publish(signal(A, B))
    await b.publish(signal(B, A))
    expect(atB).toHaveLength(1)
    expect(atA).toHaveLength(1)
  })

  it('drops on one directed pair only', async () => {
    const { hub, a, b, atA, atB } = room()
    hub.fault({ from: A, to: B, drop: 1 })
    await a.publish(signal(A, B))
    await b.publish(signal(B, A))
    expect(atB, 'A to B is in the drop window').toHaveLength(0)
    expect(atA, 'B to A is not').toHaveLength(1)
    expect(hub.log.map((l) => l.verdict)).toEqual(['dropped', 'delivered'])
  })

  it('drops by kind', async () => {
    const { hub, a, atB } = room()
    hub.fault({ kind: WRAP, drop: 1 })
    await a.publish(signal(A, B, WRAP))
    await a.publish(signal(A, B, CHAT))
    expect(atB.map((e) => e.kind)).toEqual([CHAT])
  })

  it('drops exactly the next N and then gets out of the way', async () => {
    const { hub, a, atB } = room()
    hub.fault({ from: A, to: B, dropNext: 2 })
    await a.publish(signal(A, B))
    await a.publish(signal(A, B))
    await a.publish(signal(A, B))
    expect(atB).toHaveLength(1)
  })

  it('delays until the clock is turned', async () => {
    const { hub, a, atB } = room()
    hub.fault({ from: A, to: B, delayMs: 500 })
    await a.publish(signal(A, B))
    expect(atB).toHaveLength(0)
    expect(hub.inFlight).toBe(1)
    hub.advance(499)
    expect(atB).toHaveLength(0)
    hub.advance(1)
    expect(atB).toHaveLength(1)
  })

  it('duplicates, which is what a retransmission has to be idempotent against', async () => {
    const { hub, a, atB } = room()
    hub.fault({ from: A, to: B, duplicate: 1 })
    const event = signal(A, B)
    await a.publish(event)
    expect(atB.map((e) => e.id)).toEqual([event.id, event.id])
  })

  it('reorders: the second signal overtakes the first', async () => {
    const { hub, a, atB } = room()
    hub.fault({ from: A, to: B, reorder: 1 })
    const first = signal(A, B)
    const second = signal(A, B)
    await a.publish(first)
    expect(atB, 'the first is held').toHaveLength(0)
    await a.publish(second)
    expect(atB.map((e) => e.id)).toEqual([second.id, first.id])
  })

  it('a held signal still arrives when the test flushes', async () => {
    const { hub, a, atB } = room()
    hub.fault({ from: A, to: B, reorder: 1 })
    const only = signal(A, B)
    await a.publish(only)
    expect(atB).toHaveLength(0)
    hub.flush()
    expect(atB.map((e) => e.id)).toEqual([only.id])
  })

  it('is deterministic for a seed, and different for another', async () => {
    const verdicts = async (seed: number) => {
      const { hub, a } = room(seed)
      hub.fault({ from: A, to: B, drop: 0.5 })
      for (let i = 0; i < 16; i++) await a.publish(signal(A, B))
      return hub.log.map((l) => l.verdict).join(',')
    }
    expect(await verdicts(7)).toBe(await verdicts(7))
    expect(await verdicts(7)).not.toBe(await verdicts(8))
  })

  it('half-open: publishing resolves, nothing moves, and nothing is replayed on reconnect', async () => {
    const { a, b, atB } = room()
    a.disconnect()
    await expect(a.publish(signal(A, B))).resolves.toBeUndefined()
    expect(atB).toHaveLength(0)
    a.reconnect()
    expect(atB, 'a relay does not replay an ephemeral kind').toHaveLength(0)
    await a.publish(signal(A, B))
    expect(atB, 'and the socket works again').toHaveLength(1)
    expect(b.received).toHaveLength(1)
  })

  it('a disconnected reader misses what was sent while it was away', async () => {
    const { a, b, atB } = room()
    b.disconnect()
    await a.publish(signal(A, B))
    expect(atB).toHaveLength(0)
    b.reconnect()
    await a.publish(signal(A, B))
    expect(atB).toHaveLength(1)
  })

  it('error mode rejects the publish, which half-open deliberately does not', async () => {
    const { a } = room()
    a.disconnect('error')
    await expect(a.publish(signal(A, B))).rejects.toThrow(/unreachable/)
  })
})
