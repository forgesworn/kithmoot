import { ordinaryOperationMarker } from './ordinary-operation-codec.js'
import { describe, expect, it, vi } from 'vitest'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { classifyOrdinaryPhysicalName as route, ordinaryPrivateStorageName as selected, validateOrdinaryPhysicalSnapshot as validate } from './ordinary-physical-snapshot.js'
import { validateOrdinaryUiSnapshot } from './ordinary-ui-snapshot.js'

const h = 'a'.repeat(64), j = 'b'.repeat(64), a = `kithmoot.account.${h}.`, uuid = '12345678-1234-4234-8234-123456789abc'
const cases: [string, 'browser' | 'tab', string][] = [
  ['kithmoot.participant', 'browser', 'identity'], [`kithmoot.device.${h}`, 'browser', 'identity'], [`${a}kithmoot.credential.${j}`, 'browser', 'identity'], [`${a}kithmoot.device-owner.${j}`, 'browser', 'identity'],
  [`kithmoot.own-credential.${h}`, 'browser', 'identity'], [`kithmoot.own-seal.${h}`, 'browser', 'identity'],
  ...['device','device-owner','own-credential','own-seal'].map(f => [`${a}kithmoot.${f}.${j}`, 'tab', 'identity'] as [string, 'tab', string]),
  [`${a}kithmoot.invitation-proof.v2.${h}.${j}`, 'browser', 'invitationProofs'],
  [`${a}kithmoot.admission-proof.v2.${h}`, 'tab', 'invitationProofs'],
  [`kithmoot.room.${h}`, 'browser', 'access'], [`${a}kithmoot.room.${h}`, 'browser', 'access'], [`kithmoot.invitation-owner.v1.${h}`, 'browser', 'access'], [`${a}kithmoot.admission-kept.v1.${h}`, 'browser', 'access'], [`kithmoot.admission.v1.${h}`, 'tab', 'access'],
  [`kithmoot.room-epoch.v1.${h}`, 'browser', 'epoch'], [`${a}kithmoot.room-epoch.v2.${j}`, 'browser', 'epoch'], [`kithmoot.bookmarks.${h}.${j}`, 'browser', 'bookmarks'],
  [`kithmoot.quiet.v1.${h}`, 'browser', 'quiet'], [`${a}kithmoot.quiet.v1.${j}`, 'browser', 'quiet'], [`kithmoot.cadence-lease.v1.${h}.${j}.${'c'.repeat(32)}.1`, 'browser', 'cadence'],
  [`${a}kithmoot.pending.${j}`, 'browser', 'pending'], [`${a}kithmoot.pending.${j}`, 'tab', 'pending'],
  [`kithmoot.contact.v1.${h}`, 'browser', 'contacts'], ['kithmoot.rendezvous.v1', 'browser', 'contacts'], [`kithmoot.blocks.v1.${h}.${j}`, 'browser', 'contacts'], [`kithmoot.verified.${h}`, 'browser', 'contacts'], [`kithmoot.checks.v2.${h}.kithmoot.verified.${j}`, 'browser', 'contacts'],
  [`kithmoot.contacts.v2.${h}.pairing`, 'browser', 'grantedContacts'], [`kithmoot.contacts.v2.${h}.signet-contacts:state:${'c'.repeat(32)}`, 'browser', 'grantedContacts'], [`kithmoot.contacts.v2.${h}.signet-contacts:pending:${'c'.repeat(32)}`, 'browser', 'grantedContacts'],
  [`kithmoot.volume.v1.${h}`, 'browser', 'metadata'], ['kithmoot.pinned-rooms.v1', 'browser', 'metadata'], [`kithmoot.project.v1.visitor.${h}`, 'browser', 'metadata'], [`kithmoot.project.v1.${h}.${j}`, 'browser', 'metadata'],
  [`kithmoot.mute-until.v1.visitor.${h}`, 'browser', 'metadata'], [`kithmoot.mute-until.v1.${h}.${j}`, 'browser', 'metadata'],
  ['kithmoot.notification-scopes.v1.["visitor","default",""]', 'browser', 'metadata'], [`kithmoot.notification-scopes.v1.${JSON.stringify([h, 'project', 'private.label'])}`, 'browser', 'metadata'],
  [`kithmoot.channel-checks.v1.${h}.${j}`, 'browser', 'channelChecks'], [`kithmoot.context.v1.${h}`, 'browser', 'journals'], [`kithmoot.shared-projects.v1.${h}`, 'browser', 'journals'], [`kithmoot.assignments.v1.${h}.${j}`, 'browser', 'journals'],
  ...['box-discovery', 'history-recovery'].map(f => [`kithmoot.${f}.v1.${h}.${j}`, 'browser', 'private'] as [string, 'browser', string]),
  ...['uploads', 'room-logo'].map(f => [`kithmoot.${f}.v1.${h}`, 'browser', 'private'] as [string, 'browser', string]),
  ...['kithmoot.blob-deletes.v1', 'kithmoot.file-storage.v1', 'kithmoot.blossom-server'].map(n => [n, 'browser', 'private'] as [string, 'browser', string]),
  ...['effectMode', 'background', 'blurStrength', 'voicePreset', 'cameraDeviceId', 'micDeviceId', 'facePrivacy'].map(f => [`kithmoot.call.${f}`, 'browser', 'media'] as [string, 'browser', string]),
  ['kithmoot.callProfile', 'browser', 'media'], ['kithmoot.callProfile', 'tab', 'media'],
  ...['kithmoot.relays.v1', 'kithmoot.circle.v1', 'kithmoot.room-relays-fixed.v1', `kithmoot.room-relays.v1.${h}`].map(n => [n, 'browser', 'routing'] as [string, 'browser', string]),
  ...['mirror-self', 'fish.enabled', 'camera.framing', 'agents-hear', 'zen-bell', 'desktop-bell', 'profiles.enabled', 'name', 'last-nostr-account', 'last-nostr-method', 'profiles.lastKnownName.v1', 'send-delay', 'destructed.v1', 'home.fold.pinned', `room-name.v1.${h}`, `nudge.${h}`, `destruct-heads-up.${h}`].map(n => ['kithmoot.' + n, 'browser', 'ui'] as [string, 'browser', string]),
  ['kithmoot:emoji:skinTone', 'browser', 'ui'], ['kithmoot:emoji:recents', 'browser', 'ui'], ['kithmoot.notice', 'tab', 'ui'], ['kithmoot.way-back', 'tab', 'navigation'], ['kithmoot.room-switch.v1', 'tab', 'navigation'],
  ...['notify', 'notify-text', 'call-chat-panel', 'call-chat-divider', 'call-view', 'call-self-corner', 'call-hide-self', 'call-hide-no-video', 'desktopChatDrawerOpen', 'desktopProjectsRailOpen', 'desktopProjectsRailWidth', `knock.v1.${h}`, `invited.v1.${h}`].map(n => ['kithmoot.' + n, 'browser', 'entryLayout'] as [string, 'browser', string]),
  [`kithmoot.conversation.v1.visitor.undefined`, 'tab', 'entryLayout'], [`kithmoot.conversation.v1.${h}.${j}`, 'tab', 'entryLayout'], ['kithmoot.textSize', 'browser', 'appearance'], ['kithmoot.call-tab-lock.msg', 'browser', 'callCoordination'],
  ...['pubkey', 'method', 'authEvent', 'bunkerUri', 'bunkerClientSk', 'expiresAt', 'displayName', 'clientSk', 'pendingRedirect', 'pendingRelayAuth'].map(k => ['signet:login.' + k, 'browser', 'signet'] as [string, 'browser', string]),
  ...['kithmoot-mls-vault-v1.revision', 'kithmoot.mls-coordinated-vault.revision', 'kithmoot-rendezvous-vault-v1:revision'].map(n => [n, 'browser', 'signal'] as [string, 'browser', string]), ['kithmoot.ordinary-tab.v1', 'tab', 'tabMarker'],
]
describe('complete reserved physical namespace routing', () => {
  for (const [name, kind, family] of cases) it(`routes ${kind} ${name.slice(0, 90)} exactly once`, () => {
    const value = route(name, kind); expect(value?.family).toBe(family); expect(Object.isFrozen(value)).toBe(true)
    expect(value?.custody).toBe(family === 'signal' ? 'signal' : family === 'tabMarker' ? 'tab-marker' : 'protected')
    expect(selected(name)).toBe(true)
  })
  for (const name of ['kithmoot', 'kithmoot.', 'kithmoot:new', 'kithmoot-new', 'signet:login', 'signet:login-new', 'signet:login:pubkey', 'signet:login.future', 'kithmoot:participant', 'kithmoot.device', 'kithmoot.credential', 'kithmoot.room-epoch.v3.' + h, 'kithmoot.rooms.v1', 'kithmoot.pending.' + h, 'kithmoot.pending', a + 'kithmoot.participant', a + a + 'kithmoot.device.' + h, a + 'kithmoot.call.background', a + 'kithmoot:emoji:recents', 'kithmoot.own-seal.' + h.toUpperCase(), 'kithmoot.ordinary-tab.v2', 'kithmoot-mls-vault-v1:revision', 'kithmoot-rendezvous-vault-v1.revision', 'kithmoot.call-tab-lock', 'kithmoot.textSize.extra', 'kithmoot.notification-scopes.v1.["visitor","room","bad"]', 'kithmoot.mute-until.v1.visitor.' + h.toUpperCase(), 'kithmoot.mute-until.v1.visitor', 'kithmoot.mute-until.v1.' + h, 'kithmoot.mute-until.v2.visitor.' + h, a + 'kithmoot.mute-until.v1.visitor.' + h]) it(`holds unsupported ${name.slice(0, 90)}`, () => {
    expect(selected(name)).toBe(true); expect(() => route(name, 'browser')).toThrow(OrdinaryStateHold)
  })
  it('holds wrong owners and unsupported wrappers for each single-owner route', () => {
    for (const [name, kind] of cases) {
      if (![`${a}kithmoot.pending.${j}`, 'kithmoot.callProfile'].includes(name) && !new RegExp('^kithmoot\\.account\\.[0-9a-f]{64}\\.kithmoot\\.(?:device|device-owner|own-credential|own-seal)\\.[0-9a-f]{64}$').test(name)) expect(() => route(name, kind === 'tab' ? 'browser' : 'tab')).toThrow(OrdinaryStateHold)
    }
    for (const name of ['signet:login.clientSk', 'kithmoot.textSize', 'kithmoot.notification-scopes.v1.["visitor","default",""]', 'kithmoot.bookmarks.' + h + '.' + j]) expect(() => route(a + name, 'browser')).toThrow(OrdinaryStateHold)
  })
  it('leaves unrelated origin names outside private scope', () => { for (const n of ['theme', 'app.account', 'signet:other', 'another.kithmoot.participant']) { expect(selected(n)).toBe(false); expect(route(n, 'browser')).toBeUndefined() } })
  it('counts the special rows while requiring all ordinary semantic validators separately', () => {
    const image = new Map([['kithmoot.name', 'malformed\nname'], ['kithmoot.textSize', 'large'], ['kithmoot-mls-vault-v1.revision', uuid]])
    expect(validate(image, { kind: 'browser' })).toEqual({ protectedRecords: 2, signals: 1, tabMarkers: 0, families: { ui: 1, appearance: 1, signal: 1 } })
    expect(() => validateOrdinaryUiSnapshot(image, false, { kind: 'browser' })).toThrow(OrdinaryStateHold)
  })
  for (const size of ['standard', 'large', 'huge']) it(`protects exact ${size} text size`, () => expect(validate(new Map([['kithmoot.textSize', size]]), { kind: 'browser' }).protectedRecords).toBe(1))
  for (const [name, raw] of [['kithmoot.textSize', 'giant'], ['kithmoot-mls-vault-v1.revision', 'private-room'], ['kithmoot.mls-coordinated-vault.revision', uuid.toUpperCase()], ['kithmoot-rendezvous-vault-v1:revision', ''], ['kithmoot.ordinary-tab.v1', uuid]] as const) it(`holds malformed special ${name}`, () => expect(() => validate(new Map([[name, raw]]), { kind: name.includes('ordinary-tab') ? 'tab' : 'browser' })).toThrow(OrdinaryStateHold))
  for (const key of ['', h + '|' + j, 'opaque'.repeat(100)]) it(`keeps callable call-lock key length ${key.length} inert`, () => {
    const raw = JSON.stringify({ message: { t: 'claim', key, tab: uuid }, at: 1, r: 0.5 })
    expect(validate(new Map([['kithmoot.call-tab-lock.msg', raw]]), { kind: 'browser' }).protectedRecords).toBe(1)
  })
  it('holds malformed call metadata without silently dropping it', () => {
    for (const raw of ['{}', JSON.stringify({ message: { t: 'claim', key: 'room', tab: uuid }, at: 1, r: 1 }), JSON.stringify({ message: { t: 'future', key: 'room', tab: uuid }, at: 1, r: 0 })]) expect(() => validate(new Map([['kithmoot.call-tab-lock.msg', raw]]), { kind: 'browser' })).toThrow(OrdinaryStateHold)
  })
  it('rejects oversized values and prospective images before parsing call metadata', () => {
    const raw = 'x'.repeat(8 * 1024 * 1024), parse = vi.spyOn(JSON, 'parse')
    try {
      expect(() => validate(new Map([['kithmoot.call-tab-lock.msg', raw + 'x']]), { kind: 'browser' })).toThrow(OrdinaryStateHold)
      expect(() => validate(new Map(['kithmoot.call-tab-lock.msg', 'kithmoot.name', 'kithmoot.profiles.lastKnownName.v1', 'kithmoot.call.background'].map(n => [n, raw])), { kind: 'browser' })).toThrow(OrdinaryStateHold)
      expect(parse).not.toHaveBeenCalled()
    } finally { parse.mockRestore() }
  })
})

