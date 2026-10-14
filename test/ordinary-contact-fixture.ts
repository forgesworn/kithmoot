import { base64urlnopad } from '@scure/base'
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { buildCard, buildLinkCard, encodeCard } from 'nostr-contact-card'
import { memoryDeviceStore } from '../app/src/device-store.js'
import { addContactFromCard, CONTACT_PREFIX, RENDEZVOUS_KEY, myRendezvousSecret, refreshContactBox, rotateRendezvous } from '../app/src/contact-store.js'
import { rememberVerified, scopedVerificationStore, VERIFIED_PREFIX } from '../app/src/verified-store.js'

export const CONTACT_NOW = 1_800_000_000, WEEK = 7 * 24 * 3600
export const CONTACT_MODES = ['card','refreshed','replayed','equal-replayed','legacy-cardless','legacy-refreshed','duplicate-hints','duplicate-boxes','shape-only-hex','self-only','empty','rotated','expired','multi-observer'] as const
export type ContactFixtureMode = typeof CONTACT_MODES[number]
export const CONTACT_FAULTS = ['row-json','row-extra','row-duplicate','physical-participant','participant-curve','contact-version','wrapped','nested-wrapped',
  'rz-shape','name','attest','bond-extra','bond-persona-extra','issued','expired-read','read-time','relays','boxes','claim','node','serial',
  'card-signature','card-serial','card-padding','box-relay','box-onion','carriers','source','card-refreshed-time','refreshed-time','refreshed-hints','refreshed-expiry',
  'scalar-zero','scalar-overflow','scalar-case','scalar-empty','rendezvous-version','verified-physical','verified-extra','verified-name','verified-time','observer-version','observer-key','observer-nested','observer-wrapped','verified-wrapped'] as const
/** Actual card/Link cryptography and storage writers, no discovery or network.
 * Cardless legacy rows are the pre-5623c91 format, not signed evidence. */
