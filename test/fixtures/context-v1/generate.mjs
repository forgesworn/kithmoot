// Historical fixture generator: run only against pre-extraction commit 4e684fc.
// These fixed keys are public TEST keys, never deployment identities.
import { writeFileSync } from 'node:fs'
import { ContextVault } from '../../../dist/src/context.js'
import { localIdentity } from '../../../dist/src/identity.js'
import { localPeerCrypt } from '../../../dist/src/dm.js'
import { issueAgentOwnership } from '../../../dist/src/ownership.js'
const now = 1800000000
const sk = new Uint8Array(32).fill(1), agentSk = new Uint8Array(32).fill(2)
const identity = { ...localIdentity(sk), ...localPeerCrypt(sk) }
const agent = { ...localIdentity(agentSk), ...localPeerCrypt(agentSk) }
const vault = new ContextVault({ identity, now: () => now })
let shared = await vault.create({ title: 'Legacy sourced work', scope: 'kith', room: 'ab'.repeat(32) })
shared = await vault.append(shared.id, shared.head, { kind: 'decision', text: 'Retain signed history during extraction.', source: 'fixture://legacy/42', observedAt: now })
let personal = await vault.create({ title: 'Legacy private context', scope: 'personal' })
personal = await vault.setGrants(personal.id, personal.head, [{ subject: agent.pubkey, role: 'read', expiresAt: now + 3600, agent: issueAgentOwnership({ principalSk: sk, agent: agent.pubkey, issuedAt: now, expiresAt: now + 3600 }) }])
writeFileSync(new URL('./cache.json', import.meta.url), JSON.stringify({ provenance: 'kithmoot 4e684fc before package extraction; public test keys 01 and 02 repeated 32 times', now, shared, personal, cache: await vault.save() }) + '\n')
