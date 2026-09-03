import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { RoomAgent } from './agent.js'
import type { ApprovalOutcome, IgnoredApproval } from './agent.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { CONTROL_CHANNEL, decodeControl, encodeControl } from './control.js'
import { localIdentity } from './identity.js'
import { issueAgentOwnership } from './ownership.js'
import { AgentRuntime } from './node/runtime.js'
import { StdioBrain } from './node/brains.js'

const BASE = 'https://example.test/j/'
const transportFor = (relay: SimRelay) => () => new SimTransport(relay)

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('approval control messages', () => {
  it('round-trips a request and an answer, and refuses what it cannot carry', () => {
    const request = { op: 'approval-request' as const, id: 'deploy-7', text: 'Ship v2?', options: ['ship', 'hold'], expiresAt: 1_800_000_600 }
    expect(decodeControl(encodeControl(request))).toEqual(request)
    const bare = { op: 'approval-request' as const, id: 'a1', text: 'ok?' }
    expect(decodeControl(encodeControl(bare))).toEqual(bare)
    const answer = { op: 'approval' as const, id: 'deploy-7', verdict: 'ship', note: 'go' }
    expect(decodeControl(encodeControl(answer))).toEqual(answer)
    expect(decodeControl(JSON.stringify({ op: 'approval-request', id: '../x', text: 'no' }))).toBeNull()
    expect(decodeControl(JSON.stringify({ op: 'approval-request', id: 'a', text: '' }))).toBeNull()
    expect(decodeControl(JSON.stringify({ op: 'approval-request', id: 'a', text: 'x', options: [] }))).toBeNull()
    expect(decodeControl(JSON.stringify({ op: 'approval-request', id: 'a', text: 'x', options: ['<b>'] }))).toBeNull()
    expect(decodeControl(JSON.stringify({ op: 'approval', id: 'a', verdict: '' }))).toBeNull()
  })
})

