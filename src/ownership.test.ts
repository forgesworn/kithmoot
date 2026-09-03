import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { issueAgentOwnership, normaliseAgentOwnership, verifyAgentOwnership } from './ownership.js'
import { createDeviceCredential } from './credential.js'
import { localIdentity } from './identity.js'
import { deriveRoom, parseRoomPolicy } from './room.js'
import { encodeRosterEvent, decodeRosterEvent } from './roster.js'
import { encodeChatEvent, decodeChatEvent } from './chat.js'
import { evaluateAgentAccess } from './access.js'
import type { RosterEntry } from './types.js'

const NOW = 1_800_000_000
const principalSk = generateSecretKey()
const principal = getPublicKey(principalSk)
const agentSk = generateSecretKey()
const agent = getPublicKey(agentSk)

describe('agent ownership', () => {
  it('a principal signs, and anybody verifies, with the label and expiry as signed', () => {
    const proof = issueAgentOwnership({ principalSk, agent, issuedAt: NOW, expiresAt: NOW + 86_400, label: '  Tally​ ' })
    expect(proof.agent).toBe(agent)
    expect(proof.principal).toBe(principal)
    expect(proof.label).toBe('Tally')
    expect(verifyAgentOwnership(proof, { agent, now: NOW + 10 })).toEqual({ ok: true, principal, label: 'Tally' })
    // Case on the way in does not change what it names.
    expect(verifyAgentOwnership({ ...proof, agent: proof.agent.toUpperCase() }, { agent, now: NOW })).toMatchObject({ ok: true })
  })

  it('refuses a tampered proof: label, expiry, principal, agent', () => {
    const proof = issueAgentOwnership({ principalSk, agent, issuedAt: NOW, expiresAt: NOW + 3600, label: 'Tally' })
    expect(verifyAgentOwnership({ ...proof, label: 'Tally the Great' }, { agent, now: NOW })).toEqual({ ok: false, reason: 'bad signature' })
    expect(verifyAgentOwnership({ ...proof, expiresAt: NOW + 999_999 }, { agent, now: NOW })).toEqual({ ok: false, reason: 'bad signature' })
    const { expiresAt: _dropped, ...noExpiry } = proof
    void _dropped
    expect(verifyAgentOwnership(noExpiry, { agent, now: NOW })).toEqual({ ok: false, reason: 'bad signature' })
    // Somebody else's key on the principal line: the signature is not theirs.
    expect(verifyAgentOwnership({ ...proof, principal: getPublicKey(generateSecretKey()) }, { agent, now: NOW })).toEqual({ ok: false, reason: 'bad signature' })
    // A proof about one agent presented by another.
    expect(verifyAgentOwnership(proof, { agent: getPublicKey(generateSecretKey()), now: NOW })).toEqual({ ok: false, reason: 'names another agent' })
    expect(verifyAgentOwnership({ ...proof, sig: 'ff'.repeat(64) }, { agent, now: NOW })).toEqual({ ok: false, reason: 'bad signature' })
  })

  it('expires when it says, and is never from the future', () => {
    const proof = issueAgentOwnership({ principalSk, agent, issuedAt: NOW, expiresAt: NOW + 3600 })
    expect(verifyAgentOwnership(proof, { agent, now: NOW + 3599 }).ok).toBe(true)
    expect(verifyAgentOwnership(proof, { agent, now: NOW + 3600 })).toEqual({ ok: false, reason: 'expired' })
    const forever = issueAgentOwnership({ principalSk, agent, issuedAt: NOW })
    expect(verifyAgentOwnership(forever, { agent, now: NOW + 10 * 365 * 86_400 }).ok).toBe(true)
    const ahead = issueAgentOwnership({ principalSk, agent, issuedAt: NOW + 3600 })
    expect(verifyAgentOwnership(ahead, { agent, now: NOW })).toEqual({ ok: false, reason: 'issued in the future' })
  })

  it('an agent cannot be its own principal, and a label is shown only as signed', () => {
    expect(() => issueAgentOwnership({ principalSk, agent: principal, issuedAt: NOW })).toThrow(/own principal/)
    expect(() => issueAgentOwnership({ principalSk, agent, issuedAt: NOW, expiresAt: NOW })).toThrow(/after/)
    // A label somebody signed with a control character in it would have to
    // be changed to be shown, so it is not shown.
    const proof = issueAgentOwnership({ principalSk, agent, issuedAt: NOW })
    const hostile = { ...proof, label: 'Tal‮ly' }
    expect(verifyAgentOwnership(hostile, { agent, now: NOW })).toEqual({ ok: false, reason: 'label is not as signed' })
    expect(normaliseAgentOwnership({ agent, principal, issuedAt: NOW, sig: 'nope' })).toBeNull()
    expect(normaliseAgentOwnership('junk')).toBeNull()
  })
})

