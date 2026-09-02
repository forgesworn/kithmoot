import { describe, it, expect } from 'vitest'
import { decodeControl, encodeControl } from './control.js'

const HOST = 'ab'.repeat(32)

describe('control messages', () => {
  it('round-trips every shape', () => {
    const shapes = [
      { op: 'catalogue?' as const },
      { op: 'catalogue' as const, host: HOST, name: 'Laptop', agents: [{ id: 'ada', name: 'Ada', description: 'Research', listens: true }], running: [{ id: 'ada', name: 'Ada', since: 1 }] },
      { op: 'invite' as const, host: HOST, agent: 'ada' },
      { op: 'dismiss' as const, host: HOST, agent: 'ada' },
      { op: 'invited' as const, host: HOST, agent: 'ada', name: 'Ada', participant: 'cd'.repeat(32) },
      { op: 'dismissed' as const, host: HOST, agent: 'ada', name: 'Ada', reason: 'exited with 1' },
      { op: 'error' as const, host: HOST, agent: 'ada', message: 'no such agent' },
    ]
    for (const shape of shapes) expect(decodeControl(encodeControl(shape))).toEqual(shape)
  })

  it('reads a person typing into the channel as not a control message', () => {
    expect(decodeControl('hello agents')).toBeNull()
    expect(decodeControl('{"op":"invite"}')).toBeNull()
    expect(decodeControl('{"op":"launch","host":"x"}')).toBeNull()
  })

  it('refuses a host that is not a pubkey and an agent id that is not an id', () => {
    expect(decodeControl(JSON.stringify({ op: 'invite', host: 'laptop', agent: 'ada' }))).toBeNull()
    expect(decodeControl(JSON.stringify({ op: 'invite', host: HOST, agent: '../etc' }))).toBeNull()
    expect(decodeControl(JSON.stringify({ op: 'invite', host: HOST, agent: 'Ada Lovelace' }))).toBeNull()
  })

  it('drops catalogue entries it cannot use, keeps the rest, and canonicalises keys', () => {
    const decoded = decodeControl(
      JSON.stringify({
        op: 'catalogue',
        host: HOST.toUpperCase(),
        name: 'Box',
        agents: [{ id: 'ada', name: 'Ada' }, { id: 'no name' }, 'junk', { id: 'bob', name: 'Bob', description: 'x'.repeat(500) }],
        running: [{ id: 'ada', name: 'Ada', since: 'yesterday' }, { id: 'ada', name: 'Ada', since: 5, participant: 'EF'.repeat(32) }],
      }),
    )
    expect(decoded).toEqual({
      op: 'catalogue',
      host: HOST,
      name: 'Box',
      // Bob stays; only his overlong description goes.
      agents: [{ id: 'ada', name: 'Ada' }, { id: 'bob', name: 'Bob' }],
      running: [{ id: 'ada', name: 'Ada', since: 5, participant: 'ef'.repeat(32) }],
    })
  })

  it('refuses to encode something the chat could not carry', () => {
    const agents = Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, name: 'x'.repeat(64), description: 'y'.repeat(140) }))
    expect(() => encodeControl({ op: 'catalogue', host: HOST, name: 'Box', agents, running: [] })).toThrow(/too long/)
  })
})
