import { describe, expect, it } from 'vitest'
import { base64 } from '@scure/base'
import { quietFixture, type QuietFixtureMode, QUIET_FIXTURE_NOW } from '../../test/ordinary-quiet-fixture.js'
import { validateOrdinaryQuietSnapshot as validate } from './ordinary-quiet-snapshot.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { memoryDeviceStore } from './device-store.js'
import { loadQuietState } from './quiet-store.js'

describe('strict retained quiet custody', () => {
  it.each<QuietFixtureMode>(['queued', 'counters', 'queue-only', 'legacy', 'epoch', 'named', 'expired'])('preserves real %s writer bytes and authenticated queue', async mode => {
    const f = await quietFixture(mode), before = [...f.records]
    const result = validate(f.records, false, f.checks)
    expect(result.rooms).toEqual([{ roomId: f.roomId, ...(mode !== 'legacy' ? { epoch: f.epoch } : {}),
      counterSources: mode === 'queue-only' ? 0 : 1, queued: mode === 'counters' ? 0 : 1 }])
    expect([...f.records]).toEqual(before); expect(Object.isFrozen(result.rooms[0])).toBe(true)
  })
  it('retains old hourly counters and queues which the permissive loader drops', async () => {
    const f = await quietFixture(), saved = JSON.parse(f.records.get(f.name)!)
    const store = memoryDeviceStore(); store.set(f.name, JSON.stringify(saved))
    expect(loadQuietState(store, f.roomId, QUIET_FIXTURE_NOW + 100_000).queued).toEqual([])
    saved.at -= 100_000; saved.used[f.participant].epoch -= 10; f.records.set(f.name, JSON.stringify(saved))
    const before = [...f.records]; expect(validate(f.records, false, f.checks).rooms[0]!.queued).toBe(1); expect([...f.records]).toEqual(before)
  })
  it('retains received peer-device counters from both device halves without sorting them', async () => {
    const f = await quietFixture('counters'), saved = JSON.parse(f.records.get(f.name)!)
    saved.used[f.participant].counters = [15, 7, 0, 8]; f.records.set(f.name, JSON.stringify(saved))
    const before = [...f.records]; validate(f.records, false, f.checks); expect([...f.records]).toEqual(before)
  })
  it('holds the impossible empty persisted row but preserves an explicit empty exported used state', async () => {
    const f = await quietFixture('counters')
    f.records.set(f.name, JSON.stringify({ queued: [], at: QUIET_FIXTURE_NOW }))
    const before = [...f.records]; expect(() => validate(f.records, false, f.checks)).toThrow(OrdinaryStateHold); expect([...f.records]).toEqual(before)
    f.records.set(f.name, JSON.stringify({ used: {}, queued: [], at: QUIET_FIXTURE_NOW }))
    expect(validate(f.records, false, f.checks).rooms[0]).toEqual({ roomId: f.roomId, counterSources: 0, queued: 0 })
  })
  it('accepts scoped custody only after migration with exact owner evidence', async () => {
    const f = await quietFixture(), scoped = new Map([['kithmoot.account.' + f.participant + '.' + f.name, f.records.get(f.name)!]])
    expect(() => validate(scoped, false, f.checks)).toThrow(OrdinaryStateHold)
    expect(validate(scoped, true, f.checks).rooms[0]!.account).toBe(f.participant)
    const wrong = new Map([['kithmoot.account.' + 'a'.repeat(64) + '.' + f.name, f.records.get(f.name)!]])
    expect(() => validate(wrong, true, f.checks)).toThrow(OrdinaryStateHold)
  })
  it('requires actual binding callbacks, refuses false, thrown and asynchronous results', async () => {
    const f = await quietFixture()
    for (const check of [undefined, () => false, () => { throw new Error('unavailable evidence') }, () => Promise.resolve(true)]) {
      expect(() => validate(f.records, false, { ...f.checks, acceptsCounters: check } as any)).toThrow(OrdinaryStateHold)
      expect(() => validate(f.records, false, { ...f.checks, acceptsQueued: check } as any)).toThrow(OrdinaryStateHold)
    }
  })
  it('does not let evidence callbacks mutate the queued event or scope', async () => {
    const f = await quietFixture(), before = [...f.records]
    validate(f.records, false, { ...f.checks, acceptsQueued: (event, scope) => {
      expect(Object.isFrozen(scope)).toBe(true); event.tags.length = 0; event.content = ''; return true
    } }); expect([...f.records]).toEqual(before)
  })
  it('finishes structural validation of all rooms before any evidence callbacks', async () => {
    const f = await quietFixture(), second = await quietFixture('queued', 6); f.records.set(second.name, '{')
    let visits = 0
    expect(() => validate(f.records, false, { ...f.checks, acceptsCounters: () => { visits++; return true }, acceptsQueued: () => { visits++; return true } })).toThrow(OrdinaryStateHold)
    expect(visits).toBe(0)
  })
  it('holds duplicate JSON fields and lossy numbers rather than accepting their parsed replacement', async () => {
    const f = await quietFixture(), raw = f.records.get(f.name)!
    for (const damaged of [raw.replace('{', '{"used":{},'), raw.replace('"at":1800000000', '"at":1e999'),
      raw.replace('"counters":[7]', '"counters":[-0]')]) {
      expect(damaged).not.toBe(raw); f.records.set(f.name, damaged)
      expect(() => validate(f.records, false, f.checks)).toThrow(OrdinaryStateHold)
    }
  })
  it('holds a valid signed ciphertext with a damaged MAC or a different room encryption key', async () => {
    const f = await quietFixture(), other = await quietFixture('queued', 6), saved = JSON.parse(f.records.get(f.name)!)
    const bytes = base64.decode(saved.queued[0].content); bytes[bytes.length - 1] ^= 1
    for (const content of [base64.encode(bytes), JSON.parse(other.records.get(other.name)!).queued[0].content]) {
      const damaged = { ...saved, queued: [f.sign({ ...saved.queued[0], content })] }; f.records.set(f.name, JSON.stringify(damaged))
      expect(() => validate(f.records, false, f.checks)).toThrow(OrdinaryStateHold)
    }
  })
  it.each(['bad-json', 'extra', 'at', 'epoch', 'missing-queue', 'used-null', 'used-array', 'bad-participant', 'used-extra', 'hour',
    'duplicate-counter', 'fraction-counter', 'negative-counter', 'high-counter', 'oversize-queue', 'bad-signature', 'wrong-id', 'event-extra',
    'duplicate-event', 'wrong-kind', 'event-time', 'unknown-tag', 'duplicate-d', 'bad-d', 'bad-expiry', 'duplicate-expiry',
    'plaintext', 'cipher-version', 'bucket', 'wrong-room', 'wrong-room-epoch', 'wrong-owner', 'tab', 'legacy-scoped', 'nested-scoped', 'namespace'] as const)
    ('holds %s without pruning, rewriting or sending', async fault => {
      const f = await quietFixture(), saved = JSON.parse(f.records.get(f.name)!), event = saved.queued[0], used = saved.used[f.participant]
      let checks = f.checks
      if (fault === 'extra') saved.extra = true
      if (fault === 'at') saved.at = -1
      if (fault === 'epoch') saved.epoch = 2 ** 32
      if (fault === 'missing-queue') delete saved.queued
      if (fault === 'used-null') saved.used = null
      if (fault === 'used-array') saved.used = []
      if (fault === 'bad-participant') saved.used = { invalid: used }
      if (fault === 'used-extra') used.extra = true
      if (fault === 'hour') used.epoch = 0.5
      if (fault === 'duplicate-counter') used.counters = [7, 7]
      if (fault === 'fraction-counter') used.counters = [0.5]
      if (fault === 'negative-counter') used.counters = [-1]
      if (fault === 'high-counter') used.counters = [16]
      if (fault === 'oversize-queue') saved.queued = Array(257).fill(event)
      if (fault === 'bad-signature') event.sig = '0'.repeat(128)
      if (fault === 'wrong-id') event.id = '0'.repeat(64)
      if (fault === 'event-extra') event.verified = true
      if (fault === 'duplicate-event') saved.queued.push(event)
      if (fault === 'wrong-kind') event.kind = 1
      if (fault === 'event-time') event.created_at = -1
      if (fault === 'unknown-tag') event.tags.push(['x', 'hidden'])
      if (fault === 'duplicate-d') event.tags.push(event.tags[0])
      if (fault === 'bad-d') event.tags = [['d', 'invalid']]
      if (fault === 'bad-expiry') event.tags.push(['expiration', '01'])
      if (fault === 'duplicate-expiry') event.tags.push(['expiration', '1800000100'], ['expiration', '1800000100'])
      if (fault === 'plaintext') event.content = 'private message'.repeat(12)
      if (fault === 'cipher-version') { const bytes = base64.decode(event.content); bytes[0] = 1; event.content = base64.encode(bytes) }
      if (fault === 'bucket') event.content = base64.encode(new Uint8Array(3000).fill(2))
      if (['wrong-kind', 'event-time', 'unknown-tag', 'duplicate-d', 'bad-d', 'bad-expiry', 'duplicate-expiry', 'plaintext', 'cipher-version', 'bucket'].includes(fault)) saved.queued[0] = f.sign(event)
      if (fault === 'wrong-room-epoch') saved.epoch = 1
      if (fault === 'wrong-owner') saved.used = { ['a'.repeat(64)]: used }
      f.records.set(f.name, fault === 'bad-json' ? '{' : JSON.stringify(saved))
      if (fault === 'wrong-room') { f.records.set(f.name.replace(f.roomId, 'b'.repeat(64)), f.records.get(f.name)!); f.records.delete(f.name) }
      if (fault === 'tab') checks = { ...checks, kind: 'tab' }
      if (fault === 'legacy-scoped') f.records.set('kithmoot.account.' + f.participant + '.' + f.name, f.records.get(f.name)!)
      if (fault === 'nested-scoped') { f.records.set('kithmoot.account.' + f.participant + '.kithmoot.account.' + f.participant + '.' + f.name, f.records.get(f.name)!); f.records.delete(f.name) }
      if (fault === 'namespace') { f.records.set(f.name.replace('.v1.', '.v2.'), f.records.get(f.name)!); f.records.delete(f.name) }
      const before = [...f.records], posts = f.published.length
      expect(() => validate(f.records, true, checks)).toThrow(OrdinaryStateHold); expect([...f.records]).toEqual(before); expect(f.published.length).toBe(posts)
    })
})
