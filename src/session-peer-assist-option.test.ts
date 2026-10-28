import { describe, it, expect, vi } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { createFakeFactory } from '../test/fake-rtc.js'
import { localIdentity } from './identity.js'

/**
 * `peerAssist: false` must reach the mesh as `assist`, so a failing pair goes
 * on to a forwarder or TURN instead of waiting on a volunteer. The mesh's own
 * behaviour with `assist` off is covered in mesh-assist.test.ts; this checks
 * only that the session passes the choice through.
 */
const seen = vi.hoisted(() => ({ options: [] as Array<{ assist?: () => boolean }> }))

vi.mock('./mesh.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mesh.js')>()
  class RecordingMesh extends actual.Mesh {
    constructor(options: ConstructorParameters<typeof actual.Mesh>[0]) {
      seen.options.push(options as { assist?: () => boolean })
      super(options)
    }
  }
  return { ...actual, Mesh: RecordingMesh }
})

const { RoomSession } = await import('./session.js')

async function meshAssist(peerAssist: boolean | undefined): Promise<boolean | undefined> {
  seen.options.length = 0
  const s = new RoomSession({
    transport: new SimTransport(new SimRelay()),
    secret: new Uint8Array(32).fill(12),
    identity: localIdentity(generateSecretKey()),
    deviceSk: generateSecretKey(),
    now: () => 1_800_000_000,
    announceJitterMs: 0,
    factory: createFakeFactory(),
    ...(peerAssist === undefined ? {} : { peerAssist }),
  })
  await s.join([], {})
  const assist = seen.options.at(-1)?.assist
  s.leave()
  expect(seen.options.length).toBeGreaterThan(0)
  return assist?.()
}

describe('the peerAssist session option', () => {
  it('turns volunteer routing off in the mesh when false', async () => {
    expect(await meshAssist(false)).toBe(false)
  })

  it('leaves volunteer routing on by default', async () => {
    expect(await meshAssist(undefined)).toBe(true)
  })
})