describe('approvals in the room', () => {
  async function scene(opts: { admin?: boolean } = {}) {
    const relay = new SimRelay()
    const principalSk = generateSecretKey()
    const principal = localIdentity(principalSk)
    const agentSk = generateSecretKey()
    const proof = issueAgentOwnership({ principalSk, agent: getPublicKey(agentSk), issuedAt: Math.floor(Date.now() / 1000), label: 'Tally' })
    const adminSk = generateSecretKey()
    const admin = localIdentity(adminSk)
    const keeper = await RoomAgent.create({
      base: BASE,
      name: 'Keeper',
      relays: ['wss://sim'],
      transport: transportFor(relay),
      announceJitterMs: 0,
      admins: opts.admin ? [admin.pubkey] : [],
    })
    const tally = await RoomAgent.join({ link: keeper.url, name: 'Tally', identity: localIdentity(agentSk), owner: proof, transport: transportFor(relay), announceJitterMs: 0 })
    const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', identity: principal, agent: false, transport: transportFor(relay), announceJitterMs: 0 })
    const bob = await RoomAgent.join({ link: keeper.url, name: 'Bob', agent: false, transport: transportFor(relay), announceJitterMs: 0 })
    const host = await RoomAgent.join({ link: keeper.url, name: 'Host', identity: admin, agent: false, transport: transportFor(relay), announceJitterMs: 0 })
    await settle()
    return { relay, keeper, tally, ada, bob, host, principal, admin }
  }

  it('the owner answers, a stranger is ignored and said so, and the answer names who gave it', async () => {
    const { keeper, tally, ada, bob, host } = await scene()
    const ignored: IgnoredApproval[] = []
    tally.onApprovalIgnored((i) => ignored.push(i))
    const outcomes: ApprovalOutcome[] = []
    tally.onApproval((o) => outcomes.push(o))

    const pending = tally.requestApproval({ id: 'deploy-7', text: 'Ship v2?', options: ['ship', 'hold'], ttlSeconds: 60 })
    await settle()
    // Everybody in the room sees the question.
    const seen = bob.channel(CONTROL_CHANNEL).messages().map((m) => decodeControl(m.text)).find((c) => c?.op === 'approval-request')
    expect(seen).toMatchObject({ op: 'approval-request', id: 'deploy-7', text: 'Ship v2?', options: ['ship', 'hold'] })

    // Bob is nobody to Tally.
    await bob.channel(CONTROL_CHANNEL).send(encodeControl({ op: 'approval', id: 'deploy-7', verdict: 'ship' }))
    await settle()
    expect(ignored).toEqual([{ id: 'deploy-7', by: bob.participant, verdict: 'ship', reason: 'not an approver' }])
    expect(outcomes).toEqual([])

    // Nor is an answer that is not one of the options, even from the owner.
    await ada.channel(CONTROL_CHANNEL).send(encodeControl({ op: 'approval', id: 'deploy-7', verdict: 'maybe' }))
    await settle()
    expect(ignored.at(-1)).toMatchObject({ by: ada.participant, reason: 'not an option' })

    // Ada is Tally's verified principal.
    await ada.channel(CONTROL_CHANNEL).send(encodeControl({ op: 'approval', id: 'deploy-7', verdict: 'hold', note: 'not on a Friday' }))
    await settle()
    const outcome = await pending
    expect(outcome).toMatchObject({ id: 'deploy-7', verdict: 'hold', by: ada.participant, note: 'not on a Friday', expired: false })
    expect(outcomes).toEqual([outcome])

    // A second answer to a settled question is nothing.
    await ada.channel(CONTROL_CHANNEL).send(encodeControl({ op: 'approval', id: 'deploy-7', verdict: 'ship' }))
    await settle()
    expect(ignored.at(-1)).toMatchObject({ reason: 'unknown request' })
    for (const a of [keeper, tally, ada, bob, host]) a.leave()
  })

  it('an announced admin may answer for any agent, and the list is read from the keeper only', async () => {
    const { keeper, tally, ada, bob, host } = await scene({ admin: true })
    expect([...tally.announcedAdmins]).toEqual([host.participant])
    // Bob claims to be the admin list; nobody believes him.
    await bob.channel(CONTROL_CHANNEL).send(JSON.stringify({ op: 'admins', host: bob.participant, admins: [bob.participant], epoch: 0, sig: 'ab'.repeat(64) }))
    await settle()
    expect([...tally.announcedAdmins]).toEqual([host.participant])

    const pending = tally.requestApproval({ text: 'Delete the branch?', ttlSeconds: 60 })
    await settle()
    const request = host.channel(CONTROL_CHANNEL).messages().map((m) => decodeControl(m.text)).find((c) => c?.op === 'approval-request')
    if (request?.op !== 'approval-request') throw new Error('unreachable')
    expect(request.options).toEqual(['approve', 'decline'])
    await host.channel(CONTROL_CHANNEL).send(encodeControl({ op: 'approval', id: request.id, verdict: 'approve' }))
    const outcome = await pending
    expect(outcome).toMatchObject({ id: request.id, verdict: 'approve', by: host.participant, expired: false })
    for (const a of [keeper, tally, ada, bob, host]) a.leave()
  })

  it('expires when nobody answers, and a late answer is ignored', async () => {
    const { keeper, tally, ada, bob, host } = await scene()
    const ignored: IgnoredApproval[] = []
    tally.onApprovalIgnored((i) => ignored.push(i))
    const outcome = await tally.requestApproval({ id: 'slow', text: 'Anyone?', ttlSeconds: 0.05 })
    expect(outcome).toMatchObject({ id: 'slow', verdict: 'expired', expired: true })
    expect(outcome.by).toBeUndefined()
    await ada.channel(CONTROL_CHANNEL).send(encodeControl({ op: 'approval', id: 'slow', verdict: 'approve' }))
    await settle()
    expect(ignored).toEqual([{ id: 'slow', by: ada.participant, verdict: 'approve', reason: 'unknown request' }])
    await expect(tally.requestApproval({ text: 'x', ttlSeconds: 0 })).rejects.toThrow(/positive/)
    for (const a of [keeper, tally, ada, bob, host]) a.leave()
  })

  it('the runtime emits the verdict as an event, and the stdio brain writes it as {type, id, verdict, by}', async () => {
    const { keeper, tally, ada, bob, host } = await scene()
    const runtime = new AgentRuntime(tally, { persona: { name: 'Tally', system: '' } }).start()
    const input = new PassThrough()
    const output = new PassThrough()
    const lines: string[] = []
    output.on('data', (chunk: Buffer) => lines.push(...chunk.toString().split('\n').filter(Boolean)))
    const brain = new StdioBrain(input, output)
    const stop = await brain.start(runtime)

    input.write(JSON.stringify({ op: 'approval-request', id: 'pipe-1', text: 'Merge it?', options: ['merge', 'wait'], ttlSeconds: 60 }) + '\n')
    await new Promise((r) => setTimeout(r, 20))
    await settle()
    expect(lines.map((l) => JSON.parse(l) as { type: string; op?: string; id?: string }).some((e) => e.type === 'ok' && e.op === 'approval-request' && e.id === 'pipe-1')).toBe(true)
    await ada.channel(CONTROL_CHANNEL).send(encodeControl({ op: 'approval', id: 'pipe-1', verdict: 'merge' }))
    await settle()
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    const verdict = events.find((e) => e.type === 'approval')
    expect(verdict).toEqual({ type: 'approval', id: 'pipe-1', verdict: 'merge', by: ada.participant, expired: false })
    expect(runtime.history('chat')).toEqual([])
    await stop()
    await runtime.close()
    for (const a of [keeper, ada, bob, host]) a.leave()
  })
})
