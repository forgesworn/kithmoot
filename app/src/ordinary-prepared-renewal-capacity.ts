/** @internal Fixed symbolic C size reservation. No custody, permission,
 * signature, random value, key, writer or construction callback is produced. */
import { ordinaryImageByteLength, OrdinaryStateHold, type OrdinaryImage } from './ordinary-state-codec.js'
import { ordinaryOperationNames } from './ordinary-operation-codec.js'
import { readOrdinaryRenewalRequest } from './ordinary-renewal-request.js'
import { inspectPersistentAdmissionProofs, accountPrefix, PERSISTENT_TAB_PROOF_V2_PREFIX,
  persistentProofName, persistentTabProofName, tabProofBytes } from './persistent-admission-proof.js'
import { OWN_CREDENTIAL_PREFIX, OWN_SEAL_PREFIX, type DeviceStore } from './device-store.js'
import { ordinaryMemberLeaseName, ordinaryMemberLeaseCredential, readOrdinaryMemberLease,
  memberLeaseDigest, makeOrdinaryMemberLeaseHeader } from './ordinary-member-lease.js'
import { credentialSeal } from '../../src/seal.js'
function hold(): never { throw new OrdinaryStateHold() }
const view = (records: ReadonlyMap<string, string>): DeviceStore => ({ keys: () => [...records.keys()], get: name => records.get(name) ?? null, set: hold, remove: hold })
export function reserveOrdinaryPreparedRenewalImages(predecessor: readonly [OrdinaryImage, OrdinaryImage], enrolled: readonly [OrdinaryImage, OrdinaryImage], raw: string): readonly [number, number] {
  const intent = readOrdinaryRenewalRequest(raw).intent, prefix = accountPrefix(intent.participant)
  const sourceB = predecessor[0].records, sourceT = predecessor[1].records, checked = inspectPersistentAdmissionProofs(view(sourceB), view(sourceT))
  const b = new Map(sourceB), t = new Map(sourceT)
  try {
    const found = checked.selected.get(prefix + PERSISTENT_TAB_PROOF_V2_PREFIX + intent.invitationId)
    if (!found || found.proof.binding.operation !== intent.proof) hold()
    const proof = found.proof, bound = proof.binding, owner = intent.keep ? b : t, zero = '0'.repeat(64)
    const credential = { kind: 20460, created_at: intent.issuedAt, tags: [['d', intent.roomId], ['device', intent.device],
      ['expiration', String(intent.expiresAt)], ['seal', zero]], content: '', pubkey: intent.participant, id: zero, sig: zero + zero }
    const signed = JSON.stringify(credential), seals = owner.get(prefix + OWN_SEAL_PREFIX + intent.roomId)
    if (seals === undefined) hold()
    const retained = JSON.parse(seals) as string[], pruned = retained.length < 128 ? retained : retained.slice(-127)
    owner.set(prefix + OWN_CREDENTIAL_PREFIX + intent.roomId, signed)
    owner.set(prefix + OWN_SEAL_PREFIX + intent.roomId, JSON.stringify([...pruned, zero]))
    const candidate = { ...proof, binding: { ...bound, device: { ...bound.device, credentialIds: [zero], credentials: [signed], seals: [zero], recordsHash: zero }, operation: zero } }
    const candidateRaw = JSON.stringify(candidate)
    if (intent.keep) b.set(persistentProofName(candidate.binding), candidateRaw)
    t.set(persistentTabProofName(candidate.binding), tabProofBytes(candidate))
    const sorted = (values: ReadonlyMap<string, unknown>) => [...values].sort(([a], [c]) => a < c ? -1 : a > c ? 1 : 0)
    const imageSource = (image: OrdinaryImage) => [image.purpose, image.expiresAt, image.generation, image.revision, sorted(image.fences), sorted(image.records)]
    const source = { browserRevision: predecessor[0].revision, tabRevision: predecessor[1].revision,
      hash: memberLeaseDigest(['kithmoot/member-lease/v1/source', 1, imageSource(predecessor[0]), imageSource(predecessor[1])]) }
    const oldCredential = ordinaryMemberLeaseCredential(proof, intent.credential), leaseName = ordinaryMemberLeaseName(bound), priorRaw = sourceT.get(leaseName)
    const prior = priorRaw === undefined ? undefined : readOrdinaryMemberLease(priorRaw, JSON.stringify(proof))
    const previous = prior?.header ?? makeOrdinaryMemberLeaseHeader({ sequence: 0, bootstrap: bound.operation, predecessor: null, proof: bound.operation,
      credential: oldCredential.id, seal: credentialSeal(oldCredential)!, issuedAt: oldCredential.created_at, expiresAt: Number(oldCredential.tags[2]![1]), authority: intent.authority, source })
    const leaseRaw = JSON.stringify({ version: 1, domain: 'kithmoot/member-lease/v1', header: { sequence: previous.sequence + 1, bootstrap: previous.bootstrap,
      predecessor: previous.operation, proof: zero, credential: zero, seal: zero, issuedAt: intent.issuedAt, expiresAt: intent.expiresAt,
      authority: intent.authority, source, operation: zero }, bootstrapProof: prior?.bootstrapProof ?? JSON.stringify(proof),
      predecessorProof: JSON.stringify(proof), predecessorHeader: previous })
    t.set(leaseName, leaseRaw); if (intent.keep) b.set(leaseName, leaseRaw)
    const marker = ordinaryOperationNames(enrolled[1].purpose).marker
    for (const [records, image] of [[b, enrolled[0]], [t, enrolled[1]]] as const) {
      const value = image.records.get(marker); if (value === undefined) hold(); records.set(marker, value)
    }
    return Object.freeze([ordinaryImageByteLength({ ...enrolled[0], revision: enrolled[0].revision + 1, records: b }),
      ordinaryImageByteLength({ ...enrolled[1], revision: enrolled[1].revision + 1, records: t })])
  } finally { checked.close(); b.clear(); t.clear() }
}
