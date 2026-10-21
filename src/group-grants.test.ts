import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { schnorr } from '@noble/curves/secp256k1.js'
import { deriveRoom } from './room.js'
import {
  GRANT_SCOPES, GROUP_GRANT_KIND, GrantReceiver, buildGrant, buildReset, buildRevocation, canonicalBytes, groupNodeFromBase,
  isHostName, newGrantId, nextCreatedAt, parseGroupEvent, type GroupEvent, type ParsedGrant,
} from './group-grants.js'

// wildbloom-node vectors/group-grants-v1.json at a4548f31: see the .source.md beside it.
interface Vectors {
  keys: Record<string, { secret: string; pubkey: string }>
  rooms: Record<string, { secretHex: string; roomId: string }>
  node: { servers: string[]; enrolments: { keeper: string; ceiling: number }[] }
  grantEvents: { name: string; now: number; event: unknown; expect: { status: number; reason: string; state?: string } }[]
  sequences: { name: string; steps: { now: number; post?: unknown; expect?: { status: number } }[] }[]
}
const vectors = JSON.parse(readFileSync(new URL('../test/fixtures/group-grants-v1.json', import.meta.url), 'utf8')) as Vectors
const ZERO_AUX = new Uint8Array(32)
const keepers = vectors.node.enrolments.map((e) => e.keeper)
const secretFor = (pubkey: string): Uint8Array | undefined => {
  const key = Object.values(vectors.keys).find((k) => k.pubkey === pubkey)
  return key ? hexToBytes(key.secret) : undefined
}

/** The cases a node answers on rules 1 to 7 alone; rule 8 onwards needs its state. */
const STRUCTURAL = new Set(['malformed', 'lifetime', 'signature', 'keeper', 'server', 'future', 'expired'])

describe('group grant vectors', () => {
  it('derives the vector rooms from their secrets: HKDF-SHA256, info kithmoot/v1/room-id', () => {
    for (const room of Object.values(vectors.rooms)) expect(deriveRoom(hexToBytes(room.secretHex)).roomId).toBe(room.roomId)
  })

  describe('every grantEvents case gets the structural verdict the vector states', () => {
    for (const c of vectors.grantEvents) {
      it(c.name, () => {
        const verdict = parseGroupEvent(c.event, { now: c.now, keepers, servers: vectors.node.servers })
        if (STRUCTURAL.has(c.expect.reason)) {
          expect(verdict.ok).toBe(false)
          if (!verdict.ok) { expect(verdict.reason).toBe(c.expect.reason); expect(verdict.status).toBe(c.expect.status) }
        } else {
          // Accepted, or refused on node state (rule 8): structurally fine.
          expect(verdict.ok).toBe(true)
        }
      })
    }
  })

  it('rebuilds every well-formed signed event of the file byte for byte from its inputs', () => {
    const events: unknown[] = [
      ...vectors.grantEvents.map((c) => c.event),
      ...vectors.sequences.flatMap((s) => s.steps.map((step) => step.post).filter((p) => p !== undefined)),
    ]
    let rebuilt = 0
    for (const raw of events) {
      const verdict = parseGroupEvent(raw)
      if (!verdict.ok) continue
      const secret = secretFor(verdict.parsed.signer)
      if (!secret) continue
      const p = verdict.parsed
      const event = p.type === 'reset'
        ? buildReset({ authoritySk: secret, roomId: p.roomId, server: p.server, createdAt: p.createdAt, expiration: p.expiration, auxRand: ZERO_AUX })
        : buildGrant({
          authoritySk: secret, roomId: p.roomId, device: p.device, server: p.server, scopes: p.scopes,
          ...(p.bytes !== undefined ? { bytes: p.bytes } : {}), grantId: p.grantId, createdAt: p.createdAt, expiration: p.expiration,
          status: p.status, auxRand: ZERO_AUX,
        })
      // Only the events whose tags are in the order a keeper writes them can be rebuilt; the rest are out of order on purpose.
      if (JSON.stringify((raw as GroupEvent).tags) !== JSON.stringify(event.tags)) continue
      expect(event).toEqual(raw)
      rebuilt++
    }
    expect(rebuilt).toBeGreaterThan(30)
  }, 30_000)

  it('good-grant is reproduced, with its id and signature, and the revocation and reset vectors too', () => {
    const byName = (n: string) => vectors.grantEvents.find((c) => c.name === n)!.event as GroupEvent
    const good = byName('good-grant')
    const parsed = parseGroupEvent(good)
    expect(parsed.ok).toBe(true)
    const grant = (parsed as { ok: true; parsed: ParsedGrant }).parsed
    const sk = secretFor(good.pubkey)!
    expect(buildGrant({
      authoritySk: sk, roomId: vectors.rooms.a!.roomId, device: grant.device, server: 'grove.example.net', scopes: ['upload', 'get', 'delete'],
      bytes: 1073741824, grantId: grant.grantId, createdAt: 1800000000, expiration: 1802592000, auxRand: ZERO_AUX,
    })).toEqual(good)
    // The revocation vector, from the grant it revokes.
    const revoked = byName('good-revocation-first')
    expect(buildRevocation(grant, sk, grant.createdAt + 1, ZERO_AUX).tags)
      .toEqual(revoked.tags)
    expect(buildReset({ authoritySk: sk, roomId: vectors.rooms.a!.roomId, server: 'grove.example.net', createdAt: 1800000000, auxRand: ZERO_AUX }))
      .toEqual(byName('good-reset'))
  })
})