describe('whose agent, on the wire', () => {
  const secret = new Uint8Array(32).fill(5)
  const { roomId, roomKey } = deriveRoom(secret)

  async function entryFor(sk: Uint8Array, deviceSk: Uint8Array, extra: Partial<RosterEntry> = {}): Promise<RosterEntry> {
    const identity = localIdentity(sk)
    const device = getPublicKey(deviceSk)
    const credential = await createDeviceCredential({ identity, devicePubkey: device, roomId, expiresAt: NOW + 3600 })
    return { participant: identity.pubkey, device, credential, tracks: [], claims: {}, updatedAt: NOW, ...extra }
  }

  it('a valid proof survives the roster, a tampered one costs only the claim, and a person cannot carry one', async () => {
    const deviceSk = generateSecretKey()
    const proof = issueAgentOwnership({ principalSk, agent, issuedAt: NOW, label: 'Tally' })
    const good = encodeRosterEvent(await entryFor(agentSk, deviceSk, { agent: true, owner: proof }), { roomId, roomKey, deviceSk })
    const decoded = decodeRosterEvent(good, { roomId, roomKey, now: NOW })!
    expect(decoded.owner).toEqual(proof)

    const forged = encodeRosterEvent(await entryFor(agentSk, deviceSk, { agent: true, owner: { ...proof, label: 'Boss' } }), { roomId, roomKey, deviceSk })
    const kept = decodeRosterEvent(forged, { roomId, roomKey, now: NOW })!
    expect(kept.agent).toBe(true)
    expect(kept.owner).toBeUndefined()

    // A proof for one agent on another agent's entry is not that agent's.
    const otherSk = generateSecretKey()
    const otherDevice = generateSecretKey()
    const borrowed = encodeRosterEvent(await entryFor(otherSk, otherDevice, { agent: true, owner: proof }), { roomId, roomKey, deviceSk: otherDevice })
    expect(decodeRosterEvent(borrowed, { roomId, roomKey, now: NOW })!.owner).toBeUndefined()

    // A person with a proof is not an agent; the proof goes, the person stays.
    const person = encodeRosterEvent(await entryFor(agentSk, deviceSk, { owner: proof }), { roomId, roomKey, deviceSk })
    const personDecoded = decodeRosterEvent(person, { roomId, roomKey, now: NOW })!
    expect(personDecoded.owner).toBeUndefined()
    expect(personDecoded.agent).toBeUndefined()
    // And an entry with no proof is byte-for-byte the shape it always was.
    const plain = encodeRosterEvent(await entryFor(agentSk, deviceSk, { agent: true }), { roomId, roomKey, deviceSk })
    expect(decodeRosterEvent(plain, { roomId, roomKey, now: NOW })).not.toHaveProperty('owner')
  })

  it('rides a chat message and is judged as at its send time', async () => {
    const deviceSk = generateSecretKey()
    const entry = await entryFor(agentSk, deviceSk)
    const proof = issueAgentOwnership({ principalSk, agent, issuedAt: NOW, expiresAt: NOW + 100 })
    const msg = { id: 'm1', participant: entry.participant, device: entry.device, credential: entry.credential, text: 'hello', sentAt: NOW + 10, owner: proof }
    const event = encodeChatEvent(msg, { roomId, roomKey, deviceSk })
    // Read long after the proof expired: it held when the line was written.
    expect(decodeChatEvent(event, { roomId, roomKey, now: NOW + 10_000 })!.owner).toEqual(proof)
    // Written after it expired: the claim goes, the words stay.
    const late = encodeChatEvent({ ...msg, id: 'm2', sentAt: NOW + 200, credential: entry.credential }, { roomId, roomKey, deviceSk })
    const decoded = decodeChatEvent(late, { roomId, roomKey, now: NOW + 300 })!
    expect(decoded.text).toBe('hello')
    expect(decoded.owner).toBeUndefined()
  })

  it('the agent rule parses off a link, refuses what it does not know, and gates on a present principal', () => {
    expect(parseRoomPolicy({ tier: 'open', agents: 'owned-by-members' })).toEqual({ tier: 'open', agents: 'owned-by-members' })
    expect(parseRoomPolicy({ tier: 'open' })).toEqual({ tier: 'open' })
    expect(() => parseRoomPolicy({ tier: 'open', agents: 'anyone' })).toThrow(/agent rule/)

    const policy = { tier: 'open' as const, agents: 'owned-by-members' as const }
    const proof = issueAgentOwnership({ principalSk, agent, issuedAt: NOW })
    const present = (p: string) => p === principal
    expect(evaluateAgentAccess(policy, { participant: agent, agent: true, owner: proof }, present).admitted).toBe(true)
    expect(evaluateAgentAccess(policy, { participant: agent, agent: true }, present)).toEqual({ admitted: false, reason: 'no ownership proof' })
    expect(evaluateAgentAccess(policy, { participant: agent, agent: true, owner: proof }, () => false)).toEqual({ admitted: false, reason: 'principal is not in the room' })
    // People are not agents, and a room with no rule asks nothing.
    expect(evaluateAgentAccess(policy, { participant: principal }, () => false).admitted).toBe(true)
    expect(evaluateAgentAccess({ tier: 'open' }, { participant: agent, agent: true }, () => false).admitted).toBe(true)
  })
})
