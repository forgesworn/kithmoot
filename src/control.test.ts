import { describe, it, expect } from 'vitest'
import { decodeControl, encodeControl } from './control.js'
import { GRANT_SCOPES, buildGrant, buildReset, buildRevocation, parseGroupEvent, type ParsedGrant } from './group-grants.js'

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
      { op: 'admins' as const, host: HOST, admins: ['ab'.repeat(32), 'cd'.repeat(32)], epoch: 2, sig: 'ef'.repeat(64) },
      { op: 'remove' as const, participant: 'cd'.repeat(32) },
      { op: 'mute' as const, participant: 'cd'.repeat(32) },
      { op: 'close' as const },
      { op: 'nudge' as const, on: true },
      { op: 'nudge' as const, on: false },
    ]
    for (const shape of shapes) expect(decodeControl(encodeControl(shape))).toEqual(shape)
  })

  it('canonicalises an admin list and refuses one it cannot trust the shape of', () => {
    const decoded = decodeControl(JSON.stringify({ op: 'admins', host: HOST, admins: ['CD'.repeat(32), 'ab'.repeat(32), 'ab'.repeat(32)], epoch: 0, sig: 'EF'.repeat(64) }))
    expect(decoded).toEqual({ op: 'admins', host: HOST, admins: ['ab'.repeat(32), 'cd'.repeat(32)], epoch: 0, sig: 'ef'.repeat(64) })
    expect(decodeControl(JSON.stringify({ op: 'admins', host: HOST, admins: ['not a key'], epoch: 0, sig: 'ef'.repeat(64) }))).toBeNull()
    expect(decodeControl(JSON.stringify({ op: 'admins', host: HOST, admins: [], epoch: -1, sig: 'ef'.repeat(64) }))).toBeNull()
    expect(decodeControl(JSON.stringify({ op: 'admins', host: HOST, admins: [], epoch: 0, sig: 'short' }))).toBeNull()
  })

  it('round-trips a channel list, canonicalising it, and refuses one it cannot render', () => {
    const sig = 'ef'.repeat(64)
    const decoded = decodeControl(JSON.stringify({ op: 'channels', host: HOST, channels: ['shipping', 'design', 'shipping'], epoch: 3, sig: 'EF'.repeat(64) }))
    expect(decoded).toEqual({ op: 'channels', host: HOST, channels: ['design', 'shipping'], epoch: 3, sig })
    // A name that is not a legal channel name takes the whole message with
    // it: a registry quietly missing an entry is worse than one that
    // refuses to load, because nobody can see what is absent.
    expect(decodeControl(JSON.stringify({ op: 'channels', host: HOST, channels: ['Design'], epoch: 0, sig }))).toBeNull()
    expect(decodeControl(JSON.stringify({ op: 'channels', host: HOST, channels: ['has space'], epoch: 0, sig }))).toBeNull()
    // And the three the room already means something by.
    expect(decodeControl(JSON.stringify({ op: 'channels', host: HOST, channels: ['agents'], epoch: 0, sig }))).toBeNull()
    expect(decodeControl(JSON.stringify({ op: 'channels', host: HOST, channels: [], epoch: -1, sig }))).toBeNull()
    expect(decodeControl(JSON.stringify({ op: 'channels', host: HOST, channels: [], epoch: 0, sig: 'short' }))).toBeNull()
    // An empty list is a room that has had its channels removed, which is
    // a thing an authority may legitimately say.
    expect(decodeControl(JSON.stringify({ op: 'channels', host: HOST, channels: [], epoch: 0, sig }))).toEqual({ op: 'channels', host: HOST, channels: [], epoch: 0, sig })
    expect(decodeControl(JSON.stringify({ op: 'remove', participant: 'bob' }))).toBeNull()
    expect(decodeControl(JSON.stringify({ op: 'mute' }))).toBeNull()
  })

  it('reads a person typing into the channel as not a control message', () => {
    expect(decodeControl('hello agents')).toBeNull()
    expect(decodeControl('{"op":"invite"}')).toBeNull()
    expect(decodeControl('{"op":"launch","host":"x"}')).toBeNull()
    // A nudge is on or off, not "yes".
    expect(decodeControl('{"op":"nudge","on":"yes"}')).toBeNull()
    expect(decodeControl('{"op":"nudge"}')).toBeNull()
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

  describe('storage-grant', () => {
    const sk = new Uint8Array(32).fill(3)
    const grant = buildGrant({
      authoritySk: sk, roomId: 'a'.repeat(64), device: 'b'.repeat(64), server: 'grove.example.net', scopes: ['upload', 'get', 'delete'],
      bytes: 1073741824, grantId: 'c'.repeat(32), createdAt: 1_800_000_000, expiration: 1_802_592_000,
    })

    it('round trips an event exactly as sent, and the question', () => {
      const text = encodeControl({ op: 'storage-grant', event: grant })
      expect(text.length).toBeLessThan(800)
      expect(decodeControl(text)).toEqual({ op: 'storage-grant', event: grant })
      // Nothing mended: what the web app's snapshot custody compares is the JSON as sent.
      expect(JSON.stringify((decodeControl(text) as { event: unknown }).event)).toBe(JSON.stringify(grant))
      expect(decodeControl(encodeControl({ op: 'storage-grant?' }))).toEqual({ op: 'storage-grant?' })
    })

    it('carries revocations and resets, and the largest legal event fits one control message', () => {
      const parsed = (parseGroupEvent(grant) as { ok: true; parsed: ParsedGrant }).parsed
      expect(decodeControl(encodeControl({ op: 'storage-grant', event: buildRevocation(parsed, sk, parsed.createdAt + 1) }))).not.toBeNull()
      expect(decodeControl(encodeControl({ op: 'storage-grant', event: buildReset({ authoritySk: sk, roomId: 'a'.repeat(64), server: 'grove.example.net', createdAt: 1_800_000_000 }) }))).not.toBeNull()
      const server = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.')
      const biggest = buildGrant({
        authoritySk: sk, roomId: 'a'.repeat(64), device: 'b'.repeat(64), server, scopes: GRANT_SCOPES, bytes: (1n << 63n) - 1n,
        grantId: 'c'.repeat(32), createdAt: 1_800_000_000, expiration: 1_807_776_000, status: 'revoked',
      })
      const text = encodeControl({ op: 'storage-grant', event: biggest })
      expect(text.length).toBeLessThanOrEqual(1_100)
      expect(decodeControl(text)).toEqual({ op: 'storage-grant', event: biggest })
    })

    it('is null for anything not shaped like an event, or with anything extra', () => {
      const wrap = (event: unknown, extra: object = {}) => JSON.stringify({ op: 'storage-grant', event, ...extra })
      expect(decodeControl(wrap(grant, { extra: 1 }))).toBeNull()
      expect(decodeControl(wrap({ ...grant, extra: 1 }))).toBeNull()
      expect(decodeControl(wrap({ ...grant, kind: 1 }))).toBeNull()
      expect(decodeControl(wrap({ ...grant, tags: [['t', 1]] }))).toBeNull()
      expect(decodeControl(wrap({ ...grant, created_at: 1.5 }))).toBeNull()
      expect(decodeControl(wrap(null))).toBeNull()
      expect(decodeControl(wrap([]))).toBeNull()
      expect(decodeControl(JSON.stringify({ op: 'storage-grant' }))).toBeNull()
      expect(decodeControl(JSON.stringify({ op: 'storage-grant?', host: 'x' }))).toBeNull()
    })

    it('older readers drop what they do not know: an unknown op is still null', () => {
      expect(decodeControl(JSON.stringify({ op: 'storage-grant-v2', event: grant }))).toBeNull()
    })
  })
})
