import { finalizeEvent, getPublicKey, type EventTemplate } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { ProjectDirectory } from '../src/project-directory.js'
import { RoomAgent } from '../src/agent.js'
import { ContextVault } from '../packages/context/src/index.js'
import { SimRelay, SimTransport } from './sim-relay.js'
import { largeContextJournal } from './ordinary-capacity-fixture.js'
import { LEGACY_CONTEXT_CACHES } from './ordinary-journal-legacy-vectors.js'

export const JOURNAL_MODES = ['project-pending', 'project-delivered', 'assignment-pending', 'assignment-overlap',
  'assignment-delivered', 'context-empty', 'context-one', 'context-large', 'context-fswn1', 'context-wblm1', 'all'] as const
export type JournalMode = typeof JOURNAL_MODES[number]
/** Deliberate synthetic signer extension, permitted by current Context event
 * validation: fill an opaque unsigned snapshot field to the exact signed-event
 * ceiling. Actual create/save then exposes the writer/restore size mismatch.
 * This is not typical app content or real external-signer acceptance. */
export async function upperContextJournal() {
  const secret = new Uint8Array(32).fill(7), account = getPublicKey(secret)
  let snapshotBytes = 0
  const identity = { pubkey: account, async signEvent(template: EventTemplate) {
    const signed = finalizeEvent(template, secret)
    if (template.tags[0]?.[1] !== 'kithmoot/context/v1/snapshot') return signed
    const extended = { ...signed, producerFixturePadding: '' }
    extended.producerFixturePadding = 'x'.repeat(1024 * 1024 - new TextEncoder().encode(JSON.stringify(extended)).length)
    snapshotBytes = new TextEncoder().encode(JSON.stringify(extended)).length
    if (snapshotBytes !== 1024 * 1024) throw new Error('Exact snapshot ceiling missing')
    return extended
  }, async encrypt(peer: string, text: string) {
    const key = nip44.v2.utils.getConversationKey(secret, peer)
    try { return nip44.v2.encrypt(text, key) } finally { key.fill(0) }
  }, async decrypt(peer: string, text: string) {
    const key = nip44.v2.utils.getConversationKey(secret, peer)
    try { return nip44.v2.decrypt(text, key) } finally { key.fill(0) }
  } }
  try {
    const vault = new ContextVault({ identity, now: () => 1700000000, fetch: async () => { throw new Error('No network') } })
    await vault.create({ title: 'Exact writer ceiling', scope: 'personal' })
    const raw = await vault.save()
    let restoreRefused = false
    try { await new ContextVault({ identity }).restore(raw) }
    catch (error) { if (!(error instanceof Error) || error.message !== 'Invalid encrypted context pointer.') throw error; restoreRefused = true }
    return { account, room: '0'.repeat(64), raw, snapshotBytes, restoreRefused, records: new Map([[`kithmoot.context.v1.${account}`, raw]]) }
  } finally { secret.fill(0) }
}
/** Actual direct SDK writers with synthetic identity and in-process relay.
 * These are not app controls, a human signer, live authority or a quota test. */
