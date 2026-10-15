import { getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { ackEventTemplate, buildPairingAckV2, buildProjection, createSignetContactsClient, pairingCode, formatPairingCode,
  projectionEventTemplate, projectionTag, proposalTag, sealVaultPayload, normaliseCapabilities,
  type Capability, type ContactProjectionV2, type ContactsSigner, type PairingV2, type SignedNostrEvent } from '@forgesworn/signet-contacts'
import { GrantedContactsClient, BASIC_CONTACT_SCOPES } from '../app/src/granted-contacts-client.js'
import { memoryDeviceStore } from '../app/src/device-store.js'

export const GRANTED_CONTACT_MODES = ['empty', 'pairing', 'live', 'blocked', 'blocks-only', 'revoked', 'expired', 'orphan', 'narrowed', 'all'] as const
export type GrantedContactMode = typeof GRANTED_CONTACT_MODES[number]
/** Actual KithMoot pairing/refresh writes, with real signed NIP-44 carriers.
 * SDK proposal output is separately kept as an unsupported-producer fault,
 * never valid KithMoot custody. No real human/device approval occurs. */
export async function grantedContactFixture(mode: GrantedContactMode = 'all') {
  const appKey = new Uint8Array(32).fill(1), railKey = new Uint8Array(32).fill(2), ephemeralKey = new Uint8Array(32).fill(9)
  const account = getPublicKey(appKey), rail = getPublicKey(railKey), peer = '4'.repeat(64), grant = '3'.repeat(32), pendingGrant = '7'.repeat(32)
  const prefix = `kithmoot.contacts.v2.${account}.`, store = memoryDeviceStore(), now = 1700000000
  let time = now, event: SignedNostrEvent | null = null, ack: SignedNostrEvent | null = null
  const signer = (secret: Uint8Array): ContactsSigner => ({ pubkey: getPublicKey(secret), signEvent: async template => finalizeEvent(template, secret),
    nip44Encrypt: async (p, text) => { const key = nip44.v2.utils.getConversationKey(secret, p); try { return nip44.v2.encrypt(text, key) } finally { key.fill(0) } },
    nip44Decrypt: async (p, text) => { const key = nip44.v2.utils.getConversationKey(secret, p); try { return nip44.v2.decrypt(text, key) } finally { key.fill(0) } } })
  const extras: Capability[] = ['signet.contacts.read:tier', 'signet.contacts.read:checks', 'signet.contacts.read:check-records']
  const scopes = normaliseCapabilities([...BASIC_CONTACT_SCOPES, ...extras])
  const client = new GrantedContactsClient({ signer: signer(appKey), store, current: () => true, changed: () => {}, now: () => time,
    lock: async task => task(), relay: { fetchNewest: async filter => filter.authors?.includes(rail) ? event : null,
      fetchMany: async filter => filter.kinds?.includes(21237) && ack ? [ack] : [], publish: async () => true } })
  const pair = async (id: string, requestedExtras = extras) => {
    const session = client.beginPairing('wss://relay.example/', requestedExtras)
    const challenge = new URL(session.uri.replace('signet-grant:', 'https:')).searchParams.get('challenge')!
    const payload = buildPairingAckV2({ v: 2, grantId: id, railPubkey: rail, projectionTag: projectionTag(id), proposalTag: proposalTag(id, account),
      relay: 'wss://relay.example/', grantedCapabilities: normaliseCapabilities([...BASIC_CONTACT_SCOPES, ...requestedExtras]), maxStalenessSeconds: 21600, challenge })
    const content = await signer(ephemeralKey).nip44Encrypt(account, payload)
    ack = finalizeEvent(ackEventTemplate(getPublicKey(ephemeralKey), account, time, content), ephemeralKey)
    const code = formatPairingCode(pairingCode({ appPubkey: account, challenge, grantId: id, railPubkey: rail }))
    if (await session.wait(async displayed => displayed === code) !== 'paired') throw new Error('Fixture pairing did not complete')
  }
  const publish = async (offset: number, blocked: boolean, revoked = false) => {
    const projection: ContactProjectionV2 = { v: 2, grantId: grant, scopes: mode === 'blocks-only' ? ['signet.contacts.blocks.read'] : scopes, issuedAt: now + offset, expiresAt: now + 600,
      frontier: { publishedAt: now + offset, maxClock: offset + 101, opCount: 5, deviceId: '5'.repeat(32) },
      contacts: revoked ? [] : mode === 'blocks-only' ? [{ contactId: '6'.repeat(32), identities: [{ pubkey: peer }], blocked: true }] : [{ contactId: '6'.repeat(32), displayName: 'Ada 🧭', identities: [{ pubkey: peer, verification: 'proven' }],
        effectiveTier: 'ken', tierSource: 'direct', blocked, checks: [{ pubkey: peer, method: 'words', checkedAt: now * 1000 }] }],
      ...(revoked ? { revoked: true as const } : {}) }
    const content = await sealVaultPayload(buildProjection(projection), signer(railKey), account)
    if (!content) throw new Error('Fixture projection could not seal')
    event = finalizeEvent(projectionEventTemplate(rail, grant, projection.issuedAt, content), railKey)
    await client.refresh()
  }
  try {
    if (mode !== 'empty') await pair(grant)
    if (!['empty', 'pairing'].includes(mode)) await publish(-10, mode !== 'live')
    if (mode === 'revoked' || mode === 'all') await publish(-100, false, true)
    if (mode === 'expired') { time += 40 * 86400; await client.refresh() }
    if (mode === 'orphan' || mode === 'all') { event = null; await pair('8'.repeat(32)) }
    if (mode === 'narrowed') { event = null; await pair(grant, []) }
    let unsupportedPending = ''
    if (mode === 'all') {
      const pairing: PairingV2 = { grantId: pendingGrant, railPubkey: rail, projectionTag: projectionTag(pendingGrant), proposalTag: proposalTag(pendingGrant, account),
        relay: 'wss://relay.example/', grantedCapabilities: ['signet.contacts.propose:add-ken', 'signet.contacts.propose:rename-app-label'], maxStalenessSeconds: 21600, pairedAt: now }
      const pendingStore = memoryDeviceStore()
      const sdk = createSignetContactsClient({ signer: signer(appKey), now: () => now, nowMs: () => now * 1000,
        relay: { fetchNewest: async () => null, publish: async () => true }, storage: {
          get: async key => pendingStore.get(key), set: async (key, value) => { pendingStore.set(key, value) } } })
      if (!await sdk.propose(pairing, [{ action: 'add-ken', value: { pubkey: peer, displayName: 'Lin 🧭' } },
        { action: 'rename-app-label', value: { contactId: 'a'.repeat(32), label: 'Local label' } }])) throw new Error('Fixture proposal did not publish')
      unsupportedPending = pendingStore.get('signet-contacts:pending:' + pendingGrant)!
    }
    const records = new Map(store.keys().map(key => [key, store.get(key)!]))
    return { records, account, peer, grant, pendingGrant, prefix, unsupportedPending }
  } finally { client.stop(); appKey.fill(0); railKey.fill(0); ephemeralKey.fill(0) }
}

export const GRANTED_CONTACT_FAULTS = ['version', 'account', 'suffix', 'bare', 'wrapped', 'nested-wrapped', 'json', 'whitespace', 'duplicate-json',
  'pairing-extra', 'pairing-time', 'pairing-self-rail', 'pairing-capability', 'pairing-cap-order', 'pairing-staleness', 'pairing-relay', 'pairing-null',
  'pairing-missing-directory', 'pairing-missing-blocks', 'pairing-proposal-scope',
  'state-extra', 'state-grant', 'state-time', 'state-null-projection', 'state-revocation', 'state-block', 'state-duplicate-block', 'state-revoked-contacts',
  'projection-extra', 'projection-grant', 'projection-frontier', 'projection-frontier-extra', 'projection-scope', 'projection-contact-extra',
  'projection-contact-duplicate', 'projection-narrow-consent', 'projection-false-revocation', 'projection-sdk-scope', 'projection-wire-size',
  'pending-shape', 'pending-sdk-proposals', 'pending-legacy-proposals', 'oversize'] as const
export type GrantedContactFault = typeof GRANTED_CONTACT_FAULTS[number]
export function damageGrantedContactFixture(fixture: Awaited<ReturnType<typeof grantedContactFixture>>, records: Map<string, string>, fault: GrantedContactFault) {
  const pairingKey = fixture.prefix + 'pairing', stateKey = fixture.prefix + 'signet-contacts:state:' + fixture.grant,
    pendingKey = fixture.prefix + 'signet-contacts:pending:' + fixture.grant
  const pairing = JSON.parse(records.get(pairingKey)!), state = JSON.parse(records.get(stateKey)!)
  const move = (key: string, next: string) => { const raw = records.get(key)!; records.delete(key); records.set(next, raw) }
  if (fault === 'version') return move(pairingKey, pairingKey.replace('.v2.', '.v3.'))
  if (fault === 'account') return move(pairingKey, pairingKey.replace(fixture.account, 'invalid'))
  if (fault === 'suffix') return move(stateKey, stateKey + '.extra')
  if (fault === 'bare') return move(pairingKey, 'kithmoot.contacts')
  if (fault === 'wrapped') return move(pairingKey, `kithmoot.account.${fixture.account}.${pairingKey}`)
  if (fault === 'nested-wrapped') return move(stateKey, `kithmoot.account.${fixture.account}.kithmoot.account.${fixture.account}.${stateKey}`)
  if (fault === 'json') return records.set(stateKey, '{broken')
  if (fault === 'whitespace') return records.set(stateKey, ' ' + records.get(stateKey)!)
  if (fault === 'duplicate-json') return records.set(stateKey, records.get(stateKey)!.replace('"revoked":true}', '"revoked":false,"revoked":true}'))
  if (fault === 'oversize') return records.set(stateKey, ' '.repeat(2 * 1024 * 1024 + 1))
  if (fault === 'pairing-extra') pairing.private = 'unclassified'
  if (fault === 'pairing-time') pairing.pairedAt = -1
  if (fault === 'pairing-self-rail') pairing.railPubkey = fixture.account
  if (fault === 'pairing-capability') pairing.grantedCapabilities.push('unknown')
  if (fault === 'pairing-cap-order') pairing.grantedCapabilities.reverse()
  if (fault === 'pairing-staleness') pairing.maxStalenessSeconds = 1
  if (fault === 'pairing-relay') pairing.relay = 'https://relay.example/'
  if (fault === 'pairing-null') return records.set(pairingKey, 'null')
  if (fault === 'pairing-missing-directory') pairing.grantedCapabilities = pairing.grantedCapabilities.filter((scope: string) => scope !== 'signet.contacts.read:directory')
  if (fault === 'pairing-missing-blocks') pairing.grantedCapabilities = pairing.grantedCapabilities.filter((scope: string) => scope !== 'signet.contacts.blocks.read')
  if (fault === 'pairing-proposal-scope') pairing.grantedCapabilities.push('signet.contacts.propose:add-ken')
  if (fault.startsWith('pairing-')) return records.set(pairingKey, JSON.stringify(pairing))
  if (fault === 'state-extra') state.private = 'unknown'
  if (fault === 'state-grant') state.grantId = 'f'.repeat(32)
  if (fault === 'state-time') state.receivedAt = -1
  if (fault === 'state-null-projection') state.projection = null
  if (fault === 'state-revocation') state.revoked = false
  if (fault === 'state-block') state.blockedPubkeys = ['invalid']
  if (fault === 'state-duplicate-block') state.blockedPubkeys.push(state.blockedPubkeys[0])
  if (fault === 'state-revoked-contacts') state.projection.contacts.push({ contactId: '6'.repeat(32), identities: [{ pubkey: fixture.peer }], blocked: true })
  if (fault.startsWith('state-')) return records.set(stateKey, JSON.stringify(state))
  if (fault === 'projection-extra') state.projection.ownerPubkey = fixture.account
  if (fault === 'projection-grant') state.projection.grantId = 'f'.repeat(32)
  if (fault === 'projection-frontier') state.projection.frontier.maxClock = -1
  if (fault === 'projection-frontier-extra') state.projection.frontier.operationIds = []
  if (fault === 'projection-scope') state.projection.scopes.push('unknown')
  if (['projection-contact-extra', 'projection-contact-duplicate', 'projection-narrow-consent'].includes(fault)) {
    state.revoked = false; delete state.projection.revoked
    const contact = { contactId: '6'.repeat(32), identities: [{ pubkey: fixture.peer }], blocked: true }
    state.projection.contacts = [contact]
    if (fault === 'projection-contact-extra') Object.assign(contact, { secret: 'unknown' })
    if (fault === 'projection-contact-duplicate') state.projection.contacts.push(contact)
    if (fault === 'projection-narrow-consent') state.projection.scopes = ['signet.contacts.read:directory']
  }
  if (fault === 'projection-false-revocation') state.projection.revoked = false
  if (fault === 'projection-sdk-scope') state.projection.scopes = normaliseCapabilities([...state.projection.scopes, 'signet.contacts.read:roles'])
  if (fault === 'projection-wire-size') {
    state.revoked = false; delete state.projection.revoked; state.blockedPubkeys = []
    state.projection.contacts = Array.from({ length: 2000 }, (_, index) => ({ contactId: (index + 1).toString(16).padStart(32, '0'),
      identities: [{ pubkey: fixture.peer }], blocked: false }))
  }
  if (fault.startsWith('projection-')) return records.set(stateKey, JSON.stringify(state))
  if (fault === 'pending-shape') return records.set(pendingKey, '{}')
  if (fault === 'pending-sdk-proposals') return records.set(fixture.prefix + 'signet-contacts:pending:' + fixture.pendingGrant, fixture.unsupportedPending)
  if (fault === 'pending-legacy-proposals') {
    const rows = JSON.parse(fixture.unsupportedPending)
    for (const row of rows) delete row.grantId
    return records.set(fixture.prefix + 'signet-contacts:pending:' + fixture.pendingGrant, JSON.stringify(rows))
  }
}
