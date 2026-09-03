import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { RoomSession } from './session.js'
import { localIdentity } from './identity.js'
import { issueAgentOwnership } from './ownership.js'
import type { RoomPolicy } from './types.js'

const NOW = 1_800_000_000
const SECRET = new Uint8Array(32).fill(31)
const OWNED: RoomPolicy = { tier: 'open', agents: 'owned-by-members' }

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}

function session(relay: SimRelay, sk: Uint8Array, name: string, extra: Record<string, unknown> = {}, now = () => NOW) {
  return new RoomSession({
    transport: new SimTransport(relay),
    secret: SECRET,
    identity: localIdentity(sk),
    deviceSk: generateSecretKey(),
    name,
    now,
    announceJitterMs: 0,
    ...extra,
  } as ConstructorParameters<typeof RoomSession>[0])
}

describe('whose agent, in a room', () => {
  it('shows a verified principal on the view, and never a bare claim', async () => {
    const relay = new SimRelay()
    const principalSk = generateSecretKey()
    const agentSk = generateSecretKey()
    const proof = issueAgentOwnership({ principalSk, agent: getPublicKey(agentSk), issuedAt: NOW, label: 'Tally' })
    const person = session(relay, principalSk, 'Ada')
    const tally = session(relay, agentSk, 'Tally', { agent: true, owner: proof })
    const stray = session(relay, generateSecretKey(), 'Stray', { agent: true })
    await person.join([], {})
    await tally.join([], {})
    await stray.join([], {})
    await settle()
    const views = person.participants()
    expect(views.find((v) => v.name === 'Tally')?.owner).toEqual({ principal: getPublicKey(principalSk), label: 'Tally' })
    expect(views.find((v) => v.name === 'Stray')?.owner).toBeUndefined()
    expect(views.find((v) => v.name === 'Stray')?.agent).toBe(true)
    // And on the chat.
    await tally.chat.send('reporting')
    await settle()
    expect(person.chat.messages()[0]?.owner).toEqual(proof)
  })

  it('a proof that names somebody else is refused at construction', () => {
    const relay = new SimRelay()
    const principalSk = generateSecretKey()
    const proof = issueAgentOwnership({ principalSk, agent: getPublicKey(generateSecretKey()), issuedAt: NOW })
    expect(() => session(relay, generateSecretKey(), 'Wrong', { agent: true, owner: proof })).toThrow(/another agent/)
  })

  it('under owned-by-members an agent is in the roster only with its principal', async () => {
    const relay = new SimRelay()
    const principalSk = generateSecretKey()
    const principal = getPublicKey(principalSk)
    const agentSk = generateSecretKey()
    const proof = issueAgentOwnership({ principalSk, agent: getPublicKey(agentSk), issuedAt: NOW })
    const observer = session(relay, generateSecretKey(), 'Observer', { policy: OWNED })
    await observer.join([], {})

    // No proof: never admitted, and told so at its own join.
    const stray = session(relay, generateSecretKey(), 'Stray', { agent: true, policy: OWNED })
    await expect(stray.join([], {})).rejects.toThrow(/ownership proof/)

    // A proof, but the principal is not here: not yet.
    const tally = session(relay, agentSk, 'Tally', { agent: true, owner: proof, policy: OWNED })
    await tally.join([], {})
    await settle()
    expect(observer.participants().map((v) => v.name)).toEqual(['Observer'])

    // The principal arrives; the agent answers the arrival and is admitted.
    const person = session(relay, principalSk, 'Ada', { policy: OWNED })
    await person.join([], {})
    await settle()
    expect(observer.participants().map((v) => v.name).sort()).toEqual(['Ada', 'Observer', 'Tally'])
    expect(observer.participants().find((v) => v.name === 'Tally')?.owner?.principal).toBe(principal)
    expect(person.participants().map((v) => v.name).sort()).toEqual(['Ada', 'Observer', 'Tally'])

    // The principal leaves; the agent goes with them.
    await person.leave()
    await settle()
    expect(observer.participants().map((v) => v.name).sort()).toEqual(['Observer'])
  })

  it('a room with no agent rule admits an unowned agent as it always did', async () => {
    const relay = new SimRelay()
    const observer = session(relay, generateSecretKey(), 'Observer')
    const stray = session(relay, generateSecretKey(), 'Stray', { agent: true })
    await observer.join([], {})
    await stray.join([], {})
    await settle()
    expect(observer.participants().map((v) => v.name).sort()).toEqual(['Observer', 'Stray'])
  })
})
