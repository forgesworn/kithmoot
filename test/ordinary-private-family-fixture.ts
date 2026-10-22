import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure'
import { matchFilters, type Filter } from 'nostr-tools/filter'
import { base64urlnopad } from '@scure/base'
import { buildLinkCard, buildCard, cardLink } from 'nostr-contact-card'
import type { RelayTransport } from '../src/relay-pool.js'
import { boxFixture } from './box-status-fixture.js'
import { memoryDeviceStore } from '../app/src/device-store.js'
import { addContactFromCard } from '../app/src/contact-store.js'
import { BoxDiscovery } from '../app/src/box-discovery.js'
import { saveHistoryRecoveryProgress } from '../app/src/history-recovery-progress.js'
import { recordUpload, deleteUploads, PENDING_BLOB_DELETES_KEY } from '../app/src/blob-deletion.js'
import { chooseFileServer } from '../app/src/file-storage.js'
import { RoomLogoCache } from '../app/src/room-logo-store.js'
import { readLogoImage, type LogoImage } from '../src/logo-image.js'

// Original checked-in PNG bytes, not a remote URL or an image-decoder mock.
const image: LogoImage = {"v": 1, "mime": "image/png", "width": 128, "height": 128, "data": "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", "sha256": "0f70c63b87e9dee9c6c7268451da77849c9722aaa0988bf51f37c813bd6075ce"}
export const PRIVATE_MODES = ['all', 'discovery-consent', 'discovery-claim-only', 'discovery-status-only', 'discovery-verified',
  'discovery-malformed', 'discovery-status-conflict', 'discovery-claim-conflict', 'discovery-retired-old-order', 'discovery-disabled',
  'discovery-node-change', 'discovery-status-extra', 'history-empty', 'history-extensions', 'history-opaque-relay',
  'uploads-opaque', 'uploads-empty-url', 'pending-delete', 'pending-delete-t0', 'file-consent', 'legacy-only', 'logo-image', 'logo-null'] as const
export type PrivateMode = typeof PRIVATE_MODES[number]
class Relay implements RelayTransport {
  subscriptions: { filters: Filter[]; receive: (e: Event) => void; ready: () => void; stopped: boolean }[] = []
  async publish(): Promise<void> { throw Error('Synthetic discovery cannot publish') }
  subscribe(filters: Filter[], receive: (e: Event) => void, ready = () => {}) {
    const sub = { filters, receive, ready, stopped: false }; this.subscriptions.push(sub)
    return () => { sub.stopped = true }
  }
  send(event: Event) { for (const s of [...this.subscriptions]) if (!s.stopped && matchFilters(s.filters, event)) s.receive(event) }
  eose() { for (const s of this.subscriptions) if (!s.stopped) s.ready() }
  close() { for (const s of this.subscriptions) s.stopped = true }
}
/** Real app writers with deterministic synthetic identities/relay callbacks.
 * No real box/operator, owner authority or production root is established. */
