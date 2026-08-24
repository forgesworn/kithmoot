import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { RoomSession } from './session.js'

const NOW = 1_800_000_000
const now = () => NOW

function secret() {
  return new Uint8Array(32).fill(11)
}

describe('RoomSession', () => {
  it('groups two devices of one participant into a single view', async () => {
    const relay = new SimRelay()
    const participantSk = generateSecretKey()
    const participant = getPublicKey(participantSk)

    const phoneSk = generateSecretKey()
    const laptopSk = generateSecretKey()

    const phone = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      participantSk,
      deviceSk: phoneSk,
      now,
    })
    const laptop = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      participantSk,
      deviceSk: laptopSk,
      now,
    })
    const observer = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      participantSk: generateSecretKey(),
      deviceSk: generateSecretKey(),
      now,
    })

    await observer.join([], {})
    await phone.join([{ trackId: 'cam', role: 'camera' }, { trackId: 'mic', role: 'mic' }], { mic: NOW })
    await laptop.join([{ trackId: 'scr', role: 'screen' }], {})

    const views = observer.participants()
    const mine = views.find((v) => v.participant === participant)

    expect(mine).toBeDefined()
    expect(mine!.devices.sort()).toEqual([getPublicKey(phoneSk), getPublicKey(laptopSk)].sort())
    expect(mine!.tracks.map((t) => t.role).sort()).toEqual(['camera', 'mic', 'screen'])
  })

  it('reports two participants as two views, not four devices', async () => {
    const relay = new SimRelay()
    const alice = generateSecretKey()
    const bob = generateSecretKey()

    const sessions = [
      new RoomSession({ transport: new SimTransport(relay), secret: secret(), participantSk: alice, deviceSk: generateSecretKey(), now }),
      new RoomSession({ transport: new SimTransport(relay), secret: secret(), participantSk: alice, deviceSk: generateSecretKey(), now }),
      new RoomSession({ transport: new SimTransport(relay), secret: secret(), participantSk: bob, deviceSk: generateSecretKey(), now }),
      new RoomSession({ transport: new SimTransport(relay), secret: secret(), participantSk: bob, deviceSk: generateSecretKey(), now }),
    ]
    const observerSk = generateSecretKey()
    const observerParticipant = getPublicKey(observerSk)
    const observer = new RoomSession({ transport: new SimTransport(relay), secret: secret(), participantSk: observerSk, deviceSk: generateSecretKey(), now })
    await observer.join([], {})
    for (const s of sessions) await s.join([], {})

    // Capture the observer's own pubkey before asserting, and filter against
    // that - not a freshly generated key, which would never match anything
    // and let this assertion pass no matter what participants() returned.
    const others = observer.participants().filter((v) => v.participant !== observerParticipant)
    expect(others).toHaveLength(2)
    expect(others.filter((v) => v.participant === getPublicKey(alice))).toHaveLength(1)
    expect(others.filter((v) => v.participant === getPublicKey(bob))).toHaveLength(1)
  })

  it('resolves the mic to exactly one device', async () => {
    const relay = new SimRelay()
    const participantSk = generateSecretKey()
    const phoneSk = generateSecretKey()
    const laptopSk = generateSecretKey()

    const phone = new RoomSession({ transport: new SimTransport(relay), secret: secret(), participantSk, deviceSk: phoneSk, now })
    const laptop = new RoomSession({ transport: new SimTransport(relay), secret: secret(), participantSk, deviceSk: laptopSk, now })
    const observer = new RoomSession({ transport: new SimTransport(relay), secret: secret(), participantSk: generateSecretKey(), deviceSk: generateSecretKey(), now })

    await observer.join([], {})
    await phone.join([], { mic: NOW })
    await laptop.join([], { mic: NOW + 10 })

    const view = observer.participants().find((v) => v.participant === getPublicKey(participantSk))
    expect(view!.mic).toBe(getPublicKey(laptopSk))
  })

  it('ignores roster events from a different room', async () => {
    const relay = new SimRelay()
    const observer = new RoomSession({ transport: new SimTransport(relay), secret: secret(), participantSk: generateSecretKey(), deviceSk: generateSecretKey(), now })
    await observer.join([], {})

    const otherRoom = new RoomSession({
      transport: new SimTransport(relay),
      secret: new Uint8Array(32).fill(99),
      participantSk: generateSecretKey(),
      deviceSk: generateSecretKey(),
      now,
    })
    await otherRoom.join([], {})

    expect(observer.participants()).toHaveLength(1)
  })

  it('notifies subscribers when the roster changes', async () => {
    const relay = new SimRelay()
    const observer = new RoomSession({ transport: new SimTransport(relay), secret: secret(), participantSk: generateSecretKey(), deviceSk: generateSecretKey(), now })
    const counts: number[] = []
    observer.onChange((views) => counts.push(views.length))
    await observer.join([], {})

    const joiner = new RoomSession({ transport: new SimTransport(relay), secret: secret(), participantSk: generateSecretKey(), deviceSk: generateSecretKey(), now })
    await joiner.join([], {})

    expect(counts.at(-1)).toBe(2)
  })
})