describe('building', () => {
  const sk = hexToBytes(vectors.keys.authorityA!.secret)
  const room = vectors.rooms.a!.roomId
  const device = vectors.keys.alicePhone!.pubkey
  const spec = { authoritySk: sk, roomId: room, device, server: 'grove.example.net', scopes: ['upload', 'get', 'delete'] as const, bytes: 5, grantId: 'ab'.repeat(16), createdAt: 1_800_000_000, expiration: 1_802_592_000 }

  it('writes the tags in the order of section 4.2 and signs with fresh randomness by default', () => {
    const a = buildGrant(spec)
    const b = buildGrant(spec)
    expect(a.tags.map((t) => t[0])).toEqual(['t', 'grant', 'd', 'device', 'server', 'scope', 'scope', 'scope', 'bytes', 'status', 'expiration'])
    expect(a.id).toBe(b.id)
    expect(a.sig).not.toBe(b.sig)
    expect(parseGroupEvent(a, { now: 1_800_000_000, keepers: [a.pubkey], servers: ['grove.example.net'] }).ok).toBe(true)
  })

  it('refuses what a node would refuse', () => {
    expect(() => buildGrant({ ...spec, server: 'Grove.example.net:443' })).toThrow()
    expect(() => buildGrant({ ...spec, bytes: undefined })).toThrow(/bytes/)
    expect(() => buildGrant({ ...spec, scopes: ['get'], bytes: 5 })).toThrow(/bytes/)
    expect(() => buildGrant({ ...spec, expiration: spec.createdAt + 7_776_001 })).toThrow(/lifetime/)
    expect(() => buildGrant({ ...spec, device: bytesToHex(schnorr.getPublicKey(sk)) })).toThrow()
    expect(() => buildGrant({ ...spec, grantId: 'AB'.repeat(16) })).toThrow()
  })

  it('a revocation carries the grant tags, a later created_at and the latest expiration', () => {
    const grant = buildGrant(spec)
    const parsed = (parseGroupEvent(grant) as { ok: true; parsed: ParsedGrant }).parsed
    const revoked = buildRevocation(parsed, sk, spec.createdAt + 5)
    expect(revoked.tags.map((t) => t.join('='))).toEqual(grant.tags.map((t) => (t[0] === 'status' ? 'status=revoked' : t.join('='))))
    expect(() => buildRevocation(parsed, sk, spec.createdAt)).toThrow()
  })

  it('a reset is t, d, server and expiration, ninety days on', () => {
    const reset = buildReset({ authoritySk: sk, roomId: room, server: 'grove.example.net', createdAt: 1_800_000_000 })
    expect(reset.tags).toEqual([['t', 'reset'], ['d', room], ['server', 'grove.example.net'], ['expiration', String(1_800_000_000 + 7_776_000)]])
  })

  it('draws grant ids of 16 bytes', () => {
    expect(newGrantId((n) => new Uint8Array(n).fill(7))).toBe('07'.repeat(16))
  })

  it('never stamps two events for one id in one second, nor a grant at or before a reset floor', () => {
    expect(nextCreatedAt(100)).toBe(100)
    expect(nextCreatedAt(100, 100)).toBe(101)
    expect(nextCreatedAt(100, 90, 100, undefined)).toBe(101)
    expect(nextCreatedAt(100, 150)).toBe(151)
  })

  it('the largest legal event is still readable', () => {
    const server = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.')
    const event = buildGrant({ ...spec, server, scopes: GRANT_SCOPES, bytes: (1n << 63n) - 1n })
    expect(event.tags.length).toBe(15)
    expect(parseGroupEvent(event).ok).toBe(true)
    expect(event.kind).toBe(GROUP_GRANT_KIND)
  })
})

