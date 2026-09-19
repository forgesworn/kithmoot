import type { NostrEvent } from 'signet-protocol'
import { agentOwnershipFromEvent, verifyAgentOwnership, type OwnershipVerdict, type VerifyAgentOwnershipOptions } from './ownership.js'
import type { AgentOwnership } from './types.js'

export interface OwnershipEventStore {
  get(key: string): string | null
  set(key: string, value: string): void
  keys(): string[]
  remove(key: string): void
}
const PREFIX = 'kithmoot.ownership.v1.'
const LIMIT = 500
const keyFor = (principal: string, agent: string) => `${PREFIX}${principal.toLowerCase()}:${agent.toLowerCase()}`
function memoryStore(): OwnershipEventStore {
  const rows = new Map<string, string>()
  return { get: key => rows.get(key) ?? null, set: (key, value) => { rows.set(key, value) }, keys: () => [...rows.keys()], remove: key => { rows.delete(key) } }
}
/** Remembers authenticated ownership statements without any relay lookups.
 * Never evicts a high-water mark. Full, corrupt or unavailable storage fails
 * closed. Embeddings supply persistent storage to retain evidence after restart. */
export class OwnershipRegistry {
  constructor(private readonly store: OwnershipEventStore = memoryStore()) {}
  private entries(principal: string, agent: string): Array<{ key: string; proof: AgentOwnership }> {
    const prefix = keyFor(principal, agent) + ':'
    return this.store.keys().filter(key => key.startsWith(prefix)).map(key => {
      const raw = this.store.get(key)
      // Another tab may have removed a superseded entry since keys() ran.
      if (raw === null) return null
      if (raw.length > 8192) throw new Error('Invalid remembered ownership')
      const proof = agentOwnershipFromEvent(JSON.parse(raw) as NostrEvent)
      if (!proof || proof.principal !== principal.toLowerCase() || proof.agent !== agent.toLowerCase()
        || key !== prefix + proof.attestation!.id) throw new Error('Invalid remembered ownership')
      return { key, proof }
    }).filter((row): row is { key: string; proof: AgentOwnership } => row !== null)
  }
  private newer(a: AgentOwnership, b: AgentOwnership): boolean {
    if (a.issuedAt !== b.issuedAt) return a.issuedAt > b.issuedAt
    const revoked = (proof: AgentOwnership) => proof.attestation!.tags.some(t => t[0] === 'status' && t[1] === 'revoked')
    if (revoked(a) !== revoked(b)) return revoked(a)
    return a.attestation!.id < b.attestation!.id
  }
  private read(principal: string, agent: string): AgentOwnership | null {
    return this.entries(principal, agent).reduce<AgentOwnership | null>((best, row) =>
      !best || this.newer(row.proof, best) ? row.proof : best, null)
  }
  /** Import an event received through an already chosen private or public channel.
   * Equal-clock revocation wins; equal-clock claims use the lowest event id. */
  observe(event: NostrEvent, now: number): boolean {
    try {
      if (!Number.isSafeInteger(now) || now < 0 || !event || event.created_at > now + 300) return false
      const incoming = agentOwnershipFromEvent(event)
      if (!incoming) return false
      const previous = this.entries(incoming.principal, incoming.agent)
      if (previous.some(row => row.proof.attestation!.id === event.id || this.newer(row.proof, incoming))) return true
      const pairs = new Set(this.store.keys().filter(key => key.startsWith(PREFIX)).map(key => key.slice(0, key.lastIndexOf(':'))))
      if (!previous.length && pairs.size >= LIMIT) return false
      // Immutable event keys prevent a stale tab overwriting a newer event.
      // Prune only entries observed before this write and strictly older than it.
      const key = keyFor(incoming.principal, incoming.agent) + ':' + event.id
      this.store.set(key, JSON.stringify(incoming.attestation))
      if (!this.entries(incoming.principal, incoming.agent).some(row => row.proof.attestation!.id === event.id)) {
        // A concurrent newer writer may already have safely pruned our event.
        const current = this.read(incoming.principal, incoming.agent)
        return !!current && this.newer(current, incoming)
      }
      for (const row of previous) if (this.newer(incoming, row.proof)) this.store.remove(row.key)
      return true
    } catch { return false }
  }
  /** Live authority only. Historical chat keeps its separate send-time checks. */
  verify(proof: AgentOwnership, opts: VerifyAgentOwnershipOptions): OwnershipVerdict {
    const verdict = verifyAgentOwnership(proof, opts)
    if (!verdict.ok) return verdict
    try {
      if (proof.attestation && !this.observe(proof.attestation, opts.now)) return { ok: false, reason: 'ownership memory unavailable' }
      const current = this.read(proof.principal, proof.agent)
      if (current && current.attestation!.id !== proof.attestation?.id) return { ok: false, reason: 'superseded ownership' }
      return verdict
    } catch { return { ok: false, reason: 'ownership memory unavailable' } }
  }
}
