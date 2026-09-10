import { expect, it } from 'vitest'
import evidence from '../vectors/bothy-daemon-discovery.json'
import { readBoxStatus, type BoxPin } from './box-status.js'

it('reads actual Bothy daemon/runtime relay events across persisted-state restarts', () => {
  expect(evidence.cases).toHaveLength(4)
  let pin: BoxPin = evidence.cases[0]!.pin
  for (const c of evidence.cases) {
    const result = readBoxStatus(c.status, c.claim, pin, c.now)
    expect(result.ok, `${c.name}: ${JSON.stringify(result)}`).toBe(c.expect.ok)
    if (!result.ok) {
      // bothyd's local ws development transport is intentionally rejected by
      // the production card policy. The pinned wss runtime cases must pass.
      expect(result.reason).toBe('Link card: relay hint url')
      continue
    }
    expect({ drops: result.status.drops, dropsUrl: result.status.dropsUrl ?? null, validUntil: result.status.validUntil })
      .toEqual({ drops: false, dropsUrl: null, validUntil: c.expect.validUntil })
    pin = { ...pin, highestSerial: result.status.link.serial, card: result.status.card,
      statusCreatedAt: result.status.createdAt, statusId: result.status.id }
  }
  const before = evidence.cases[2]!, after = evidence.cases[3]!
  expect(readBoxStatus(before.status, before.claim, pin, after.now).ok).toBe(false)
})