export async function journalFixture(mode: JournalMode = 'all') {
  if (mode === 'context-large') return { ...(await largeContextJournal()), room: '0'.repeat(64) }
  if (mode === 'context-fswn1' || mode === 'context-wblm1') {
    const raw = LEGACY_CONTEXT_CACHES[mode === 'context-fswn1' ? 0 : 1]!, account = JSON.parse(raw).identity as string
    return { account, room: '0'.repeat(64), records: new Map([[`kithmoot.context.v1.${account}`, raw]]) }
  }
  const secret = new Uint8Array(32).fill(7), account = getPublicKey(secret), records = new Map<string, string>()
  const identity = { pubkey: account, async signEvent(template: EventTemplate) { return finalizeEvent(template, secret) },
    async encrypt(peer: string, text: string) {
      const key = nip44.v2.utils.getConversationKey(secret, peer)
      try { return nip44.v2.encrypt(text, key) } finally { key.fill(0) }
    }, async decrypt() { throw new Error('Journal custody fixture must not decrypt') } }
  const relay = new SimRelay({ replay: true }), transport = new SimTransport(relay)
  let directory: ProjectDirectory | undefined, creator: RoomAgent | undefined, room = '0'.repeat(64)
  try {
    if (mode.startsWith('project-') || mode === 'all') {
      const cuts: string[] = []
      directory = new ProjectDirectory({ identity, transport, now: () => 1700000000,
        storage: { load: async () => undefined, save: async raw => { cuts.push(raw) } } })
      await directory.open()
      await directory.create({ name: 'Private journal fixture', archived: false, authorityRevision: 1, rooms: [],
        members: [{ pubkey: account, kind: 'person', epoch: 1 }] }, 'journal_project_fixture_01')
      for (let i = 0; i < 100 && directory.snapshot().pendingSends; i++) await new Promise(resolve => setTimeout(resolve, 10))
      if (directory.snapshot().pendingSends || cuts.length !== 2) throw new Error('Actual project writer cuts missing')
      records.set(`kithmoot.shared-projects.v1.${account}`, cuts[mode === 'project-pending' ? 0 : 1]!)
    }
    if (mode.startsWith('assignment-') || mode === 'all') {
      let fail = false
      const cuts: string[] = []
      creator = await RoomAgent.create({ base: 'https://ordinary-journal.kithmoot.test/j/', name: 'Synthetic writer', agent: false,
        identity, announceJitterMs: 0, transport: () => {
          const t = new SimTransport(relay), publish = t.publish.bind(t)
          t.publish = async event => { if (fail && event.kind === 1460) throw new Error('Synthetic lost send'); await publish(event) }
          return t
        } })
      room = creator.session.roomId
      const log = await creator.session.assignments({ load: async () => undefined, save: async raw => { cuts.push(raw) } })
      fail = true
      try { await log.submit(undefined, { op: 'create', objective: 'Private journal', criteria: 'Keep exact bytes', owner: account }, 'journal_assignment_fixture_01') }
      catch (error) { if (!(error instanceof Error) || error.message !== 'Synthetic lost send') throw error }
      fail = false; await log.retry()
      if (cuts.length !== 3) throw new Error('Actual assignment pending/overlap/ack cuts missing')
      records.set(`kithmoot.assignments.v1.${account}.${room}`, cuts[mode === 'assignment-pending' ? 0 : mode === 'assignment-overlap' ? 1 : 2]!)
    }
    if (mode.startsWith('context-') || mode === 'all') {
      const vault = new ContextVault({ identity, now: () => 1700000000, fetch: async () => { throw new Error('No network') } })
      if (mode !== 'context-empty') await vault.create({ title: 'Private writer fixture', scope: 'personal' })
      records.set(`kithmoot.context.v1.${account}`, await vault.save())
    }
    return { account, room, records }
  } finally { await directory?.close(); await creator?.leave(); transport.close(); relay.close(); secret.fill(0) }
}

export const JOURNAL_FAULTS = ['unknown-version', 'wrapped', 'tab-family', 'noncanonical', 'duplicate-field', 'extra-field',
  'project-identity', 'project-key-length', 'project-key-version', 'project-key-base64', 'project-legacy-envelope',
  'envelope-chunk', 'envelope-count', 'envelope-bucket', 'envelope-base64', 'assignment-empty', 'assignment-events-cap',
  'assignment-outbox-cap', 'assignment-value-type', 'assignment-length', 'assignment-version', 'context-identity',
  'context-collections-cap', 'context-access-extra', 'context-signature', 'context-domain', 'context-signer',
  'context-recipient', 'context-content-extra', 'context-event-bytes', 'context-envelope-cap'] as const
