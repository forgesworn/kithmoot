import { describe, it, expect } from 'vitest'
import { generateSecretKey, finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { ContextVault, type ContextIdentity } from './context.js'
import { localIdentity } from './identity.js'
import { localPeerCrypt } from './dm.js'
import { issueAgentOwnership } from './ownership.js'
import { sha256Hex } from './attachment.js'

const SERVER = 'https://storage.example'
const ROOM = 'ab'.repeat(32)
let now = 1788700000
function identity() {
  const sk = generateSecretKey()
  return { sk, ...localIdentity(sk), ...localPeerCrypt(sk) } satisfies ContextIdentity & { sk: Uint8Array }
}
function storage() {
  const blobs = new Map<string, Uint8Array>()
  const requests: string[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    requests.push(url)
    if (init?.method === 'PUT') {
      const bytes = new Uint8Array(init.body as ArrayBuffer)
      const hash = sha256Hex(bytes)
      blobs.set(`${SERVER}/${hash}`, bytes)
      return Response.json({ url: `${SERVER}/${hash}`, sha256: hash, size: bytes.length }, { status: 201 })
    }
    const blob = blobs.get(url)
    return blob ? new Response(blob.slice().buffer) : new Response('', { status: 404 })
  }
  return { blobs, requests, fetcher }
}
function vault(who: ContextIdentity, store: ReturnType<typeof storage>, room?: string) {
  return new ContextVault({ identity: who, servers: [SERVER], fetch: store.fetcher, now: () => now, room })
}
function proof(person: ReturnType<typeof identity>, agent: ReturnType<typeof identity>) {
  return issueAgentOwnership({ principalSk: person.sk, agent: agent.pubkey, issuedAt: now, expiresAt: now + 86400 })
}
const note = (text: string) => ({ kind: 'blocker' as const, text, source: 'kithmoot://room/chat/source-message', observedAt: now })

describe('encrypted context across independent people and agents', () => {
  it('shares a Wildbloom collection, survives restart, and never sends plaintext to storage', async () => {
    const store = storage(), alice = identity(), bob = identity(), tally = identity(), quill = identity()
    const owner = vault(alice, store)
    let shared = await owner.create({ title: 'Shared project', scope: 'kith', room: ROOM })
    shared = await owner.setGrants(shared.id, shared.head, [
      { subject: tally.pubkey, role: 'write', expiresAt: now + 3600, agent: proof(alice, tally) },
      { subject: quill.pubkey, role: 'read', expiresAt: now + 3600, agent: proof(bob, quill) },
    ])
    shared = await owner.append(shared.id, shared.head, note('Board connected; needs a person to press its button.'))
    await owner.upload(shared.id, SERVER)
    const ticket = await owner.access(shared.id, quill.pubkey)
    expect(JSON.stringify(ticket)).not.toContain('Shared project')
    const reader = vault(quill, store, ROOM)
    const recovered = await reader.importAccess(ticket)
    expect(recovered.records[0].text).toContain('press its button')
    const saved = await reader.save()
    expect(saved).not.toContain('press its button')
    expect(saved).not.toContain('Shared project')
    expect([...store.blobs.values()].every(b => !new TextDecoder().decode(b).includes('press its button'))).toBe(true)
    const restarted = vault(quill, store, ROOM)
    const calls = store.requests.length
    await restarted.restore(saved)
    expect(store.requests).toHaveLength(calls)
    expect(restarted.read(shared.id, 'button').records).toHaveLength(1)
    await expect(restarted.append(shared.id, recovered.head, note('pretend accepted'))).rejects.toThrow('write permission')
    await expect(restarted.setGrants(shared.id, recovered.head, [])).rejects.toThrow('Only the collection owner')
  })

  it('keeps each owner’s personal collection out of the other agent and the room adapter', async () => {
    const store = storage(), alice = identity(), bob = identity(), tally = identity(), quill = identity()
    const owner = vault(alice, store)
    let personal = await owner.create({ title: 'Private strategy', scope: 'personal' })
    await expect(owner.setGrants(personal.id, personal.head, [{ subject: quill.pubkey, role: 'read', expiresAt: now + 100, agent: proof(bob, quill) }])).rejects.toThrow('owner’s agents')
    personal = await owner.setGrants(personal.id, personal.head, [{ subject: tally.pubkey, role: 'read', expiresAt: now + 100, agent: proof(alice, tally) }])
    personal = await owner.append(personal.id, personal.head, note('Private confidential planning.'))
    await owner.upload(personal.id, SERVER)
    const ticket = await owner.access(personal.id, tally.pubkey)
    const foreign = vault(quill, store), roomAgent = vault(tally, store, ROOM)
    const before = store.requests.length
    await expect(foreign.importAccess(ticket)).rejects.toThrow('not available')
    await expect(roomAgent.importAccess(ticket)).rejects.toThrow('not available')
    expect(store.requests).toHaveLength(before)
    expect(foreign.list()).toEqual([])
    expect(() => foreign.read(personal.id)).toThrow('not available')
    const privateAgent = vault(tally, store)
    await privateAgent.importAccess(ticket)
    expect(privateAgent.read(personal.id).records[0].text).toContain('confidential')
    await roomAgent.restore(await privateAgent.save())
    expect(roomAgent.list()).toEqual([])
  })

  it('allows independently signed agent updates and detects concurrent forks', async () => {
    const store = storage(), alice = identity(), tally = identity(), bob = identity(), quill = identity()
    const owner = vault(alice, store)
    let shared = await owner.create({ title: 'Tasks', scope: 'kin', room: ROOM })
    shared = await owner.setGrants(shared.id, shared.head, [
      { subject: tally.pubkey, role: 'write', expiresAt: now + 1000, agent: proof(alice, tally) },
      { subject: quill.pubkey, role: 'write', expiresAt: now + 1000, agent: proof(bob, quill) },
    ])
    await owner.upload(shared.id, SERVER)
    const a = vault(tally, store, ROOM), b = vault(quill, store, ROOM)
    await a.importAccess(await owner.access(shared.id, tally.pubkey))
    await b.importAccess(await owner.access(shared.id, quill.pubkey))
    const update = await a.append(shared.id, shared.head, note('Tally checked the firmware.'))
    await a.upload(shared.id, SERVER)
    const access = await a.access(shared.id, quill.pubkey)
    expect((await b.importAccess(access)).records[0].author).toBe(tally.pubkey)
    await expect(b.append(shared.id, shared.head, note('Stale edit'))).rejects.toThrow('changed')
    await a.append(shared.id, update.head, note('Change A'))
    await b.append(shared.id, update.head, note('Change B'))
    await a.upload(shared.id, SERVER)
    await expect(b.importAccess(await a.access(shared.id, quill.pubkey))).rejects.toThrow('history conflict')
    expect(b.read(shared.id).records.at(-1)?.text).toBe('Change B')
  })

  it('rejects forged ownership, expired grants, another room, and tampered blobs', async () => {
    const store = storage(), alice = identity(), agent = identity()
    const owner = vault(alice, store)
    let c = await owner.create({ title: 'Checks', scope: 'kith', room: ROOM })
    const forged = { ...proof(alice, agent), sig: '00'.repeat(64) }
    await expect(owner.setGrants(c.id, c.head, [{ subject: agent.pubkey, role: 'read', expiresAt: now + 20, agent: forged }])).rejects.toThrow('ownership')
    c = await owner.setGrants(c.id, c.head, [{ subject: agent.pubkey, role: 'read', expiresAt: now + 20, agent: proof(alice, agent) }])
    await owner.upload(c.id, SERVER)
    const ticket = await owner.access(c.id, agent.pubkey)
    const reader = vault(agent, store, ROOM)
    await expect(vault(agent, store, 'cd'.repeat(32)).importAccess(ticket)).rejects.toThrow('not available')
    const tampered = structuredClone(ticket); tampered.content += ' '
    await expect(reader.importAccess(tampered)).rejects.toThrow('signature')
    const bytes = [...store.blobs.values()][0]; bytes[bytes.length - 1] ^= 1
    await expect(reader.importAccess(ticket)).rejects.toThrow('hash or size')
    now += 21
    const calls = store.requests.length
    await expect(reader.importAccess(ticket)).rejects.toThrow('not available')
    expect(store.requests).toHaveLength(calls)
    now -= 21
  })

  it('rotates keys on removal and will not create access for the removed reader', async () => {
    const store = storage(), alice = identity(), bob = identity(), owner = vault(alice, store)
    let c = await owner.create({ title: 'Rotation', scope: 'kin', room: ROOM })
    c = await owner.setGrants(c.id, c.head, [{ subject: bob.pubkey, role: 'read', expiresAt: now + 100 }])
    await owner.upload(c.id, SERVER)
    const oldTicket = await owner.access(c.id, bob.pubkey)
    const oldBody = JSON.parse(await bob.decrypt(alice.pubkey, JSON.parse(oldTicket.content).ciphertext))
    c = await owner.setGrants(c.id, c.head, [])
    await owner.upload(c.id, SERVER)
    const self = await owner.access(c.id, alice.pubkey)
    const newBody = JSON.parse(await alice.decrypt(alice.pubkey, JSON.parse(self.content).ciphertext))
    expect(newBody.key).not.toBe(oldBody.key)
    await expect(owner.access(c.id, bob.pubkey)).rejects.toThrow('recipient grant')
    expect(c.epoch).toBe(3)
  })

  it('requires storage opt-in and refuses metadata substitution before fetching', async () => {
    const store = storage(), alice = identity(), bob = identity(), owner = vault(alice, store)
    let c = await owner.create({ title: 'Opt in', scope: 'kith', room: ROOM })
    c = await owner.setGrants(c.id, c.head, [{ subject: bob.pubkey, role: 'read', expiresAt: now + 100 }])
    await owner.upload(c.id, SERVER)
    const ticket = await owner.access(c.id, bob.pubkey)
    const reader = new ContextVault({ identity: bob, fetch: store.fetcher, now: () => now })
    const count = store.requests.length
    expect((await reader.previewAccess(ticket)).title).toBe('Opt in')
    expect(store.requests).toHaveLength(count)
    await expect(reader.importAccess(ticket)).rejects.toThrow('not enabled')
    const sealed = JSON.parse(ticket.content)
    const body = JSON.parse(await bob.decrypt(alice.pubkey, sealed.ciphertext))
    body.pointer.url = 'https://storage.example/../../private'
    const changed = finalizeEvent({ kind: 30078, created_at: now, tags: ticket.tags,
      content: JSON.stringify({ v: 1, recipient: bob.pubkey, ciphertext: await alice.encrypt(bob.pubkey, JSON.stringify(body)) }) }, alice.sk)
    await expect(vault(bob, store).importAccess(changed)).rejects.toThrow('canonical')
    expect(store.requests).toHaveLength(count)
  })
})