export async function privateFamilyFixture(mode: PrivateMode = 'all') {
  const f = boxFixture(), store = memoryDeviceStore(), room = 'ab'.repeat(32), hash = 'cd'.repeat(32), origin = 'https://files.example:8443'
  const keys = { discovery: `kithmoot.box-discovery.v1.${f.master}.${f.p}`, history: `kithmoot.history-recovery.v1.${f.master}.${f.p}`,
    uploads: `kithmoot.uploads.v1.${room}`, pending: PENDING_BLOB_DELETES_KEY, consent: 'kithmoot.file-storage.v1', legacy: 'kithmoot.blossom-server', logo: `kithmoot.room-logo.v1.${room}` }
  if (mode === 'all' || mode.startsWith('discovery-')) {
    const added = addContactFromCard(store, f.contactCard, f.now); if (!added.ok) throw Error('Fixture contact did not verify')
    const pool = new Relay(), book = new BoxDiscovery({ store, now: () => f.now, ticking: false, transport: () => pool, changed: () => {} })
    book.setEnabled(f.master, f.p, true)
    if (mode !== 'discovery-consent') {
      if (mode !== 'discovery-status-only') pool.send(f.claim)
      if (mode !== 'discovery-claim-only') pool.send(f.status())
      pool.eose()
    }
    if (mode === 'all' || mode === 'discovery-malformed') pool.send(f.status(f.withTag('drops', ['on', 'ws://malformed.example']), f.now + 1))
    if (mode === 'discovery-status-conflict') pool.send(f.status(f.withTag('drops', ['off'])))
    if (mode === 'discovery-claim-conflict') pool.send(finalizeEvent({ ...f.claim, tags: [...f.claim.tags, ['name', 'Changed']] }, f.masterKey))
    if (mode === 'discovery-retired-old-order') {
      pool.send(finalizeEvent({ ...f.claim, created_at: f.now + 20 }, f.masterKey))
      pool.send(finalizeEvent({ ...f.claim, created_at: f.now + 10, tags: f.claim.tags.filter(t => !(t[0] === 'p' && t[3] === 'stash')).map(t => t[0] === 'status' ? ['status', 'retired'] : t) }, f.masterKey))
    }
    if (mode === 'discovery-disabled') book.setEnabled(f.master, f.p, false)
    if (mode === 'discovery-node-change') {
      const link = buildLinkCard({ nodeSecret: new Uint8Array(32).fill(8), issuedAt: f.now, expiresAt: f.now + 86400, serial: 1, relays: [] })
      const card = cardLink('https://kithmoot.test/j/', buildCard({identityPrivateKey: f.masterKey, rz: getPublicKey(new Uint8Array(32).fill(5)),
        ephemeralPrivateKey: new Uint8Array(32).fill(6), boxes: [{p: f.p, claim: f.claim.id, card: base64urlnopad.encode(link)}], now: () => f.now }))
      if (!addContactFromCard(store, card, f.now).ok) throw Error('Changed fixture node did not verify')
      book.setEnabled(f.master, f.p, false)
    }
    if (mode === 'discovery-status-extra') pool.send({...f.status(f.tags, f.now + 1), carrierNote: {opaque: ['preserve JSON']}} as Event)
    book.close()
  }
  if (mode === 'all' || mode.startsWith('history-')) {
    const windows = mode === 'history-empty' ? [] : [{relay: 'wss://two.example', class: 'authored' as const, until: f.now},
      {relay: mode === 'history-opaque-relay' ? 'legacy relay suggestion, never dialled' : 'wss://one.example', class: 'addressed' as const, until: f.now - 1}]
    const extensions = mode === 'all' || mode === 'history-extensions'
    saveHistoryRecoveryProgress(store, {version: 1, person: f.master, node: f.p, windows: windows.map(w => extensions ? {...w, opaque: {keep: 'exact'}} : w),
      ...(extensions ? {future: {opaque: ['retained extension']}} : {})})
  }
  if (mode === 'all' || mode.startsWith('uploads-')) {
    recordUpload(store, room, {url: mode === 'uploads-empty-url' ? '' : 'arbitrary old destination text', sha256: hash})
    recordUpload(store, room, {url: `${origin}/blossom/${hash}`, sha256: hash})
  }
  if (mode === 'all' || mode.startsWith('pending-delete')) {
    await deleteUploads({blobs: [{url: `${origin}/blossom/${hash}`, sha256: hash}], origins: [origin], sk: f.boxKey,
      now: () => mode === 'pending-delete-t0' ? 0 : f.now, store, fetch: async () => {throw TypeError('Synthetic offline operator')}})
  }
  if (mode === 'all' || mode === 'file-consent') chooseFileServer({getItem: store.get, setItem: store.set, removeItem: store.remove}, origin)
  if (mode === 'all' || mode === 'legacy-only') store.set(keys.legacy, 'display-only arbitrary legacy suggestion')
  if (mode === 'all' || mode.startsWith('logo-')) {
    if (!readLogoImage(image)) throw Error('Original logo bytes no longer verify')
    new RoomLogoCache(store).keep(room, {image: mode === 'logo-null' ? null : image, id: 'a'.repeat(32), at: f.now * 1000, sentAt: f.now, by: f.master}, 3, true)
  }
  // Contact is support data for the real discovery writer, left for its own
  // validator/composite. This isolated family fixture never calls it validated.
  const records = new Map(store.keys().filter(k => Object.values(keys).includes(k)).map(k => [k, store.get(k)!]))
  return {records, keys, room, hash, origin, ...f}
}
export const PRIVATE_FAULTS = ['wrapped', 'version', 'name', 'noncanonical', 'discovery-revision', 'discovery-node', 'discovery-card-signature',
  'discovery-serial', 'discovery-missing-pair', 'discovery-floor', 'discovery-status-signature', 'discovery-status-author', 'discovery-claim-node',
  'history-person', 'history-node', 'history-window-clock', 'history-window-class', 'history-window-duplicate', 'history-window-cap',
  'uploads-hash', 'uploads-duplicate', 'uploads-cap', 'uploads-extra', 'uploads-empty', 'pending-legacy', 'pending-target', 'pending-signature',
  'consent-origin', 'consent-disclosure', 'consent-extra', 'legacy-version', 'logo-epoch', 'logo-clock', 'logo-image-hash', 'logo-image-url',
  'logo-by', 'logo-cap'] as const
