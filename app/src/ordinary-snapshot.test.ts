import { afterEach, describe, expect, it, vi } from 'vitest'
import { snapshotFixture, type SnapshotFixtureMode } from '../../test/ordinary-snapshot-fixture.js'
import { captureOrdinarySnapshotContext as capture, releaseOrdinarySnapshotContext as release, validateOrdinarySnapshot as validate } from './ordinary-snapshot.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { getPublicKey } from 'nostr-tools/pure'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
const location = () => vi.stubGlobal('location', { href: 'https://ordinary-snapshot.kithmoot.test/j/' })
const flags = { browser: false, tab: false }
describe('one captured ordinary image', () => {
  for (const mode of ['ordinary', 'named', 'past-zero', 'past-two', 'current', 'v1-ahead', 'quiet', 'quiet-epoch', 'quiet-overlap', 'quiet-named', 'quiet-control', 'quiet-logo', 'quiet-assignment', 'quiet-assignment-epoch', 'expired', 'reply', 'edit', 'reaction', 'retraction'] as SnapshotFixtureMode[]) {
    it(`binds actual ${mode} writer bytes without replay or current authority`, async () => {
      const f = await snapshotFixture(mode); location()
      try {
        const before = JSON.stringify([[...f.browser], [...f.tab]]), token = capture(f.browser, f.tab)
        const result = validate(f.browser, f.tab, flags, token)
        expect(result).toMatchObject({ rooms: 1, identities: 1, pendingQueues: mode === 'quiet-control' || mode === 'quiet-logo' || mode.startsWith('quiet-assignment') ? 0 : 1,
          pendingRecords: mode === 'quiet-control' || mode === 'quiet-logo' || mode.startsWith('quiet-assignment') ? 0 : 1,
          quietRooms: mode.startsWith('quiet') ? 1 : 0, epochs: ['past-zero', 'past-two', 'current', 'v1-ahead', 'quiet-epoch', 'quiet-assignment-epoch'].includes(mode) ? 1 : 0 })
        expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.families)).toBe(true)
        expect(JSON.stringify([[...f.browser], [...f.tab]])).toBe(before)
        expect(f.published).toHaveLength(0)
        expect(() => validate(f.browser, f.tab, flags, token)).toThrow(OrdinaryStateHold)
      } finally { f.release() }
    })
  }
  it('derives the original startup root before actual location scrubbing', async () => {
    const f = await snapshotFixture(); vi.stubGlobal('location', { href: f.url }); f.browser.delete(f.roomName)
    try {
      const token = capture(f.browser, f.tab); location()
      expect(validate(f.browser, f.tab, flags, token).pendingRecords).toBe(1)
      expect(() => validate(f.browser, f.tab, flags, capture(f.browser, f.tab))).toThrow(OrdinaryStateHold)
    } finally { f.release() }
  })
  it('does not use clock, entropy, storage, networking or signer effects', async () => {
    const f = await snapshotFixture('current'); location()
    try {
      const now = vi.spyOn(Date, 'now').mockImplementation(() => { throw Error('clock') })
      const entropy = vi.spyOn(crypto, 'getRandomValues').mockImplementation(() => { throw Error('entropy') })
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw Error('network') })
      expect(validate(f.browser, f.tab, flags, capture(f.browser, f.tab)).pendingRecords).toBe(1)
      expect(now).not.toHaveBeenCalled(); expect(entropy).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
    } finally { f.release() }
  })
  for (const fault of ['missing-root', 'missing-device', 'account', 'channel', 'id', 'text', 'files', 'artwork', 'editable', 'durability', 'tag-extra', 'tag-duplicate', 'expiry',
    'name-repair', 'time-repair', 'mention-repair', 'artwork-repair', 'unknown-plaintext', 'lane', 'duplicate-json', 'credential-extra', 'credential-duplicate'] as const) {
    it(`holds ${fault} with complete signed outer integrity and preserves bytes`, async () => {
      const f = await snapshotFixture(); location()
      try {
        const rows = JSON.parse(f.browser.get(f.pendingName)!), row = rows[0]
        if (fault === 'missing-root') f.browser.delete(f.roomName)
        else if (fault === 'missing-device') { for (const name of [...f.browser.keys()]) if (name.startsWith('kithmoot.device.') || name.startsWith('kithmoot.own-credential.')) f.browser.delete(name) }
        else if (fault === 'account') { f.browser.delete(f.pendingName); f.browser.set(f.pendingName.replace(f.participant, 'a'.repeat(64)), JSON.stringify(rows)) }
        else if (fault === 'durability') { f.browser.delete(f.pendingName); f.tab.set(f.pendingName, JSON.stringify(rows)) }
        else {
          if (['channel', 'id', 'text'].includes(fault)) row[fault] = fault === 'channel' ? 'tasks' : 'substituted'
          if (fault === 'files') row.files = ['Invented file']
          if (fault === 'artwork') delete row.artwork
          if (fault === 'editable') row.event = f.resign(row.event, value => { value.reply = { messageId: 'a'.repeat(32), participant: f.participant } })
          if (fault.startsWith('tag-') || fault === 'expiry') {
            row.event.tags.push(fault === 'tag-duplicate' ? ['d', f.roomId] : fault === 'expiry' ? ['expiration', '1800000900'] : ['p', f.participant])
            row.event = f.sign(row.event)
          }
          if (fault === 'name-repair') row.event = f.resign(row.event, value => { value.name = '\u0000Hidden' })
          if (fault === 'time-repair') row.event = f.resign(row.event, value => { value.sentAtMs = 1 })
          if (fault === 'mention-repair') row.event = f.resign(row.event, value => { value.mentions = ['invalid'] })
          if (fault === 'artwork-repair') row.event = f.resign(row.event, value => { (value.artwork as object[])[0] = { ...(value.artwork as object[])[0], extra: true } })
          if (fault === 'unknown-plaintext' || fault === 'lane') row.event = f.resign(row.event, value => { value[fault === 'lane' ? 'lane' : 'extra'] = 'hidden' })
          if (fault === 'duplicate-json') row.event = f.resign(row.event, () => {}, text => '{"id":"shadow",' + text.slice(1))
          if (fault === 'credential-extra') row.event = f.resign(row.event, value => { (value.credential as Record<string, unknown>).extra = true })
          if (fault === 'credential-duplicate') row.event = f.resign(row.event, value => { const cred = value.credential as { tags: string[][] }; cred.tags.push(cred.tags.find(t => t[0] === 'device')!) })
          f.browser.set(f.pendingName, JSON.stringify(rows))
        }
        const before = JSON.stringify([[...f.browser], [...f.tab]]), token = capture(f.browser, f.tab)
        expect(() => validate(f.browser, f.tab, flags, token)).toThrow(OrdinaryStateHold)
        expect(() => validate(f.browser, f.tab, flags, token)).toThrow(OrdinaryStateHold)
        expect(JSON.stringify([[...f.browser], [...f.tab]])).toBe(before)
      } finally { f.release() }
    })
  }
  it.each(['changed', 'added', 'deleted', 'signal'])('rejects %s reserved evidence after capture and burns the token', async fault => {
    const f = await snapshotFixture(); location()
    try {
      if (fault === 'signal') f.browser.set('kithmoot-mls-vault-v1.revision', '11111111-1111-4111-8111-111111111111')
      const original = new Map(f.browser), token = capture(f.browser, f.tab)
      if (fault === 'changed') f.browser.set(f.pendingName, f.browser.get(f.pendingName)! + ' ')
      if (fault === 'added') f.browser.set('kithmoot.textSize', 'large')
      if (fault === 'deleted') f.browser.delete(f.roomName)
      if (fault === 'signal') f.browser.set('kithmoot-mls-vault-v1.revision', '22222222-2222-4222-8222-222222222222')
      expect(() => validate(f.browser, f.tab, flags, token)).toThrow(OrdinaryStateHold)
      expect(() => validate(original, f.tab, flags, token)).toThrow(OrdinaryStateHold)
    } finally { f.release() }
  })
  it('ignores unrelated origin names but rejects copied and released capabilities', async () => {
    const f = await snapshotFixture(); location()
    try {
      const token = capture(f.browser, f.tab); f.browser.set('unrelated', 'changed')
      expect(() => validate(f.browser, f.tab, flags, { ...token } as never)).toThrow(OrdinaryStateHold)
      expect(validate(f.browser, f.tab, flags, token).pendingRecords).toBe(1)
      const abandoned = capture(f.browser, f.tab); release(abandoned)
      expect(() => validate(f.browser, f.tab, flags, abandoned)).toThrow(OrdinaryStateHold)
    } finally { f.release() }
  })
  it.each(['removed', 'changed', 'epoch', 'durable'])('holds quiet reload overlap with %s independent browser custody', async fault => {
    const f = await snapshotFixture('quiet-overlap'); location()
    try {
      if (fault === 'removed') f.browser.delete(f.quietName)
      if (fault === 'changed' || fault === 'epoch') { const quiet = JSON.parse(f.browser.get(f.quietName)!); if (fault === 'changed') quiet.queued[0] = f.resign(quiet.queued[0], value => { value.text = 'Changed' }); else quiet.epoch = 1; f.browser.set(f.quietName, JSON.stringify(quiet)) }
      if (fault === 'durable') { f.browser.set(f.pendingName, f.tab.get(f.pendingName)!); f.tab.delete(f.pendingName) }
      const token = capture(f.browser, f.tab)
      expect(() => validate(f.browser, f.tab, flags, token)).toThrow(OrdinaryStateHold)
    } finally { f.release() }
  })
  it('requires the retained room end even when a freshly signed event omits expiration', async () => {
    const f = await snapshotFixture('expired'); location()
    try {
      const rows = JSON.parse(f.browser.get(f.pendingName)!)
      rows[0].event.tags = rows[0].event.tags.filter((t: string[]) => t[0] !== 'expiration'); rows[0].event = f.sign(rows[0].event)
      f.browser.set(f.pendingName, JSON.stringify(rows))
      expect(() => validate(f.browser, f.tab, flags, capture(f.browser, f.tab))).toThrow(OrdinaryStateHold)
    } finally { f.release() }
  })
  it('refuses orphaned legacy epoch custody with a valid room root', async () => {
    const f = await snapshotFixture('current'); location()
    try {
      f.browser.delete(f.pendingName)
      for (const name of [...f.browser.keys()]) if (name.startsWith('kithmoot.device.') || name.startsWith('kithmoot.own-credential.')) f.browser.delete(name)
      expect(() => validate(f.browser, f.tab, flags, capture(f.browser, f.tab))).toThrow(OrdinaryStateHold)
    } finally { f.release() }
  })
  it('does not assign legacy quiet counter-only custody from membership alone', async () => {
    const f = await snapshotFixture('quiet'); location()
    try {
      f.tab.delete(f.pendingName)
      const quiet = JSON.parse(f.browser.get(f.quietName)!); quiet.queued = []; f.browser.set(f.quietName, JSON.stringify(quiet))
      for (const name of [...f.browser.keys()]) if (name.startsWith('kithmoot.device.') || name.startsWith('kithmoot.own-credential.')) f.browser.delete(name)
      expect(() => validate(f.browser, f.tab, flags, capture(f.browser, f.tab))).toThrow(OrdinaryStateHold)
    } finally { f.release() }
  })
  it.each(['not-hex', 'a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32)])('holds a signed PWA ID outside the actual writer grammar: %s', async id => {
    const f = await snapshotFixture(); location()
    try {
      const rows = JSON.parse(f.browser.get(f.pendingName)!); rows[0].id = id
      rows[0].event = f.resign(rows[0].event, value => { value.id = id }); f.browser.set(f.pendingName, JSON.stringify(rows))
      expect(() => validate(f.browser, f.tab, flags, capture(f.browser, f.tab))).toThrow(OrdinaryStateHold)
    } finally { f.release() }
  })
  it.each([false, true])('binds quiet used-counter ownership beyond valid membership, scoped=%s', async scoped => {
    const f = await snapshotFixture('quiet'); location()
    const otherKey = new Uint8Array(32); otherKey[31] = 5
    try {
      const other = getPublicKey(otherKey); f.includeMember(other)
      const quiet = JSON.parse(f.browser.get(f.quietName)!)
      quiet.queued = []; quiet.used = { [f.participant]: { epoch: 500000, counters: [1] } }; f.tab.delete(f.pendingName)
      f.browser.set(f.quietName, JSON.stringify(quiet))
      const prefix = `kithmoot.account.${f.participant}.`
      if (scoped) {
        for (const [name, raw] of [...f.browser]) if (name.startsWith('kithmoot.device.') || name.startsWith('kithmoot.own-credential.') || name === f.quietName) { f.browser.delete(name); f.browser.set(prefix + name, raw) }
        f.browser.set(prefix + 'kithmoot.device-owner.' + f.roomId, JSON.stringify({ account: f.participant, roomId: f.roomId }))
      }
      const migrated = { browser: scoped, tab: false }, quietName = (scoped ? prefix : '') + f.quietName
      expect(validate(f.browser, f.tab, migrated, capture(f.browser, f.tab)).quietRooms).toBe(1)
      quiet.used = { [other]: { epoch: 500000, counters: [1] } }; f.browser.set(quietName, JSON.stringify(quiet))
      expect(() => validate(f.browser, f.tab, migrated, capture(f.browser, f.tab))).toThrow(OrdinaryStateHold)
    } finally { f.release(); otherKey.fill(0) }
  })
  for (const mode of ['quiet-unknown', 'quiet-assignment-text'] as const) it(`holds independent ${mode} without inventing provenance`, async () => {
    const f = await snapshotFixture(mode); location()
    try { expect(() => validate(f.browser, f.tab, flags, capture(f.browser, f.tab))).toThrow(OrdinaryStateHold) } finally { f.release() }
  })
  for (const fault of ['assignment-main', 'assignment-control', 'assignment-malformed', 'assignment-label', 'assignment-extra', 'logo-main', 'logo-missing', 'control-text', 'control-repair', 'device', 'account', 'room', 'epoch'] as const) it(`holds independent protocol quiet ${fault}`, async () => {
    const f = await snapshotFixture(fault.startsWith('logo-') ? 'quiet-logo' : fault.startsWith('control-') ? 'quiet-control' : 'quiet-assignment'); location()
    try {
      const quiet = JSON.parse(f.browser.get(f.quietName)!)
      if (fault === 'assignment-main' || fault === 'logo-main') quiet.queued[0] = f.rechannel(quiet.queued[0], undefined)
      if (fault === 'assignment-control') quiet.queued[0] = f.rechannel(quiet.queued[0], 'control')
      if (fault === 'assignment-malformed') quiet.queued[0] = f.resign(quiet.queued[0], value => { value.assignment = {} })
      if (fault === 'assignment-label') quiet.queued[0] = f.resign(quiet.queued[0], value => { value.text = 'Assignment stop' })
      if (fault === 'assignment-extra') quiet.queued[0] = f.resign(quiet.queued[0], value => { (value.assignment as Record<string, unknown>).extra = true })
      if (fault === 'logo-missing') quiet.queued[0] = f.resign(quiet.queued[0], value => { delete value.roomLogo })
      if (fault === 'control-text') quiet.queued[0] = f.resign(quiet.queued[0], value => { value.text = 'Ordinary text' })
      if (fault === 'control-repair') quiet.queued[0] = f.resign(quiet.queued[0], value => { value.text = JSON.stringify({ op: 'hand', up: true, extra: true }) })
      if (fault === 'device') quiet.queued[0] = f.resign(quiet.queued[0], value => { value.device = 'a'.repeat(64) })
      if (fault === 'account') quiet.queued[0] = f.resign(quiet.queued[0], value => { value.participant = 'a'.repeat(64) })
      if (fault === 'epoch') quiet.epoch = 1
      f.browser.set(f.quietName, JSON.stringify(quiet))
      if (fault === 'room') { f.browser.delete(f.quietName); f.browser.set(f.quietName.slice(0, -64) + 'a'.repeat(64), JSON.stringify(quiet)) }
      expect(() => validate(f.browser, f.tab, flags, capture(f.browser, f.tab))).toThrow(OrdinaryStateHold)
    } finally { f.release() }
  })
  it.each(['outbox-only', 'history-overlap', 'history-only'])('retains actual assignment %s cuts without requiring a quiet queue', async cut => {
    const f = await snapshotFixture('quiet-assignment-epoch'); location()
    try {
      if (cut !== 'history-overlap') f.browser.delete(f.quietName)
      if (cut !== 'outbox-only') f.mutateAssignmentJournal(journal => { journal.events.push(journal.outbox[0]!.inner); if (cut === 'history-only') journal.outbox = [] })
      expect(validate(f.browser, f.tab, flags, capture(f.browser, f.tab)).quietRooms).toBe(cut === 'history-overlap' ? 1 : 0)
    } finally { f.release() }
  })
  it.each(['queue-only', 'substituted-outer', 'wrong-account', 'wrong-room', 'duplicate-match', 'duplicate-history', 'mismatched-inner', 'inner-extra', 'outer-extra'])('holds impossible quiet assignment journal %s', async fault => {
    const f = await snapshotFixture('quiet-assignment'); location()
    try {
      if (fault === 'queue-only') f.browser.delete(f.assignmentName)
      else if (fault === 'wrong-account' || fault === 'wrong-room') { const value = f.browser.get(f.assignmentName)!; f.browser.delete(f.assignmentName); f.browser.set(fault === 'wrong-account' ? f.assignmentName.replace(f.participant, 'a'.repeat(64)) : f.assignmentName.slice(0, -64) + 'a'.repeat(64), value) }
      else f.mutateAssignmentJournal(journal => {
        if (fault === 'substituted-outer') journal.outbox[0]!.outer = f.resign(journal.outbox[0]!.outer, value => { value.id = 'f'.repeat(32) })
        if (fault === 'duplicate-match') journal.outbox.push(journal.outbox[0]!)
        if (fault === 'duplicate-history') journal.events.push(journal.outbox[0]!.inner, journal.outbox[0]!.inner)
        if (fault === 'mismatched-inner') journal.outbox[0]!.inner = { ...journal.outbox[0]!.inner, content: '{}' }
        if (fault === 'inner-extra') Object.assign(journal.outbox[0]!.inner, { extra: true })
        if (fault === 'outer-extra') Object.assign(journal.outbox[0]!.outer, { extra: true })
      })
      const before = JSON.stringify([[...f.browser], [...f.tab]]), token = capture(f.browser, f.tab)
      expect(() => validate(f.browser, f.tab, flags, token)).toThrow(OrdinaryStateHold)
      expect(JSON.stringify([[...f.browser], [...f.tab]])).toBe(before)
    } finally { f.release() }
  })
})