describe('parsing refuses', () => {
  const sk = hexToBytes(vectors.keys.authorityA!.secret)
  const base = { authoritySk: sk, roomId: vectors.rooms.a!.roomId, device: vectors.keys.alicePhone!.pubkey, server: 'grove.example.net', scopes: ['get'] as const, grantId: 'cd'.repeat(16), createdAt: 1_800_000_000, expiration: 1_800_100_000 }

  it('a flipped bit in any signed field', () => {
    const event = buildGrant(base)
    const tampered: GroupEvent[] = [
      { ...event, created_at: event.created_at + 1 },
      { ...event, tags: event.tags.map((t) => (t[0] === 'scope' ? ['scope', 'delete'] : t)) },
      { ...event, sig: event.sig.slice(0, -1) + (event.sig.endsWith('0') ? '1' : '0') },
      { ...event, pubkey: vectors.keys.authorityB!.pubkey },
    ]
    for (const t of tampered) expect(parseGroupEvent(t).ok === true).toBe(false)
  })

  it('non-events, extra fields and oversized bodies', () => {
    const event = buildGrant(base)
    expect(parseGroupEvent(null)).toMatchObject({ status: 400 })
    expect(parseGroupEvent([])).toMatchObject({ status: 400 })
    expect(parseGroupEvent({ ...event, extra: 1 })).toMatchObject({ reason: 'malformed' })
    expect(parseGroupEvent({ ...event, tags: [...event.tags, ['x', 'y'.repeat(20_000)]] })).toMatchObject({ status: 413 })
  })

  it('the clock rules only when a clock is given', () => {
    const event = buildGrant(base)
    expect(parseGroupEvent(event).ok).toBe(true)
    expect(parseGroupEvent(event, { now: base.createdAt - 31 })).toMatchObject({ reason: 'future' })
    expect(parseGroupEvent(event, { now: base.createdAt - 30 }).ok).toBe(true)
    expect(parseGroupEvent(event, { now: base.expiration })).toMatchObject({ reason: 'expired' })
  })
})

describe('node base URLs', () => {
  it('derives the lower-case host name and keeps the port and path in the base', () => {
    expect(groupNodeFromBase('https://Grove.Example.NET/')).toEqual({ base: 'https://grove.example.net', server: 'grove.example.net' })
    expect(groupNodeFromBase('http://127.0.0.1:8080/store/')).toEqual({ base: 'http://127.0.0.1:8080/store', server: '127.0.0.1' })
    expect(groupNodeFromBase('http://localhost:3742')).toEqual({ base: 'http://localhost:3742', server: 'localhost' })
  })

  it('refuses onion, other schemes, credentials, queries and unusable host names', () => {
    expect(() => groupNodeFromBase('http://abcdefg.onion')).toThrow(/onion/)
    expect(() => groupNodeFromBase('ftp://x.example')).toThrow(/http and https/)
    expect(() => groupNodeFromBase('https://user:pw@x.example')).toThrow(/user name/)
    expect(() => groupNodeFromBase('https://x.example/?a=1')).toThrow(/query/)
    expect(() => groupNodeFromBase('http://[::1]:80')).toThrow(/host name/)
    expect(() => groupNodeFromBase('http://localhost./')).toThrow(/host name/)
    expect(() => groupNodeFromBase('not a url')).toThrow(/not a URL/)
    // Plain http only for a node on this machine.
    expect(() => groupNodeFromBase('http://files.example.net')).toThrow(/plain http/)
    expect(() => groupNodeFromBase('http://192.168.1.20:3742')).toThrow(/plain http/)
    expect(groupNodeFromBase('http://127.5.4.3:1').server).toBe('127.5.4.3')
    expect(groupNodeFromBase('https://192.168.1.20:3742').server).toBe('192.168.1.20')
    expect(isHostName('a_b.example')).toBe(false)
  })

  it('bytes are canonical decimal from 1 to 2^63 - 1', () => {
    expect(canonicalBytes(1)).toBe('1')
    expect(canonicalBytes('9223372036854775807')).toBe('9223372036854775807')
    for (const bad of [0, -1, 1.5, '01', '9223372036854775808', 'x', Number.MAX_SAFE_INTEGER * 2]) expect(() => canonicalBytes(bad as never)).toThrow()
  })
})

