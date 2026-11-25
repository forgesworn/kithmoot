import { describe, it, expect, afterEach } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { RoomSession, NostrRelayPool, generateRoomSecret } from '../src/index.js'
import { createFakeFactory } from './fake-rtc.js'
import { localIdentity } from '../src/identity.js'

const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']

const pools: NostrRelayPool[] = []
function pool() {
  const p = new NostrRelayPool(RELAYS)
  pools.push(p)
  return p
}
afterEach(() => {
  for (const p of pools.splice(0)) p.close()
})

async function settle(ms = 4000) {
  await new Promise((r) => setTimeout(r, ms))
}

describe('live relays', () => {
  it('carries a board too large for one event from one session to another, over public relays', async () => {
    // The largest thing a room publishes: a full board part is an event of
    // about 45 KB. This is whether real relays take it, which no local
    // relay can say. The room ends in fifteen minutes, so every event here
    // carries that expiry and the relays drop them.
    const Y = await import('yjs')
    const { memoryRoomBoardStorage } = await import('../src/room-board-wire.js')
    const secret = generateRoomSecret()
    const endsAt = Math.floor(Date.now() / 1000) + 900
    const writer = new RoomSession({ transport: pool(), secret, endsAt, identity: localIdentity(generateSecretKey()), deviceSk: generateSecretKey() })
    await writer.join([], {})
    const board = await writer.board(memoryRoomBoardStorage())
    const titles = Array.from({ length: 6 }, (_, i) => `${i}:${Array.from({ length: 10_000 }, (_, j) => ((i * 31 + j * 7) % 36).toString(36)).join('')}`)
    board.doc.transact(() => {
      for (const [i, title] of titles.entries()) {
        const card = new Y.Map<unknown>()
        card.set('title', title); card.set('status', 'todo')
        board.doc.getMap('records').set(`card-${i}`, card)
      }
    })
    const until = async (done: () => boolean, ms: number) => {
      const end = Date.now() + ms
      while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 250))
    }
    await until(() => board.status().ready && !board.status().pending, 45_000)
    expect(board.status(), 'the relays did not take the board').toEqual({ ready: true, pending: false })
    expect(board.state().byteLength, 'the board should need more than two parts').toBeGreaterThan(2 * 22 * 1024)

    const reader = new RoomSession({ transport: pool(), secret, endsAt, identity: localIdentity(generateSecretKey()), deviceSk: generateSecretKey() })
    await reader.join([], {})
    const copy = await reader.board(memoryRoomBoardStorage())
    const read = () => [...copy.doc.getMap('records').values()].map((card) => (card as InstanceType<typeof Y.Map>).get('title') as string).sort()
    await until(() => read().length === titles.length, 45_000)
    expect(read(), 'the second session did not read the whole board back').toEqual([...titles].sort())
    await writer.leave()
    await reader.leave()
  }, 120_000)


  it('carries two devices of one participant into one view', async () => {
    const secret = generateRoomSecret()
    const participantSk = generateSecretKey()
    const phoneSk = generateSecretKey()
    const laptopSk = generateSecretKey()

    // The observer joins LAST. A real relay does not store an ephemeral
    // kind, so this is the direction that only works because devices
    // already present answer a new arrival - and the one direction the
    // suite never used to exercise anywhere.
    const phoneFactory = createFakeFactory()
    const phone = new RoomSession({
      transport: pool(),
      secret,
      identity: localIdentity(participantSk),
      deviceSk: phoneSk,
      factory: phoneFactory,
    })
    const laptop = new RoomSession({ transport: pool(), secret, identity: localIdentity(participantSk), deviceSk: laptopSk })
    await phone.join([{ trackId: 'cam', role: 'camera' }], { mic: Math.floor(Date.now() / 1000) })
    await laptop.join([{ trackId: 'scr', role: 'screen' }], {})
    await settle(2000)

    const observer = new RoomSession({
      transport: pool(),
      secret,
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
    })
    await observer.join([], {})

    await settle()

    const view = observer.participants().find((v) => v.participant === getPublicKey(participantSk))
    expect(view, 'participant did not appear via public relays').toBeDefined()
    expect(view!.devices).toHaveLength(2)
    expect(view!.tracks.map((t) => t.role).sort()).toEqual(['camera', 'screen'])
    expect(view!.mic).toBe(getPublicKey(phoneSk))

    // The phone connects both the observer and its own laptop camera.
    expect(phoneFactory.instances).toHaveLength(2)
  })

  it('does not leak the participant pubkey to relays', async () => {
    // A second observer with the WRONG secret must see nothing, proving the
    // room key - not obscurity - is what gates the roster.
    const secret = generateRoomSecret()
    const participantSk = generateSecretKey()

    const outsider = new RoomSession({
      transport: pool(),
      secret: generateRoomSecret(),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
    })
    await outsider.join([], {})

    const member = new RoomSession({
      transport: pool(),
      secret,
      identity: localIdentity(participantSk),
      deviceSk: generateSecretKey(),
    })
    await member.join([], {})
    await settle()

    const leaked = outsider.participants().some((v) => v.participant === getPublicKey(participantSk))
    expect(leaked, 'an outsider could read the roster').toBe(false)
  })
})
