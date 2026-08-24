import { describe, it, expect, afterEach } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { RoomSession, NostrRelayPool, generateRoomSecret } from '../src/index.js'

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
  it('carries two devices of one participant into one view', async () => {
    const secret = generateRoomSecret()
    const participantSk = generateSecretKey()
    const phoneSk = generateSecretKey()
    const laptopSk = generateSecretKey()

    const observer = new RoomSession({
      transport: pool(),
      secret,
      participantSk: generateSecretKey(),
      deviceSk: generateSecretKey(),
    })
    await observer.join([], {})
    await settle(2000)

    const phone = new RoomSession({ transport: pool(), secret, participantSk, deviceSk: phoneSk })
    const laptop = new RoomSession({ transport: pool(), secret, participantSk, deviceSk: laptopSk })
    await phone.join([{ trackId: 'cam', role: 'camera' }], { mic: Math.floor(Date.now() / 1000) })
    await laptop.join([{ trackId: 'scr', role: 'screen' }], {})

    await settle()

    const view = observer.participants().find((v) => v.participant === getPublicKey(participantSk))
    expect(view, 'participant did not appear via public relays').toBeDefined()
    expect(view!.devices).toHaveLength(2)
    expect(view!.tracks.map((t) => t.role).sort()).toEqual(['camera', 'screen'])
    expect(view!.mic).toBe(getPublicKey(phoneSk))
  })

  it('does not leak the participant pubkey to relays', async () => {
    // A second observer with the WRONG secret must see nothing, proving the
    // room key - not obscurity - is what gates the roster.
    const secret = generateRoomSecret()
    const participantSk = generateSecretKey()

    const outsider = new RoomSession({
      transport: pool(),
      secret: generateRoomSecret(),
      participantSk: generateSecretKey(),
      deviceSk: generateSecretKey(),
    })
    await outsider.join([], {})

    const member = new RoomSession({
      transport: pool(),
      secret,
      participantSk,
      deviceSk: generateSecretKey(),
    })
    await member.join([], {})
    await settle()

    const leaked = outsider.participants().some((v) => v.participant === getPublicKey(participantSk))
    expect(leaked, 'an outsider could read the roster').toBe(false)
  })
})
