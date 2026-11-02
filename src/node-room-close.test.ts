import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils'
import { signNodeRoom, readNodeRoom, readNodeRetirement } from '@forgesworn/fold-kit/node-room'
import { deriveRoom } from './room.js'
import { decodeRekeyEvent, deriveEpoch } from './epoch.js'
import { localIdentity } from './identity.js'
import { parseGroupEvent } from './group-grants.js'
import { queryNodeCloseOperation, type PairedKithmootNode } from './kithmoot-node.js'
import { pendingNodeRoomClose, prepareNodeRoomClose, submitPendingNodeRoomClose, type PendingNodeRoomClose, type NodeCloseReference } from './node-room-close.js'

const NOW = 1_900_000_000
function fixture(endsAt?: number) {
  const authoritySk = generateSecretKey(), serviceSk = generateSecretKey(), roomSecret = generateSecretKey(), owner = localIdentity(generateSecretKey())
  const node = readNodeRoom(signNodeRoom({ authoritySk, room: deriveRoom(roomSecret).roomId, serviceKey: getPublicKey(serviceSk), origin: 'https://node.example', now: NOW,
    ...(endsAt === undefined ? {} : { endsAt }) }), NOW)!
  const pair: PairedKithmootNode = { v: 1, origin: node.origin, serviceKey: node.serviceKey, owner: owner.pubkey }
  const instruction = prepareNodeRoomClose({ node, authoritySk, roomSecret, current: { epoch: 0, secret: roomSecret }, now: NOW, resetFloor: NOW + 2 })
  const pending = pendingNodeRoomClose(pair, node, instruction, NOW)
  let saved: PendingNodeRoomClose | undefined, reference: NodeCloseReference | undefined, mode = 'pending', failStage = false, mutateStage = false
  const store = {
    stage: vi.fn(async (value: PendingNodeRoomClose) => {
      if (failStage) throw Error('private storage failure')
      saved = structuredClone(value); reference = structuredClone(value.reference)
      if (mutateStage) value.instruction.deadline++
    }),
    forgetRoom: vi.fn(async (value: NodeCloseReference) => { saved = undefined; reference = structuredClone(value) }),
  }
  const receipt = (complete = true) => finalizeEvent({ kind: 27544, created_at: NOW, tags: [['operation', instruction.operation], ['expiration', String(NOW + 30 * 86400)]],
    content: JSON.stringify({ v: 1, operation: instruction.operation, published: true, callsRevoked: true, relayPurged: complete, eventsDeleted: 3, completedAt: NOW }) }, serviceSk)
  const bodies: string[] = []
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body))
    const proof = JSON.parse(atob((init?.headers as Record<string, string>).Authorization!.slice(6))) as Event
    if (String(url).endsWith('/operation')) {
      expect(proof.pubkey).toBe(owner.pubkey); expect(JSON.parse(bodies.at(-1)!)).toEqual({ operation: instruction.operation })
    } else {
      expect(String(url)).toBe(node.origin + '/node/v1/close'); expect(saved).toBeDefined()
      expect(JSON.parse(bodies.at(-1)!)).toEqual({ room: node.room, ...pending.instruction })
    }
    if (mode === 'lost') throw Error('response lost after commit')
    return new Response(JSON.stringify({ operation: instruction.operation, phase: mode === 'pending' ? 'draining' : 'done',
      result: mode === 'pending' ? {} : { receipt: receipt(mode !== 'incomplete') } }), { headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { authoritySk, roomSecret, node, pair, owner, instruction, pending, store, receipt, bodies, options: { fetcher, now: () => NOW },
    saved: () => structuredClone(saved), reference: () => structuredClone(reference), mode: (value: string) => { mode = value },
    failStage: () => { failStage = true }, mutateStage: () => { mutateStage = true } }
}
describe('durable node room closure', () => {
  it('prepares an encrypted retirement and self-destruct rekey without publishing or exposing another epoch secret', () => {
    const f = fixture(), current = deriveEpoch({ epoch: 0, secret: f.roomSecret })
    try {
      expect(readNodeRetirement(f.instruction.events[0], f.node, f.roomSecret, NOW)).toEqual({ operation: f.instruction.operation, at: NOW })
      const notice = decodeRekeyEvent(f.instruction.events[1]!, { roomId: f.node.room, authority: f.node.authority, current, deviceSk: generateSecretKey() })
      expect(notice).toMatchObject({ epoch: 1, closed: true, destruct: true }); expect(notice?.secret).toBeUndefined()
      const reset = parseGroupEvent(f.instruction.reset); expect(reset.ok && reset.parsed.createdAt).toBe(NOW + 2)
      expect(f.instruction.deadline).toBe(NOW + 5)
      expect(JSON.stringify(f.pending)).not.toContain(bytesToHex(f.roomSecret))
      expect(JSON.stringify(f.pending)).not.toContain(bytesToHex(f.authoritySk))
      expect(f.store.stage).not.toHaveBeenCalled(); expect(f.options.fetcher).not.toHaveBeenCalled()
    } finally { current.key.fill(0) }
  })
  it('clamps drain time and both closing events to a near room end', () => {
    const f = fixture(NOW + 3)
    expect(f.instruction.deadline).toBe(NOW + 2)
    for (const event of f.instruction.events) expect(event.tags).toContainEqual(['expiration', String(NOW + 3)])
  })
  it('sends nothing until the exact intent is saved, and retains only the public reference after acknowledgement', async () => {
    const f = fixture(); f.mutateStage()
    expect(await submitPendingNodeRoomClose(f.pending, localIdentity(f.authoritySk), f.store, f.options)).toEqual({ phase: 'draining' })
    expect(f.saved()).toBeUndefined(); expect(f.reference()).toEqual(f.pending.reference)
    expect(f.store.stage).toHaveBeenCalledTimes(1); expect(f.store.forgetRoom).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(f.reference())).not.toContain(f.node.room)
    const g = fixture(); g.failStage()
    await expect(submitPendingNodeRoomClose(g.pending, localIdentity(g.authoritySk), g.store, g.options)).rejects.toMatchObject({ reason: 'unavailable' })
    expect(g.options.fetcher).not.toHaveBeenCalled(); expect(g.store.forgetRoom).not.toHaveBeenCalled()
  })
  it('retries identical signed bytes after a lost acknowledgement', async () => {
    const f = fixture(); f.mode('lost')
    await expect(submitPendingNodeRoomClose(f.pending, localIdentity(f.authoritySk), f.store, f.options)).rejects.toMatchObject({ reason: 'unavailable' })
    expect(f.store.forgetRoom).not.toHaveBeenCalled(); const restored = f.saved()!
    f.mode('pending'); await submitPendingNodeRoomClose(restored, localIdentity(f.authoritySk), f.store, f.options)
    expect(f.bodies).toHaveLength(2); expect(f.bodies[1]).toBe(f.bodies[0])
  })
  it('verifies completion with only the public owner reference after all room keys are gone', async () => {
    const f = fixture()
    await submitPendingNodeRoomClose(f.pending, localIdentity(f.authoritySk), f.store, f.options)
    const reference = f.reference()!; f.authoritySk.fill(0); f.roomSecret.fill(0); f.mode('done')
    expect(await queryNodeCloseOperation(reference.node, reference.operation, f.owner, f.options)).toMatchObject({ phase: 'done', receipt: { callsRevoked: true, relayPurged: true } })
    f.mode('incomplete')
    await expect(queryNodeCloseOperation(reference.node, reference.operation, f.owner, f.options)).rejects.toMatchObject({ reason: 'invalid' })
  })
  it('projects only signed events and public pairing fields into the durable request', () => {
    const f = fixture(), pair = { ...f.pair, authoritySk: f.authoritySk }, instruction = { ...f.instruction, roomSecret: f.roomSecret }
    const pending = pendingNodeRoomClose(pair, f.node, instruction, NOW)
    expect(Object.keys(pending.reference.node).sort()).toEqual(['origin', 'owner', 'serviceKey', 'v'])
    expect(Object.keys(pending.instruction).sort()).toEqual(['closure', 'deadline', 'events', 'operation', 'reset'])
    expect(Object.keys(pending.descriptor)).toHaveLength(7)
  })
})