export function damagePrivateFamilyFixture(f: Awaited<ReturnType<typeof privateFamilyFixture>>, records: Map<string,string>, fault: typeof PRIVATE_FAULTS[number]): void {
  const family = fault.split('-')[0], key = family === 'discovery' ? f.keys.discovery : family === 'history' ? f.keys.history :
    family === 'uploads' ? f.keys.uploads : family === 'pending' ? f.keys.pending : family === 'consent' ? f.keys.consent : family === 'logo' ? f.keys.logo : f.keys.discovery
  if (fault === 'wrapped') {records.set(`kithmoot.account.${f.master}.${key}`,records.get(key)!);records.delete(key);return}
  if (fault === 'version' || fault === 'name') {records.set(key.replace('.v1.', fault === 'version' ? '.v2.' : '.v1.bad.'),records.get(key)!);records.delete(key);return}
  if (fault === 'noncanonical') {records.set(key,records.get(key)!+' ');return}
  if (fault === 'legacy-version') {records.set(f.keys.legacy+'.v2','not consent');return}
  const v = JSON.parse(records.get(key)!)
  if (fault === 'discovery-revision') v.revision += ' '
  if (fault === 'discovery-node') v.nodeId = 'f'.repeat(64)
  if (fault === 'discovery-card-signature') v.card = v.card.slice(0,-4)+'AAAA'
  if (fault === 'discovery-serial') v.serial++
  if (fault === 'discovery-missing-pair') delete v.card
  if (fault === 'discovery-floor') v.statusConflictAt = -1
  if (fault === 'discovery-status-signature') v.status.sig = '0'.repeat(128)
  if (fault === 'discovery-status-author') v.status = finalizeEvent(v.status,f.masterKey)
  if (fault === 'discovery-claim-node') v.claim = finalizeEvent({...f.claim,tags:f.claim.tags.map(t=>t[0]==='d'?['d','f'.repeat(64)]:t)},f.masterKey)
  if (fault === 'history-person') v.person = f.p
  if (fault === 'history-node') v.node = f.master
  if (fault === 'history-window-clock') v.windows[0].until = 0.5
  if (fault === 'history-window-class') v.windows[0].class = 'everything'
  if (fault === 'history-window-duplicate') v.windows.push(v.windows[0])
  if (fault === 'history-window-cap') v.windows = Array.from({length:65},(_,i)=>({relay:String(i),class:'authored',until:0}))
  if (fault === 'uploads-hash') v[0].sha256 = f.hash.toUpperCase()
  if (fault === 'uploads-duplicate') v.push(v[0])
  if (fault === 'uploads-cap') v.push(...Array(1000).fill(v[0]))
  if (fault === 'uploads-extra') v[0].key = 'must not silently drop'
  if (fault === 'uploads-empty') v.length = 0
  if (fault === 'pending-legacy') {v[0].auth.tags.pop();v[0].auth=finalizeEvent(v[0].auth,f.boxKey)}
  if (fault === 'pending-target') v[0].url = v[0].url.replace(':8443',':9443')
  if (fault === 'pending-signature') v[0].auth.sig = '0'.repeat(128)
  if (fault === 'consent-origin') v.origin += '/'
  if (fault === 'consent-disclosure') v.disclosure = 0
  if (fault === 'consent-extra') v.private = 'hold intact'
  if (fault === 'logo-epoch') v.epoch = -1
  if (fault === 'logo-clock') v.record.sentAt--
  if (fault === 'logo-image-hash') v.record.image.sha256 = 'f'.repeat(64)
  if (fault === 'logo-image-url') v.record.image.data = 'https://tracker.invalid'
  if (fault === 'logo-by') v.record.by = f.master
  if (fault === 'logo-cap') for(let i=0;i<65;i++)records.set('kithmoot.room-logo.v1.'+i.toString(16).padStart(64,'0'),JSON.stringify(v))
  records.set(key,JSON.stringify(v))
}