describe('the receiver rule', () => {
  const authoritySk = hexToBytes(vectors.keys.authorityA!.secret)
  const authority = vectors.keys.authorityA!.pubkey
  const roomId = vectors.rooms.a!.roomId
  const mine = vectors.keys.alicePhone!.pubkey
  const theirs = vectors.keys.bobLaptop!.pubkey
  const mk = (device: string, id: string, createdAt: number, status: 'active' | 'revoked' = 'active', server = 'grove.example.net', room = roomId, sk = authoritySk) =>
    buildGrant({ authoritySk: sk, roomId: room, device, server, scopes: ['get'], grantId: id, createdAt, expiration: createdAt + 1000, status })
  const receiver = () => new GrantReceiver({ authority, roomId, device: mine })

  it('keeps its own grant and carries every revocation and reset', () => {
    const r = receiver()
    expect(r.offer(mk(mine, '11'.repeat(16), 1000), 1000)).toBe(true)
    expect(r.offer(mk(theirs, '22'.repeat(16), 1000), 1000)).toBe(false)
    expect(r.offer(mk(theirs, '22'.repeat(16), 1001, 'revoked'), 1001)).toBe(true)
    const reset = buildReset({ authoritySk, roomId, server: 'heath.example.net', createdAt: 1002 })
    expect(r.offer(reset, 1002)).toBe(true)
    expect(r.grantsFor('grove.example.net', 1003).map((g) => g.grantId)).toEqual(['11'.repeat(16)])
    expect(r.carry('grove.example.net', 1003).length).toBe(1)
    expect(r.carry('heath.example.net', 1003).length).toBe(1)
  })

  it('refuses another signer, another room, a forgery and what is not an event', () => {
    const r = receiver()
    expect(r.offer(mk(mine, '11'.repeat(16), 1000, 'active', 'grove.example.net', roomId, hexToBytes(vectors.keys.authorityB!.secret)), 1000)).toBe(false)
    expect(r.offer(mk(mine, '11'.repeat(16), 1000, 'active', 'grove.example.net', vectors.rooms.b!.roomId), 1000)).toBe(false)
    const forged = { ...mk(mine, '11'.repeat(16), 1000), created_at: 1001 }
    expect(r.offer(forged, 1001)).toBe(false)
    expect(r.offer('grant', 1000)).toBe(false)
    expect(r.grantsFor('grove.example.net', 1000)).toEqual([])
  })

  it('a newer event for an id replaces an older one, and an older one never does', () => {
    const r = receiver()
    r.offer(mk(mine, '11'.repeat(16), 1000), 1000)
    expect(r.offer(mk(mine, '11'.repeat(16), 2000), 2000)).toBe(true)
    expect(r.offer(mk(mine, '11'.repeat(16), 1500), 2000)).toBe(false)
    expect(r.grantsFor('grove.example.net', 2000)[0]!.createdAt).toBe(2000)
  })

  it('a revocation or a reset ends the grant it covers; an expired grant is not offered', () => {
    const r = receiver()
    r.offer(mk(mine, '11'.repeat(16), 1000), 1000)
    r.offer(mk(mine, '33'.repeat(16), 1000), 1000)
    r.offer(mk(mine, '11'.repeat(16), 1001, 'revoked'), 1001)
    expect(r.grantsFor('grove.example.net', 1002).map((g) => g.grantId)).toEqual(['33'.repeat(16)])
    r.offer(buildReset({ authoritySk, roomId, server: 'grove.example.net', createdAt: 1003 }), 1003)
    expect(r.grantsFor('grove.example.net', 1004)).toEqual([])
    expect(receiver().grantsFor('grove.example.net', 5000)).toEqual([])
  })

  it('stops carrying an event once a node has acknowledged it, or once it could no longer matter', () => {
    const r = receiver()
    const revocation = mk(theirs, '22'.repeat(16), 1001, 'revoked')
    r.offer(revocation, 1001)
    expect(r.carry('grove.example.net', 1002).length).toBe(1)
    expect(r.carry('grove.example.net', 1001 + 2000).length).toBe(0)
    r.acknowledge('grove.example.net', revocation.id)
    expect(r.carry('grove.example.net', 1002).length).toBe(0)
  })

  it('keeps a revocation however far ahead of this clock it was signed: the node judges the clock, not the reader', () => {
    const r = receiver()
    expect(r.offer(mk(theirs, '22'.repeat(16), 100_000, 'revoked'), 1_000)).toBe(true)
    expect(r.carry('grove.example.net', 100_000).length).toBe(1)
  })

  it('keeps a revocation read well after it was signed, while its grant could still land', () => {
    const r = receiver()
    const revocation = mk(theirs, '22'.repeat(16), 1001, 'revoked')
    expect(r.offer(revocation, 1001 + 500)).toBe(true)
  })
})

