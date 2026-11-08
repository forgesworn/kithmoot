import { expect, it } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { RoomSession } from './session.js'
import { localIdentity } from './identity.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { createFakeFactory } from '../test/fake-rtc.js'

it('requires each concurrent app and each tab even when they belong to the same person', async () => {
  const secret = generateSecretKey(), identity = localIdentity(generateSecretKey()), transport = new SimTransport(new SimRelay())
  const keys = [generateSecretKey(), generateSecretKey(), generateSecretKey()]
  const sessions = keys.map((deviceSk, index) => new RoomSession({ secret, identity, deviceSk, transport,
    factory: createFakeFactory(), sid: ['desktop-session', 'android-session', 'browser-session'][index],
    epochSettleMs: 0, callBell: false }))
  try {
    for (const session of sessions) await session.join([], {})
    // Fresh presence is restated explicitly so an earlier join has the same
    // complete view as the last join; no physical-device claim is made.
    for (const session of sessions) await session.announce()
    const roster = sessions[0]!.nodeMigrationRoster()
    expect(roster).toHaveLength(3)
    expect(new Set(roster.map(row => row.participant)).size).toBe(1)
    const tab = new RoomSession({ secret, identity, deviceSk: keys[2]!, transport, factory: createFakeFactory(),
      sid: 'second-web-tab', epochSettleMs: 0, callBell: false })
    sessions.push(tab); await tab.join([], {})
    for (const session of sessions) await session.announce()
    const expanded = sessions[0]!.nodeMigrationRoster()
    expect(expanded).toHaveLength(4)
    expect(new Set(expanded.map(row => row.device)).size).toBe(3)
    const devices = sessions[0]!.nodeMigrationDevices()
    expect(devices).toHaveLength(3)
    expect(new Set(devices.map(row => row.participant)).size).toBe(1)
  } finally { await Promise.all(sessions.map(session => session.leave())) }
})
