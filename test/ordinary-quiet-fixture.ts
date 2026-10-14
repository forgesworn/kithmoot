import { getPublicKey, finalizeEvent, type Event } from 'nostr-tools/pure'
import { deriveRoom } from '../src/room.js'
import { deriveEpoch } from '../src/epoch.js'
import { createDeviceCredential } from '../src/credential.js'
import { localIdentity } from '../src/identity.js'
import { encodeChatEvent, decodeChatEvent } from '../src/chat.js'
import { quietRoomTransport } from '../src/quiet.js'
import { memoryDeviceStore } from '../app/src/device-store.js'
import { storeQuietState, QUIET_PREFIX } from '../app/src/quiet-store.js'
import type { OrdinaryQuietChecks } from '../app/src/ordinary-quiet-snapshot.js'

export type QuietFixtureMode = 'queued' | 'counters' | 'queue-only' | 'legacy' | 'epoch' | 'named' | 'expired'
export const QUIET_FIXTURE_NOW = 1_800_000_000
/** Actual quiet transport, signed/encrypted chat and storage writer. No live
 * relay or signer. Binding checks use real decryption/credential verification;
 * production must obtain these keys/ownership from its validated whole image. */
export async function quietFixture(mode: QuietFixtureMode = 'queued', seed = 5) {
  const secret = new Uint8Array(32).fill(seed), participantKey = new Uint8Array(32), deviceKey = new Uint8Array(32)
  participantKey[31] = 4; deviceKey[31] = seed + 10
  const participant = getPublicKey(participantKey), device = getPublicKey(deviceKey), { roomId, roomKey } = deriveRoom(secret)
  const epoch = mode === 'epoch' ? 3 : 0, epochRoot = epoch ? deriveEpoch({ epoch, secret: new Uint8Array(32).fill(seed + 30) }) : undefined
  const channel = mode === 'named' ? 'tasks' : undefined, published: Event[] = []
  const credential = await createDeviceCredential({ identity: localIdentity(participantKey), devicePubkey: device, roomId,
    expiresAt: QUIET_FIXTURE_NOW + 3600, now: () => QUIET_FIXTURE_NOW })
  const message = (id: string, text: string) => encodeChatEvent({ id, text, participant, device, credential, sentAt: QUIET_FIXTURE_NOW },
    { roomId, roomKey, deviceSk: deviceKey, ...(epochRoot ? { epoch: epochRoot } : {}), ...(channel ? { channel } : {}),
      ...(mode === 'expired' ? { expiresAt: QUIET_FIXTURE_NOW + 900 } : {}) })
  const quiet = quietRoomTransport({ publish: async event => { published.push(event) }, subscribe: () => () => {}, close: () => {} },
    { policy: { tier: 'open', quiet: true, members: [participant] }, participant, slot: 0, now: () => QUIET_FIXTURE_NOW,
      schedule: () => () => {}, slotOffset: () => 0, reservedCounters: () => [0, 1, 2, 3, 4, 5, 6] })
  quiet.rekey(epochRoot?.key ?? roomKey)
  try {
    const sent = quiet.publish(message('spent', 'Already posted'))
    await quiet.tick(); await sent
    if (mode !== 'counters') {
      void quiet.publish(message('waiting', 'Keep this queued')).catch(() => {})
      await Promise.resolve()
    }
    const store = memoryDeviceStore()
    storeQuietState(store, roomId, { ...(mode !== 'queue-only' ? { used: quiet.exportUsed() } : {}),
      ...(mode !== 'legacy' ? { epoch } : {}), queued: quiet.queued() }, QUIET_FIXTURE_NOW)
    const name = QUIET_PREFIX + roomId, records = new Map(store.keys().map(name => [name, store.get(name)!]))
    const checks: OrdinaryQuietChecks = {
      kind: 'browser',
      acceptsCounters: (pubkey, scope) => pubkey === participant && scope.roomId === roomId &&
        (scope.account === undefined || scope.account === participant) && (scope.epoch ?? 0) === epoch,
      acceptsQueued: (event, scope) => {
        if (scope.roomId !== roomId || scope.account !== undefined && scope.account !== participant || (scope.epoch ?? 0) !== epoch) return false
        const retainedSecret = new Uint8Array(32).fill(seed), retained = deriveRoom(retainedSecret)
        const epochSecret = epoch ? new Uint8Array(32).fill(seed + 30) : undefined
        const retainedEpoch = epochSecret ? deriveEpoch({ epoch, secret: epochSecret }) : undefined
        try {
          const plain = decodeChatEvent(event, { roomId, roomKey: retained.roomKey, now: event.created_at,
            ...(retainedEpoch ? { epoch: retainedEpoch } : {}), ...(channel ? { channel } : {}) })
          return plain !== null && plain.participant === participant && plain.device === device && plain.sentAt === event.created_at
        } finally { retainedSecret.fill(0); retained.roomKey.fill(0); epochSecret?.fill(0); retainedEpoch?.key.fill(0) }
      },
    }
    return { records, name, roomId, participant, device, epoch, checks, published,
      sign: (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, deviceKey) }
  } finally { quiet.close(); secret.fill(0); roomKey.fill(0); epochRoot?.key.fill(0) }
}
