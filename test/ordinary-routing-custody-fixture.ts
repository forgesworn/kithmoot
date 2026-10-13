/// <reference lib="dom.iterable" />
import { bytesToHex } from '@noble/hashes/utils'
import { getPublicKey } from 'nostr-tools/pure'
import { roomInvitation, deriveInvitationId } from '../src/invitation.js'
import { encodeRoomLink } from '../src/link.js'
import { canonicalRoomRelays, signRoomRelays } from '../src/room-relays.js'
import { memoryDeviceStore, storeKeptAdmission } from '../app/src/device-store.js'
import { storeInvitationOwner, INVITATION_OWNER_PREFIX } from '../app/src/invitation-store.js'
import { rememberRoom } from '../app/src/rooms-store.js'
import { accountRoomStore } from '../app/src/room-bookmarks.js'
import { RelayConnections } from '../app/src/relay-settings.js'
import { snapshotFixture, SNAPSHOT_NOW } from './ordinary-snapshot-fixture.js'
import { capturedMainWriter } from './ordinary-main-writer-fixture.js'

export const ROUTING_CUSTODY_MODES = ['owner', 'member-kept', 'member-tab', 'zero', 'startup-only', 'metadata-only',
  'multiple-evidence', 'rotated-old', 'rotated-new', 'unsigned-fixed'] as const
export const ROUTING_CUSTODY_FAULTS = ['wrong-signer', 'wrong-room', 'wrong-version', 'wrong-list', 'signature',
  'cross-room', 'missing-pin', 'conflicting-inviter', 'missing-old-pin', 'fixed-owner', 'fixed-member',
  'fixed-different-list', 'fixed-without-added', 'claimed-current'] as const

/** Actual room/access, fixed-list and extracted main record writers. Synthetic
 * keys and offline globals prepare source bytes before the native probe; no
 * production controls, current authority, dialing or recovery are exercised. */