export function contactFixture(mode: ContactFixtureMode = 'card') {
  const store = memoryDeviceStore(), identity = new Uint8Array(32), boxKey = new Uint8Array(32), node = new Uint8Array(32).fill(9)
  const rz = new Uint8Array(32).fill(2), ephemeral = new Uint8Array(32).fill(3)
  identity[31] = 4; boxKey[31] = 5
  const p = getPublicKey(identity), boxP = getPublicKey(boxKey), observer = getPublicKey(new Uint8Array(32).fill(6)), otherObserver = getPublicKey(new Uint8Array(32).fill(7))
  const link = (serial: number, relays: string[], now = CONTACT_NOW, expires = now + WEEK - 120) => buildLinkCard({nodeSecret:node,serial,issuedAt:now - 60,expiresAt:expires,relays,onions:[{host:'a'.repeat(56),port:443}]})
  const card = (serial: number, relays: string[], now = CONTACT_NOW, expires = now + WEEK - 120) => buildCard({identityPrivateKey:identity,
    rz: mode === 'shape-only-hex' ? 'f'.repeat(64) : getPublicKey(rz), ephemeralPrivateKey:ephemeral, name:'Ada 🧭', now:()=>now,ttlSeconds:WEEK,
    relays:['wss://Relay.Example/path?purpose=contact','wss://Relay.Example/path?purpose=contact'],
    boxes:Array(mode === 'duplicate-boxes' ? 2 : 1).fill({p:boxP,claim:'c'.repeat(64),card:base64urlnopad.encode(link(serial,relays,now,expires)),carriers:['mobile','mobile']}),
    attest:'key-capsule',bond:{pubkey:p,displayName:'Ada',nonce:'b'.repeat(32),personas:[{pubkey:p,label:'Home'}]}})
  try {
    if (mode !== 'empty' && mode !== 'self-only') {
      const initial = card(9,mode === 'duplicate-hints' ? ['wss://Box.Example/?v=one','wss://Box.Example/?v=one'] : ['wss://one.example'])
      let encoded = encodeCard(initial)
      if (mode === 'shape-only-hex') {
        const content = JSON.parse(initial.event.content); content.eph = 'f'.repeat(64)
        encoded = encodeCard(finalizeEvent({kind:initial.event.kind,created_at:initial.event.created_at,tags:initial.event.tags,content:JSON.stringify(content)},identity))
      }
      const added = addContactFromCard(store,encoded,CONTACT_NOW); if (!added.ok) throw new Error(added.reason)
      if (mode === 'refreshed' || mode === 'legacy-refreshed') {
        const refreshed = refreshContactBox(store,p,boxP,link(10,['wss://fresh.example'],CONTACT_NOW + WEEK + 10),CONTACT_NOW + WEEK + 10)
        if (!refreshed.ok) throw new Error(refreshed.reason)
      }
      if (mode === 'replayed' || mode === 'equal-replayed') {
        // Prior bytes will be expired at this second read. The new valid
        // lower/equal serial's hints/expiry coexist with retained old bytes.
        const now = CONTACT_NOW + WEEK + 10, addedAgain = addContactFromCard(store,encodeCard(card(mode === 'replayed' ? 4 : 9,['wss://two.example'],now)),now)
        if (!addedAgain.ok) throw new Error(addedAgain.reason)
      }
      if (mode === 'legacy-cardless' || mode === 'legacy-refreshed') {
        const value = JSON.parse(store.get(CONTACT_PREFIX + p)!); delete value.boxes[0].card; store.set(CONTACT_PREFIX + p,JSON.stringify(value))
      }
      const own = myRendezvousSecret(store,()=>new Uint8Array(32).fill(8)); own.fill(0)
      if (mode === 'rotated') rotateRendezvous(store)
      rememberVerified(store,p,'Legacy Ada',CONTACT_NOW * 1000)
      rememberVerified(scopedVerificationStore(store,observer),boxP,'Box',CONTACT_NOW * 1000 + 1000)
      if (mode === 'multi-observer') rememberVerified(scopedVerificationStore(store,otherObserver),boxP,'Other observation',CONTACT_NOW * 1000 + 2000)
    }
    if (mode === 'self-only') { const own = myRendezvousSecret(store,()=>new Uint8Array(32).fill(8)); own.fill(0) }
    const name = CONTACT_PREFIX + p, records = new Map(store.keys().map(name => [name,store.get(name)!]))
    return {records,name,p,boxP,observer,otherObserver,verifiedName:VERIFIED_PREFIX + p,observerName:`kithmoot.checks.v2.${observer}.${VERIFIED_PREFIX}${boxP}`,
      mode,historicalNow:mode === 'expired' ? CONTACT_NOW + 2 * WEEK : CONTACT_NOW}
  } finally { identity.fill(0);boxKey.fill(0);rz.fill(0);ephemeral.fill(0);node.fill(0) }
}
export function damageContactFixture(f: ReturnType<typeof contactFixture>, records: Map<string,string>, fault: string): void {
  const value = JSON.parse(records.get(f.name)!), box = value.boxes[0]
  if (fault === 'row-extra') value.extra = true
  if (fault === 'rz-shape') value.rz = 'nope'
  if (fault === 'name') value.name = 'Hidden\u202ename'
  if (fault === 'attest') value.attest = 'https://secret.example'
  if (fault === 'bond-extra') value.bond.extra = true
  if (fault === 'bond-persona-extra') value.bond.personas[0].extra = true
  if (fault === 'issued') value.issued = value.readAt + 301
  if (fault === 'expired-read') value.readAt = value.expires
  if (fault === 'read-time') value.readAt = -1
  if (fault === 'relays') value.relays = ['ws://relay.example']
  if (fault === 'boxes') value.boxes = Array(5).fill(box)
  if (fault === 'claim') box.claim = ''
  if (fault === 'node') box.nodeId = 'f'.repeat(64)
  if (fault === 'serial') box.highestSerial++
  if (fault === 'card-signature') {const bytes=base64urlnopad.decode(box.card);bytes[bytes.length-1]^=1;box.card=base64urlnopad.encode(bytes);bytes.fill(0)}
  if (fault === 'card-serial') {const bytes=base64urlnopad.decode(box.card);new DataView(bytes.buffer).setBigUint64(53,10n);box.card=base64urlnopad.encode(bytes);bytes.fill(0)}
  if (fault === 'card-padding') box.card += '='
  if (fault === 'box-relay') box.relays = ['wss://user:password@box.example']
  if (fault === 'box-onion') box.onions = ['a'.repeat(56)+'.onion:65536']
  if (fault === 'carriers') box.carriers = ['private:carrier']
  if (fault === 'source') box.source = 'trusted'
  if (fault === 'card-refreshed-time') box.refreshedAt = CONTACT_NOW
  if (fault === 'refreshed-time') box.refreshedAt = 0
  if (fault === 'refreshed-hints') box.relays = ['wss://substitution.example']
  if (fault === 'refreshed-expiry') box.linkExpiresAt++
  records.set(f.name,fault === 'row-json' ? '{' : JSON.stringify(value))
  if (fault === 'row-duplicate') records.set(f.name,records.get(f.name)!.replace('{','{"p":"'+'f'.repeat(64)+'",'))
  if (['physical-participant','participant-curve','contact-version','wrapped','nested-wrapped'].includes(fault)) {
    let name = f.name
    if (fault === 'physical-participant') name = CONTACT_PREFIX + f.boxP
    if (fault === 'participant-curve') {name = CONTACT_PREFIX + 'f'.repeat(64);value.p='f'.repeat(64);records.set(f.name,JSON.stringify(value))}
    if (fault === 'contact-version') name = name.replace('.v1.','.v2.')
    if (fault === 'wrapped' || fault === 'nested-wrapped') name = 'kithmoot.account.'+f.observer+'.'+name
    if (fault === 'nested-wrapped') name = 'kithmoot.account.'+f.observer+'.'+name
    records.set(name,records.get(f.name)!);records.delete(f.name)
  }
  if (fault.startsWith('scalar-')) records.set(RENDEZVOUS_KEY,fault === 'scalar-zero' ? '0'.repeat(64) : fault === 'scalar-overflow' ? 'f'.repeat(64) : fault === 'scalar-case' ? 'A'.repeat(64) : '')
  if (fault === 'rendezvous-version') {records.set('kithmoot.rendezvous.v2',records.get(RENDEZVOUS_KEY)!);records.delete(RENDEZVOUS_KEY)}
  if (fault.startsWith('verified-')) {
    const observation = JSON.parse(records.get(f.verifiedName)!)
    if (fault === 'verified-physical') observation.participant = f.boxP
    if (fault === 'verified-extra') observation.extra = true
    if (fault === 'verified-name') observation.name = 'Ada\u202e'
    if (fault === 'verified-time') observation.verifiedAt = 1.5
    records.set(f.verifiedName,JSON.stringify(observation))
    if (fault === 'verified-wrapped') {records.set('kithmoot.account.'+f.observer+'.'+f.verifiedName,records.get(f.verifiedName)!);records.delete(f.verifiedName)}
  }
  if (fault.startsWith('observer-')) {
    let name = f.observerName
    if (fault === 'observer-version') name = name.replace('.v2.','.v3.')
    if (fault === 'observer-key') name = name.replace(f.observer,'bad')
    if (fault === 'observer-nested') name = 'kithmoot.checks.v2.'+f.observer+'.'+name
    if (fault === 'observer-wrapped') name = 'kithmoot.account.'+f.observer+'.'+name
    records.set(name,records.get(f.observerName)!);records.delete(f.observerName)
  }
}
