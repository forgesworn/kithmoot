import { getPublicKey, finalizeEvent, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { deriveChannel } from '@forgesworn/fold-kit'
import { deriveRoom } from '../src/room.js'
import { deriveEpoch } from '../src/epoch.js'
import { encodeRoomLink } from '../src/link.js'
import { localIdentity } from '../src/identity.js'
import { createDeviceCredential } from '../src/credential.js'
import { ChatLog, type SendOptions } from '../src/chat.js'
import { AssignmentLog } from '../src/assignment-log.js'
import { ASSIGNMENT_CHANNEL } from '../src/assignments.js'
import { CONTROL_CHANNEL, encodeControl } from '../src/control.js'
import { reactionText } from '../src/reactions.js'
import { quietRoomTransport } from '../src/quiet.js'
import { memoryDeviceStore, deviceKeyFor, storeOwnCredentialFor } from '../app/src/device-store.js'
import { rememberRoom, ROOM_PREFIX } from '../app/src/rooms-store.js'
import { storeKeptRoomEpoch } from '../app/src/room-epoch-store.js'
import { storeQuietState, QUIET_PREFIX } from '../app/src/quiet-store.js'
import { PendingSends } from '../app/src/pending-sends.js'

export const SNAPSHOT_NOW = 1_800_000_000
export type SnapshotFixtureMode = 'ordinary' | 'named' | 'past-zero' | 'past-two' | 'current' | 'v1-ahead' | 'quiet' | 'quiet-epoch' | 'quiet-overlap' | 'quiet-named' | 'quiet-control' | 'quiet-logo' | 'quiet-assignment' | 'quiet-assignment-epoch' | 'quiet-unknown' | 'quiet-assignment-text' | 'expired' | 'reply' | 'edit' | 'reaction' | 'retraction'
/** Test-only complete raw images. Every base row uses the actual writer;
 * mutation helpers prepare adversarial signed ciphertext before the probe.
 * No external key/predicate is handed to the production image consumer. */
export async function snapshotFixture(mode: SnapshotFixtureMode = 'ordinary', options: { rootSeed?: number } = {}) {
  const secret = new Uint8Array(32).fill(options.rootSeed ?? 5), participantKey = new Uint8Array(32), deviceKey = new Uint8Array(32)
  participantKey[31] = 4; deviceKey[31] = 15
  const participant = getPublicKey(participantKey), device = getPublicKey(deviceKey), { roomId, roomKey } = deriveRoom(secret)
  const quietMode = mode.startsWith('quiet'), policy = { tier: 'open' as const, ...(quietMode ? { quiet: true as const, members: [participant] } : {}) }
  const url = encodeRoomLink('https://ordinary-snapshot.kithmoot.test/j/', { secret, relays: ['wss://relay.example'], iceUrls: [], policy })
  const store = memoryDeviceStore(), tab = new Map<string, string>(), published: Event[] = []
  rememberRoom(store, { roomId, link: url, openedAt: SNAPSHOT_NOW, ...(mode === 'expired' ? { endsAt: SNAPSHOT_NOW + 900 } : {}) })
  deviceKeyFor(store, roomId, SNAPSHOT_NOW, () => new Uint8Array(deviceKey))
  const credential = await createDeviceCredential({ identity: localIdentity(participantKey), devicePubkey: device, roomId,
    expiresAt: SNAPSHOT_NOW + 3600, now: () => SNAPSHOT_NOW })
  storeOwnCredentialFor(store, roomId, credential)
  const epochSecret = new Uint8Array(32).fill(43), pastSecret = new Uint8Array(32).fill(42), aheadSecret = new Uint8Array(32).fill(44)
  const hasEpoch = ['past-zero', 'past-two', 'current', 'v1-ahead', 'quiet-epoch', 'quiet-assignment-epoch'].includes(mode)
  if (hasEpoch) storeKeptRoomEpoch(store, roomId, { epoch: { epoch: 3, secret: epochSecret },
    past: [{ epoch: 2, secret: pastSecret, leftAt: SNAPSHOT_NOW - 2 }, { epoch: 0, secret, leftAt: SNAPSHOT_NOW - 1 }], removed: [], members: [participant] }, SNAPSHOT_NOW)
  const epoch = mode === 'past-two' ? deriveEpoch({ epoch: 2, secret: pastSecret }) : ['current', 'quiet-epoch', 'quiet-assignment-epoch'].includes(mode) ? deriveEpoch({ epoch: 3, secret: epochSecret }) :
    mode === 'v1-ahead' ? deriveEpoch({ epoch: 4, secret: aheadSecret }) : undefined
  if (mode === 'v1-ahead') store.set('kithmoot.room-epoch.v1.' + roomId, JSON.stringify({ epoch: 4, id: epoch!.id, key: Array.from(epoch!.key, v => v.toString(16).padStart(2, '0')).join('') }))
  const transport = { publish: async (event: Event) => { published.push(event) }, subscribe: () => () => {}, close: () => {} }
  const channel = ['named', 'quiet-named', 'quiet-unknown'].includes(mode) ? 'tasks' : ['quiet-control', 'quiet-logo'].includes(mode) ? CONTROL_CHANNEL :
    ['quiet-assignment', 'quiet-assignment-epoch', 'quiet-assignment-text'].includes(mode) ? ASSIGNMENT_CHANNEL : undefined
  const log = new ChatLog({ transport, roomId, roomKey, credential, deviceSk: deviceKey, policy, channel, ...(epoch ? { epoch } : {}), now: () => SNAPSHOT_NOW,
    ...(mode === 'expired' ? { expiresAt: SNAPSHOT_NOW + 900 } : {}) })
  const artwork = [{ pack: 'fixture', id: 'wave', kind: 'sticker' as const, sha256: 'a'.repeat(64), label: 'Wave' }]
  const attachments = [{ url: 'https://files.example/cipher', sha256: 'b'.repeat(64), key: 'c'.repeat(64), name: 'Private file' }]
  const reaction = { messageId: 'a'.repeat(32), participant, emoji: '👍', active: true, revision: 1 }
  const sendOpts: SendOptions = mode === 'quiet-control' || mode === 'quiet-assignment' || mode === 'quiet-assignment-epoch' ? {} : mode === 'quiet-logo' ? { roomLogo: null } : mode === 'quiet-overlap' ? { artwork, attachments } : mode === 'reply' ? { replyTo: { id: 'a'.repeat(32), participant } } :
    mode === 'edit' ? { replaces: 'a'.repeat(32), artwork } : mode === 'reaction' ? { reaction } : mode === 'retraction' ? { retracts: 'a'.repeat(32) } : { artwork }
  const prepared = log.prepare(mode === 'reaction' ? reactionText(reaction) : mode === 'retraction' ? 'Retracted a message' : mode === 'quiet-control' ? encodeControl({ op: 'hand', up: true }) :
    mode === 'quiet-logo' ? encodeControl({ op: 'logo', id: 'a'.repeat(32), at: SNAPSHOT_NOW, sha256: null }) : 'Keep this message', sendOpts)
  const pendingName = `kithmoot.account.${participant}.kithmoot.pending.${roomId}`
  const pending = new PendingSends({ connected: () => false, now: () => SNAPSHOT_NOW * 1000, schedule: () => {}, storage: {
    load: async () => ({ durable: store.get(pendingName), transient: tab.get(pendingName) ?? null }),
    retain: async (_room, durable, transient) => {
      if (durable === null) store.remove(pendingName); else store.set(pendingName, durable)
      if (transient === null) tab.delete(pendingName); else tab.set(pendingName, transient)
    },
  } })
  const transient = quietMode || mode === 'named' || mode === 'reaction' || mode === 'retraction'
  await pending.add({ id: prepared.message.id, roomId, channel: channel ?? 'Chat', text: prepared.message.text,
    files: mode === 'quiet-overlap' ? [] : (prepared.message.attachments ?? []).map(a => a.name ?? 'Encrypted file'),
    ...(mode !== 'quiet-overlap' && prepared.message.artwork ? { artwork: prepared.message.artwork } : {}), event: prepared.event,
    durable: !transient, ...(!['quiet-overlap', 'reply', 'edit', 'reaction', 'retraction'].includes(mode) ? { editable: true } : {}) })
  if (quietMode) {
    const quiet = quietRoomTransport(transport, { policy, participant, slot: 0, now: () => SNAPSHOT_NOW, schedule: () => () => {}, slotOffset: () => 0 })
    quiet.rekey(epoch?.key ?? roomKey)
    const independent = ['quiet-control', 'quiet-logo', 'quiet-assignment', 'quiet-assignment-epoch', 'quiet-unknown', 'quiet-assignment-text'].includes(mode)
    if (independent) { store.remove(pendingName); tab.delete(pendingName) }
    if (mode === 'quiet-assignment' || mode === 'quiet-assignment-epoch') {
      const assignments = new AssignmentLog({ roomId, roomKey, deviceSk: deviceKey, identity: localIdentity(participantKey), credential: () => credential, policy,
        now: () => SNAPSHOT_NOW, ...(epoch ? { epoch } : {}), transport: { publish: event => quiet.publish(event), subscribe: (_filters, _event, eose) => { queueMicrotask(() => eose?.()); return () => {} }, close: () => {} },
        storage: { load: async () => undefined, save: async raw => { store.set(`kithmoot.assignments.v1.${participant}.${roomId}`, raw) } } })
      await assignments.open(); await Promise.resolve(); await Promise.resolve()
      void assignments.submit(undefined, { op: 'create', objective: 'Keep assignment custody', criteria: 'Preserve signed intent', owner: participant }, 'fixture_request_1').catch(() => {})
      for (let i = 0; i < 100 && quiet.pending === 0; i++) await Promise.resolve()
      if (quiet.pending !== 1) throw Error('actual assignment producer did not queue')
      assignments.close()
    } else { void quiet.publish(prepared.event).catch(() => {}); await Promise.resolve() }
    storeQuietState(store, roomId, { used: quiet.exportUsed(), epoch: epoch?.epoch ?? 0, queued: quiet.queued() }, SNAPSHOT_NOW)
    quiet.close()
  }
  await pending.close(); log.close()
  const browser = new Map(store.keys().map(name => [name, store.get(name)!]))
  const activeRoot = epoch ?? { id: roomId, key: roomKey }
  const resign = (event: Event, change: (value: Record<string, unknown>) => void, rawText?: (text: string) => string): Event => {
    const root = deriveChannel(activeRoot.id, activeRoot.key, channel)
    try {
      const value = JSON.parse(nip44.v2.decrypt(event.content, root.key)); change(value)
      const plain = JSON.stringify(value)
      return finalizeEvent({ kind: event.kind, created_at: event.created_at, tags: event.tags,
        content: nip44.v2.encrypt(rawText ? rawText(plain) : plain, root.key) }, deviceKey)
    } finally { if (root.key !== activeRoot.key) root.key.fill(0) }
  }
  return { browser, tab, roomId, participant, device, pendingName, roomName: ROOM_PREFIX + roomId, quietName: QUIET_PREFIX + roomId,
    url, event: mode === 'quiet-assignment' || mode === 'quiet-assignment-epoch' ? JSON.parse(browser.get(QUIET_PREFIX + roomId)!).queued[0] as Event : prepared.event, published, resign,
    assignmentName: `kithmoot.assignments.v1.${participant}.${roomId}`,
    mutateAssignmentJournal: (change: (value: { events: Event[]; outbox: { inner: Event; outer: Event }[] }) => void) => {
      const name = `kithmoot.assignments.v1.${participant}.${roomId}`, raw = JSON.parse(browser.get(name)!)
      const value: { events: Event[]; outbox: { inner: Event; outer: Event }[] } = { events: raw.events.map((cipher: string) => JSON.parse(nip44.v2.decrypt(cipher, roomKey))),
        outbox: raw.outbox.map((cipher: string) => JSON.parse(nip44.v2.decrypt(cipher, roomKey))) }
      change(value)
      browser.set(name, JSON.stringify({ v: 1, events: value.events.map(event => nip44.v2.encrypt(JSON.stringify(event), roomKey)),
        outbox: value.outbox.map(pending => nip44.v2.encrypt(JSON.stringify(pending), roomKey)) }))
    },
    rechannel: (event: Event, target: string | undefined) => {
      const from = deriveChannel(activeRoot.id, activeRoot.key, channel), to = deriveChannel(activeRoot.id, activeRoot.key, target)
      try { return finalizeEvent({ kind: event.kind, created_at: event.created_at, tags: event.tags.map(t => t[0] === 'd' ? ['d', to.id] : t),
        content: nip44.v2.encrypt(nip44.v2.decrypt(event.content, from.key), to.key) }, deviceKey) }
      finally { if (from.key !== activeRoot.key) from.key.fill(0); if (to.key !== activeRoot.key) to.key.fill(0) }
    },
    includeMember: (member: string) => {
      const updated = { ...policy, members: [participant, member].sort() }
      const link = encodeRoomLink('https://ordinary-snapshot.kithmoot.test/j/', { secret, relays: ['wss://relay.example'], iceUrls: [], policy: updated })
      rememberRoom(store, { roomId, link, openedAt: SNAPSHOT_NOW })
      browser.set(ROOM_PREFIX + roomId, store.get(ROOM_PREFIX + roomId)!)
    },
    sign: (event: Event) => finalizeEvent({ kind: event.kind, created_at: event.created_at, tags: event.tags, content: event.content }, deviceKey),
    release: () => { secret.fill(0); participantKey.fill(0); deviceKey.fill(0); roomKey.fill(0); epoch?.key.fill(0); epochSecret.fill(0); pastSecret.fill(0); aheadSecret.fill(0) } }
}
