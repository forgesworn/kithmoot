import type { DeviceCredential } from '../../src/types.js'
import { credentialSeal } from '../../src/seal.js'
import type { DeviceStore } from './device-store.js'
import { OWN_CREDENTIAL_PREFIX } from './device-store.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { ordinaryPairReadCustodyFor, type OrdinaryPairCustody } from './ordinary-state-owner.js'
import { captureOrdinarySnapshotContext, validateOrdinarySnapshot } from './ordinary-snapshot.js'
import { OrdinaryForegroundSigner } from './ordinary-foreground-signer.js'
import { readPersistentAdmissionProof, persistentProofName, persistentTabProofName, tabProofBytes, accountPrefix,
  type VerifiedPersistentProof } from './persistent-admission-proof.js'
import { ordinaryMemberLeaseSource, ordinaryMemberLeaseName, ordinaryMemberLeaseCredential, makeOrdinaryMemberLeaseHeader,
  readOrdinaryMemberLease, type OrdinaryMemberAuthority, type OrdinaryMemberLeaseHeaderBody } from './ordinary-member-lease.js'

function hold(): never { throw new OrdinaryStateHold() }
const records = (store: DeviceStore) => new Map(store.keys().map(name => [name, store.get(name)!]))
/** Pure, native-input preparation only. No entropy, signer invocation or write
 * runs here. A producer still owes pre-entropy capacity, exact-image CAS, ACK
 * reconciliation and the guarded Session handoff before enabling renewal. */
export function makeOrdinaryMemberLease(browser: DeviceStore, tab: DeviceStore, token: OrdinaryPairCustody,
  input: { readonly predecessorProof: string; readonly currentProof: string; readonly identity?: OrdinaryForegroundSigner }): string {
  const predecessor = readPersistentAdmissionProof(input.predecessorProof)
  let current: VerifiedPersistentProof | undefined
  const b = records(browser), t = records(tab)
  try {
    current = readPersistentAdmissionProof(input.currentProof)
    const old = predecessor.proof, name = ordinaryMemberLeaseName(old.binding), priorRaw = tab.get(name)
    const headers = ordinaryPairReadCustodyFor(token, b, t)
    validateOrdinarySnapshot(b, t, { browser: true, tab: true }, captureOrdinarySnapshotContext(b, t, token))
    if (old.version !== 2 || tab.get(persistentTabProofName(old.binding)) !== tabProofBytes(old) ||
        old.kept.enabled && browser.get(persistentProofName(old.binding)) !== input.predecessorProof ||
        !old.kept.enabled && browser.get(name) !== null || old.kept.enabled && browser.get(name) !== priorRaw ||
        old.binding.browser.generation !== headers.browser.generation || old.binding.tab.generation !== headers.tab.generation ||
        old.binding.tab.purpose !== headers.tab.purpose || old.binding.tab.expiresAt !== headers.tab.expiresAt ||
        old.binding.browser.fence !== (headers.browser.fences.get(old.binding.browser.name) ?? 0) ||
        old.binding.tab.fence !== (headers.tab.fences.get(old.binding.tab.name) ?? 0)) hold()
    let foregroundExpiresAt: number | null = null
    if (old.binding.account !== null) {
      if (!input.identity || input.identity.pubkey !== old.binding.account) hold()
      foregroundExpiresAt = OrdinaryForegroundSigner.nativeDeadline(input.identity, browser, tab, token, old.binding.account)
    } else if (input.identity !== undefined) hold()
    // Repeat after current SDK selectors, which may synchronously revoke.
    const source = ordinaryMemberLeaseSource(browser, tab, token)
    const immutable: OrdinaryMemberAuthority = { tabExpiresAt: headers.tab.expiresAt, admissionEndsAt: old.selection.endsAt,
      foregroundExpiresAt, membershipEndsAt: null }
    const selected = (old.kept.enabled ? browser : tab).get(accountPrefix(old.binding.participant) + OWN_CREDENTIAL_PREFIX + old.binding.roomId)
    if (selected === null) hold()
    const oldCredential = JSON.parse(selected) as DeviceCredential
    ordinaryMemberLeaseCredential(old, oldCredential.id)
    const prior = priorRaw === null ? undefined : readOrdinaryMemberLease(priorRaw, input.predecessorProof)
    if (prior && (prior.header.credential !== oldCredential.id || JSON.stringify(prior.header.authority) !== JSON.stringify(immutable))) hold()
    const priorBody: OrdinaryMemberLeaseHeaderBody = { sequence: 0, bootstrap: old.binding.operation, predecessor: null, proof: old.binding.operation,
      credential: oldCredential.id, seal: credentialSeal(oldCredential)!, issuedAt: oldCredential.created_at,
      expiresAt: Number(oldCredential.tags[2]![1]), authority: immutable, source }
    const previous = prior?.header ?? makeOrdinaryMemberLeaseHeader(priorBody)
    const oldEvents = new Set(old.binding.device.credentials)
    const next = current.proof.binding.device.credentials.filter(raw => !oldEvents.has(raw)).map(raw => JSON.parse(raw) as DeviceCredential)
    if (next.length !== 1 || !Number.isSafeInteger(previous.sequence + 1)) hold()
    const event = next[0]!, body: OrdinaryMemberLeaseHeaderBody = { sequence: previous.sequence + 1, bootstrap: previous.bootstrap, predecessor: previous.operation,
      proof: current.proof.binding.operation, credential: event.id, seal: credentialSeal(event)!, issuedAt: event.created_at,
      expiresAt: Number(event.tags.find(tag => tag[0] === 'expiration')?.[1]), authority: immutable, source }
    const raw = JSON.stringify({ version: 1, domain: 'kithmoot/member-lease/v1', header: makeOrdinaryMemberLeaseHeader(body),
      bootstrapProof: prior?.bootstrapProof ?? input.predecessorProof, predecessorProof: input.predecessorProof, predecessorHeader: previous })
    readOrdinaryMemberLease(raw, input.currentProof)
    return raw
  } finally { b.clear(); t.clear(); predecessor.admission.secret.fill(0); current?.admission.secret.fill(0) }
}