export type JournalFault = typeof JOURNAL_FAULTS[number]
export function damageJournalFixture(fixture: { account: string; room: string }, records: Map<string, string>, fault: JournalFault): void {
  const project = `kithmoot.shared-projects.v1.${fixture.account}`, assignment = `kithmoot.assignments.v1.${fixture.account}.${fixture.room}`,
    context = `kithmoot.context.v1.${fixture.account}`
  const key = fault.startsWith('assignment-') ? assignment : fault.startsWith('context-') ? context : project
  const raw = records.get(key)!, value = JSON.parse(raw)
  if (fault === 'wrapped') { records.delete(key); records.set(`kithmoot.account.${fixture.account}.${key}`, raw); return }
  if (fault === 'tab-family') { records.delete(key); records.set('kithmoot.context', raw); return }
  if (fault === 'noncanonical') { records.set(key, raw + ' '); return }
  if (fault === 'duplicate-field') { records.set(key, raw.replace('{', '{"v":1,')); return }
  if (fault === 'unknown-version') value.v = 2
  if (fault === 'extra-field') value.repaired = false
  if (fault === 'project-identity' || fault === 'context-identity') value.identity = 'f'.repeat(64)
  if (fault === 'project-key-length') value.key = nip44.v2.encrypt('short', new Uint8Array(32))
  if (fault === 'project-key-version') value.key = 'B' + value.key.slice(1)
  if (fault === 'project-key-base64') value.key = value.key.slice(0, -2) + 'B='
  if (fault === 'project-legacy-envelope') value.body = LEGACY_CONTEXT_CACHES.map(raw => JSON.parse(raw))[0].collections[0].envelope
  if (fault.startsWith('envelope-')) {
    const bytes = Uint8Array.from(atob(value.body), c => c.charCodeAt(0)), view = new DataView(bytes.buffer)
    if (fault === 'envelope-chunk') view.setUint32(8, 65536, false)
    if (fault === 'envelope-count') view.setUint32(12, 2, false)
    let body = bytes
    if (fault === 'envelope-bucket') body = bytes.subarray(0, bytes.length - 1)
    // Encode in bounded chunks; String.fromCharCode's argument cap is not
    // an envelope limit, and arbitrary chunks must not introduce padding.
    let binary = ''; for (let i = 0; i < body.length; i += 16384) binary += String.fromCharCode(...body.subarray(i, i + 16384))
    value.body = btoa(binary)
    if (fault === 'envelope-base64') value.body = value.body.slice(0, -1) + '!'
    bytes.fill(0)
  }
  if (fault === 'assignment-empty') { value.events = []; value.outbox = [] }
  if (fault === 'assignment-events-cap') value.events = Array(20001).fill(nip44.v2.encrypt('a', new Uint8Array(32)))
  if (fault === 'assignment-outbox-cap') value.outbox = Array(101).fill(value.events[0])
  if (fault === 'assignment-value-type') value.events[0] = 1
  if (fault === 'assignment-length') value.events[0] = value.events[0].slice(0, -4)
  if (fault === 'assignment-version') value.events[0] = 'B' + value.events[0].slice(1)
  if (fault === 'context-collections-cap') value.collections = Array(33).fill(value.collections[0])
  const access = value.collections?.[0]?.access
  if (fault === 'context-access-extra') access.authority = true
  if (fault === 'context-signature') access.sig = '0'.repeat(128)
  if (fault === 'context-domain') access.tags[0][1] = 'kithmoot/context/v1/access'
  if (fault === 'context-signer') access.pubkey = 'f'.repeat(64)
  if (['context-recipient', 'context-content-extra'].includes(fault)) {
    const content = JSON.parse(access.content)
    if (fault === 'context-recipient') content.recipient = 'f'.repeat(64)
    else content.verified = true
    access.content = JSON.stringify(content)
  }
  if (fault === 'context-event-bytes') access.content = 'x'.repeat(1024 * 1024)
  if (fault === 'context-envelope-cap') value.collections[0].envelope = 'A'.repeat(4 * Math.ceil((2 * 1024 * 1024 + 89) / 3))
  records.set(key, JSON.stringify(value))
}