describe('node base URLs and the room\'s list', () => {
  const accepted: [string, string][] = [
    ['https://grove.example.net', 'grove.example.net'],
    ['https://grove.example.net:8443', 'grove.example.net'],
    ['https://example.net/wb/node-1', 'example.net'],
    ['http://localhost:3000', 'localhost'],
    ['http://127.0.0.1:8080', '127.0.0.1'],
    ['https://192.0.2.10', '192.0.2.10'],
  ]

  it('delegates to fold-kit: the same base and server a client derives from the room\'s list', async () => {
    const { storageNodeFromBase, storageNodeServer, isStorageNodeBase } = await import('@forgesworn/fold-kit')
    for (const [entry, server] of accepted) {
      expect(groupNodeFromBase(entry)).toEqual({ base: entry, server })
      expect(groupNodeFromBase(entry)).toEqual(storageNodeFromBase(entry))
      expect(isStorageNodeBase(entry)).toBe(true)
      expect(storageNodeServer(entry)).toBe(server)
    }
    // An operator's text is made canonical, and what comes out is what a client reads back.
    for (const text of ['HTTPS://Grove.Example.NET:443/', 'https://grove.example.net//', ' https://grove.example.net ']) {
      const node = groupNodeFromBase(text)
      expect(node.base).toBe('https://grove.example.net')
      expect(storageNodeServer(node.base)).toBe(node.server)
    }
  })

  it('keeps the onion refusal first, and newly refuses an odd path and a very long URL', () => {
    expect(() => groupNodeFromBase('http://' + 'a2'.repeat(28) + '.onion')).toThrow(/onion nodes need Tor/)
    expect(() => groupNodeFromBase('https://x.example/a%20b')).toThrow(/path may hold only/)
    expect(() => groupNodeFromBase('https://x.example/' + 'a'.repeat(260))).toThrow(/longer than 256/)
  })
})