describe('reserved operation marker physical routing', () => {
  const tab = ('tab:' + h) as `tab:${string}`, name = 'kithmoot.operation-journal.v1.' + h
  const raw = ordinaryOperationMarker({ id: j, tab, sequence: 1, commitment: null })
  it('routes exact canonical paired markers while granting no journal provenance', () => {
    for (const kind of ['browser', 'tab'] as const) {
      expect(route(name,kind)).toEqual({ family: 'operationMarkers', custody: 'protected' })
      expect(validate(new Map([[name,raw]]),{kind}).protectedRecords).toBe(1)
    }
  })
  it('rejects marker name/value mismatch, aliases, unknown versions and account wrappers', () => {
    expect(() => validate(new Map([[name.replace(h,j),raw]]),{kind:'browser'})).toThrow(OrdinaryStateHold)
    for (const alias of [name+':alias',name.replace('.v1.','.v2.'),a+name]) expect(() => route(alias,'browser')).toThrow(OrdinaryStateHold)
    for (const bad of [raw+' ',raw.replace('[1,','[2,'),JSON.stringify([1,j,tab,0,null]),JSON.stringify([1,j,tab,1,'invalid'])])
      expect(() => validate(new Map([[name,bad]]),{kind:'tab'})).toThrow(OrdinaryStateHold)
  })
})

it('protects the exact NIP-05 preference only in browser custody and holds aliases', () => {
  const key = 'kithmoot.nip05.verify'
  expect(route(key, 'browser')).toEqual({family: 'ui', custody: 'protected'})
  expect(validate(new Map([[key, 'false']]), {kind: 'browser'}).protectedRecords).toBe(1)
  expect(() => route(key, 'tab')).toThrow(OrdinaryStateHold)
  for (const name of [key + '.future', a + key, 'kithmoot.nip05.verify:alias']) {
    expect(selected(name)).toBe(true)
    expect(() => route(name, 'browser')).toThrow(OrdinaryStateHold)
  }
})