export async function routingCustodyFixture(mode: typeof ROUTING_CUSTODY_MODES[number] = 'owner', options: { rootSeed?: number; bearerSeed?: number } = {}) {
  const f = await snapshotFixture('ordinary', options), secret = new Uint8Array(32).fill(options.rootSeed ?? 5), inviter = new Uint8Array(32), nextInviter = new Uint8Array(32), foreign = new Uint8Array(32)
  inviter[31] = 1; nextInviter[31] = 2; foreign[31] = 9
  const invitation = roomInvitation(new Uint8Array(32).fill(options.bearerSeed ?? 7), getPublicKey(inviter), true)
  const relayHints = ['wss://relay.example/']
  const urlFor = (value = invitation) => encodeRoomLink('https://ordinary-snapshot.kithmoot.test/j/', { invitation: value, relays: relayHints, iceUrls: [] })
  const store = memoryDeviceStore(), url = urlFor()
  rememberRoom(store, { roomId: f.roomId, link: url, openedAt: SNAPSHOT_NOW })
  const retainMember = () => storeKeptAdmission(store, deriveInvitationId(invitation), { secret, persistent: true, epoch: 0 }, SNAPSHOT_NOW)
  if (mode === 'member-kept') retainMember()
  else if (mode === 'member-tab') {
    const cache = capturedMainWriter('cacheAdmission', ['ADMISSION_CACHE_PREFIX'], { bytesToHex, deriveInvitationId,
      sessionStorage: { setItem: (name: string, raw: string) => f.tab.set(name, raw) } })
    cache.write(invitation, { secret, persistent: true, epoch: 0 })
  } else if (mode !== 'metadata-only') storeInvitationOwner(store, invitation, secret, inviter, SNAPSHOT_NOW)
  if (mode === 'multiple-evidence') rememberRoom(accountRoomStore(store, f.participant), { roomId: f.roomId, link: url, openedAt: SNAPSHOT_NOW })
  let startupUrl = url
  if (mode === 'rotated-old' || mode === 'rotated-new') {
    const next = roomInvitation(new Uint8Array(32).fill(8), getPublicKey(nextInviter), true)
    startupUrl = urlFor(next)
    storeInvitationOwner(store, next, secret, nextInviter, SNAPSHOT_NOW + 1)
    rememberRoom(store, { roomId: f.roomId, link: startupUrl, openedAt: SNAPSHOT_NOW + 1 })
    const back = capturedMainWriter('rememberWayBack', ['WAY_BACK_KEY'], { currentRoomId: () => f.roomId,
      encodeRoomUrl: () => url, joinLinkBase: () => 'https://ordinary-snapshot.kithmoot.test/j/', relays: relayHints, iceUrls: [],
      currentRoomLabel: () => '', sessionStorage: { setItem: (name: string, raw: string) => f.tab.set(name, raw) } })
    back.write()
    next.bearer.fill(0)
  }
  for (const name of store.keys()) f.browser.set(name, store.get(name)!)
  if (mode === 'startup-only') f.browser.delete(f.roomName)
  if (mode === 'metadata-only') {
    f.browser.delete(f.pendingName)
    for (const name of [...f.browser.keys()]) if (name.startsWith('kithmoot.device.') || name.startsWith('kithmoot.own-credential.')) f.browser.delete(name)
    startupUrl = 'https://ordinary-snapshot.kithmoot.test/j/'
  }
  const storage = { getItem: (name: string) => f.browser.get(name) ?? null, setItem: (name: string, raw: string) => f.browser.set(name, raw) }
  const captured = capturedMainWriter('storeRoomRelayRecord', ['ROOM_RELAYS_PREFIX'], { localStorage: storage })
  const name = 'kithmoot.room-relays.v1.' + f.roomId, fixedName = 'kithmoot.room-relays-fixed.v1'
  const relays = canonicalRoomRelays(['wss://z.invalid', 'wss://a.invalid']), version = mode === 'zero' ? 0 : SNAPSHOT_NOW
  const write = (key = inviter, roomId = f.roomId) => captured.write(f.roomId, { relays, version, sig: signRoomRelays({ roomId, version, relays, authoritySk: key }) })
  write(mode === 'rotated-new' ? nextInviter : inviter)
  const fixed = (signed: boolean, c = relayHints) => { new RelayConnections(storage, relayHints).setRoomRelays(f.roomId, { fixed: c, signed }) }
  if (mode === 'unsigned-fixed') fixed(false)
  const state = { startupUrl }, oldOwnerName = INVITATION_OWNER_PREFIX + deriveInvitationId(invitation)
  return { ...f, get startupUrl() { return state.startupUrl }, name, fixedName, oldOwnerName, provenance: captured.provenance,
    damage: (fault: typeof ROUTING_CUSTODY_FAULTS[number]) => {
      if (fault === 'wrong-signer') write(foreign)
      else if (fault === 'wrong-room') write(inviter, 'a'.repeat(64))
      else if (fault === 'cross-room') { f.browser.set('kithmoot.room-relays.v1.' + 'a'.repeat(64), f.browser.get(name)!); f.browser.delete(name) }
      else if (fault === 'missing-pin') {
        f.browser.set(f.roomName, JSON.stringify({ ...JSON.parse(f.browser.get(f.roomName)!), link: f.url }))
        f.browser.delete(oldOwnerName); state.startupUrl = 'https://ordinary-snapshot.kithmoot.test/j/'
      } else if (fault === 'conflicting-inviter') {
        const wrong = roomInvitation(new Uint8Array(32).fill(7), getPublicKey(foreign), true)
        state.startupUrl = urlFor(wrong); wrong.bearer.fill(0)
      } else if (fault === 'missing-old-pin') { f.browser.delete(oldOwnerName); f.tab.delete('kithmoot.way-back') }
      else if (fault.startsWith('fixed-')) {
        if (fault === 'fixed-member') {
          f.browser.delete(oldOwnerName); retainMember()
          for (const k of store.keys()) if (k.startsWith('kithmoot.admission-kept.')) f.browser.set(k, store.get(k)!)
        }
        fixed(true, fault === 'fixed-different-list' ? ['wss://other.invalid/'] : relayHints)
        if (fault === 'fixed-without-added') f.browser.delete(name)
      } else {
        const record = JSON.parse(f.browser.get(name)!)
        if (fault === 'wrong-version') record.version++
        else if (fault === 'wrong-list') record.relays = ['wss://other.invalid/']
        else if (fault === 'signature') record.sig = (record.sig[0] === '0' ? '1' : '0') + record.sig.slice(1)
        else record.current = true
        f.browser.set(name, JSON.stringify(record))
      }
    },
    release: () => { f.release(); secret.fill(0); inviter.fill(0); nextInviter.fill(0); foreign.fill(0); invitation.bearer.fill(0) } }
}