describe('the receiver, persisted and posted', () => {
  const authoritySk = hexToBytes(vectors.keys.authorityA!.secret)
  const authority = vectors.keys.authorityA!.pubkey
  const roomId = vectors.rooms.a!.roomId
  const mine = vectors.keys.alicePhone!.pubkey
  const theirs = vectors.keys.bobLaptop!.pubkey
  const mk = (device: string, id: string, createdAt: number, status: 'active' | 'revoked' = 'active', server = 'grove.example.net') =>
    buildGrant({ authoritySk, roomId, device, server, scopes: ['get'], grantId: id, createdAt, expiration: createdAt + 1000, status })
  const opts = { authority, roomId, device: mine }

  it('snapshot and restore round-trip what is kept and what a node has acknowledged', () => {
    const r = new GrantReceiver(opts)
    const own = mk(mine, '11'.repeat(16), 1000)
    const revocation = mk(theirs, '22'.repeat(16), 1001, 'revoked')
    const reset = buildReset({ authoritySk, roomId, server: 'heath.example.net', createdAt: 1002 })
    for (const e of [own, revocation, reset]) r.offer(e)
    r.acknowledge('grove.example.net', revocation.id)
    r.acknowledge('grove.example.net', 'ff'.repeat(32)) // an event no longer held: not kept
    const snap = JSON.parse(JSON.stringify(r.snapshot())) as ReturnType<GrantReceiver['snapshot']>
    expect(snap.events.map((e) => e.id).sort()).toEqual([own.id, revocation.id, reset.id].sort())
    expect(snap.acknowledged).toEqual([`grove.example.net/${revocation.id}`])
    const back = GrantReceiver.restore(opts, snap)
    expect(back.grantsFor('grove.example.net', 1003).map((g) => g.grantId)).toEqual(['11'.repeat(16)])
    expect(back.carry('grove.example.net', 1003)).toEqual([])
    expect(back.carry('heath.example.net', 1003).map((p) => p.event.id)).toEqual([reset.id])
    expect(back.snapshot()).toEqual(snap)
  })

  it('restore verifies again: a tampered event, another room\'s event and a malformed key are dropped', () => {
    const own = mk(mine, '11'.repeat(16), 1000)
    const forged = { ...mk(mine, '33'.repeat(16), 1000), created_at: 1001 }
    const snap = {
      events: [own, forged, 'not an event' as never],
      acknowledged: [`grove.example.net/${own.id}`, 'not-a-key', `Bad Host/${own.id}`, `grove.example.net/${forged.id}`, 7 as never],
    }
    const back = GrantReceiver.restore(opts, snap)
    expect(back.snapshot().events.map((e) => e.id)).toEqual([own.id])
    expect(back.snapshot().acknowledged).toEqual([`grove.example.net/${own.id}`])
    expect(GrantReceiver.restore(opts, undefined as never).snapshot()).toEqual({ events: [], acknowledged: [] })
  })

  it('ownToPost is the newest active own grant for the server, until a node acknowledges that event', () => {
    const r = new GrantReceiver(opts)
    expect(r.ownToPost('grove.example.net', 1000)).toBeUndefined()
    const first = mk(mine, '11'.repeat(16), 1000)
    r.offer(first)
    expect(r.ownToPost('grove.example.net', 1001)).toEqual(first)
    expect(r.ownToPost('heath.example.net', 1001)).toBeUndefined()
    r.acknowledge('grove.example.net', first.id)
    expect(r.ownToPost('grove.example.net', 1001)).toBeUndefined()
    // A renewal is a new event id, so it is posted again.
    const renewal = mk(mine, '11'.repeat(16), 1500)
    r.offer(renewal)
    expect(r.ownToPost('grove.example.net', 1501)).toEqual(renewal)
    // Expired: nothing to post. Revoked: nothing either. carry() is unchanged and never offers a grant.
    expect(r.ownToPost('grove.example.net', 5000)).toBeUndefined()
    r.offer(mk(mine, '11'.repeat(16), 1600, 'revoked'))
    expect(r.ownToPost('grove.example.net', 1601)).toBeUndefined()
    expect(r.carry('grove.example.net', 1601).every((p) => p.type === 'grant' && p.status === 'revoked')).toBe(true)
  })

  it('lockedOut is true only where this device had grants and all have ended by revocation or reset', () => {
    const r = new GrantReceiver(opts)
    expect(r.lockedOut('grove.example.net', 1000)).toBe(false)
    r.offer(mk(mine, '11'.repeat(16), 1000))
    expect(r.lockedOut('grove.example.net', 1001)).toBe(false)
    r.offer(mk(mine, '11'.repeat(16), 1002, 'revoked'))
    expect(r.lockedOut('grove.example.net', 1003)).toBe(true)
    expect(r.lockedOut('heath.example.net', 1003)).toBe(false)
    r.offer(mk(mine, '44'.repeat(16), 1000, 'active', 'heath.example.net'))
    r.offer(buildReset({ authoritySk, roomId, server: 'heath.example.net', createdAt: 1004 }))
    expect(r.lockedOut('heath.example.net', 1005)).toBe(true)
    // A grant that merely ran out is not being locked out.
    const quiet = new GrantReceiver(opts)
    quiet.offer(mk(mine, '55'.repeat(16), 1000))
    expect(quiet.lockedOut('grove.example.net', 5000)).toBe(false)
  })
})
