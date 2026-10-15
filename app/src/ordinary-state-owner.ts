import { OrdinaryForegroundSigner, openOrdinaryPrivateForegroundFromOwnerClaim,
  type OrdinaryPrivateForegroundResource } from './ordinary-foreground-signer.js'
import { claimOrdinaryPrivateExistingRoot, type OrdinaryPrivateExistingRoot,
  type OrdinaryPrivateExistingRootBinding } from './ordinary-private-existing-root.js'
import { captureOrdinaryForegroundProof } from './ordinary-foreground-signer.js'
import { HEADLESS_NIP07_DISCOVERY_BOUNDARY, createNip07SignerWithDiscoveryBoundary, createPinnedNip07SignerWithDiscoveryBoundary, createSessionFromSigner,
  type SignetSession, type SignetSigner, type SignetAuthEvent, type SignerEffectBoundary, type Nip07DiscoveryBoundary } from 'signet-login'
import { captureOrdinaryFreshAccountProof } from './ordinary-fresh-account-proof.js'
import { ORDINARY_SIGNET_KEYS } from './ordinary-signet-snapshot.js'
import { ORDINARY_INITIAL_LOGIN_KEY } from './ordinary-initial-login-snapshot.js'
import { takeOrdinaryPreparedExtensionFactory, checkOrdinaryPreparedExtensionPromise, type OrdinaryPreparedExtensionFactory } from './ordinary-prepared-extension-factory.js'
import { registerOrdinaryRenewalSigningLifetime,registerOrdinaryRenewalSigningAttempt,releaseOrdinaryRenewalSigningLifetime,type OrdinaryRenewalSigningLifetime } from './ordinary-renewal-signing-bridge.js'
import { parseRoomLink } from '../../src/link.js'
import { verifyEventUncached } from '../../src/verify.js'
import { takeOrdinaryColdExtensionFactory, checkOrdinaryColdExtensionPromise, type OrdinaryColdExtensionFactory } from './ordinary-cold-extension-factory.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2'
import type { OrdinaryRenewalObligation } from './ordinary-renewal-obligation.js'
import type { OrdinaryPreparedRenewalFactory, OrdinaryRenewalIntent } from './ordinary-renewal-obligation.js'
import { takeOrdinaryPreparedFactory, checkOrdinaryPreparedFactoryPromise } from './ordinary-renewal-obligation.js'
import { takeOrdinaryPreparedSigningObligation, checkOrdinaryRenewalSigningObligation } from './ordinary-renewal-obligation.js'
import type { ProtocolExecution } from '../../src/protocol-execution.js'
import { getPublicKey } from 'nostr-tools/pure'
import type { DeviceStore } from './device-store.js'
import { ORDINARY_OPERATION_CONTROL_PREFIX, openOrdinaryOperationClassification, openOrdinaryOperationControl,
  ordinaryOperationNames, ordinaryOperationMarker, ordinaryOperationCommitment, ordinaryOperationControlDigest, ordinaryFrameDigest, ordinaryOperationSemanticDigest, validateOrdinaryOperationMarker, validateOrdinaryOperationControl, sealOrdinaryOperationControl, encodeOrdinaryOperationJournal, decodeOrdinaryOperationClassification,
  type OrdinaryOperationJournal, type OrdinaryOperationClassification, type OrdinaryOperationControl } from './ordinary-operation-codec.js'
import { OrdinaryStateHold, ordinaryImageByteLength, encodeOrdinaryImage, openOrdinaryFrame, sealOrdinaryImage, sameOrdinaryFrame,
  validateOrdinaryFrame, validateOrdinaryKey, type OrdinaryFrame, type OrdinaryImage,
  type OrdinaryPurpose, type OrdinaryMigration } from './ordinary-state-codec.js'

import { ORDINARY_DATABASE, ORDINARY_WRITE_LOCK as WRITE_LOCK } from './ordinary-state-layout.js'
export { ORDINARY_DATABASE } from './ordinary-state-layout.js'
const OWNER_STORE = 'owners'
export const MAX_ORDINARY_TAB_OWNERS = 64
const TAB_PURPOSE = /^tab:[0-9a-f]{64}$/
/** Resource only. No owner, frame, key, selection or current authority escapes. */
export interface OrdinaryPrivateExistingCaptureResource {
  readonly completed: Promise<void>
  stop(): void
  close(): Promise<void>
}
interface PrivateExistingSelection {
  readonly account: string
  readonly participant: string
  readonly invitationId: string
  readonly roomId: string
  readonly link: string
  readonly keep: boolean
  readonly credentialExpiresAt: number
  readonly bootstrapCredentialExpiresAt: number
  readonly proofOperation: string
  readonly memberLeaseOperation: string | null
}
interface PrivateExistingCapture {
  readonly token: object
  readonly root: OrdinaryPrivateExistingRoot
  readonly binding: OrdinaryPrivateExistingRootBinding
  readonly browser: OrdinaryStateOwner
  readonly tab: OrdinaryStateOwner
  readonly purpose: OrdinaryPurpose
  readonly expiresAt: number
  readonly rows: readonly [string, string]
  readonly revisions: readonly [number, number]
  readonly generations: readonly [string, string]
  readonly classification: string
  readonly selection: Readonly<PrivateExistingSelection>
  consumed: boolean
}
const privateExistingCaptures = new WeakMap<object, PrivateExistingCapture>()
interface PrivateExistingProvider {
  readonly capture: PrivateExistingCapture
  readonly source: Readonly<SignetSession>
  readonly beginControl: () => void
  readonly controlLive: () => void
  // These native operations never escape the owner module. The eventual
  // explicit member action consumes this entry before using them; discovery
  // and restore do not invoke fresh account authentication.
  readonly freshControl: (start?: () => void) => Promise<void>
  readonly constructForeground: (construct: () => void) => Promise<void>
  readonly assertForegroundProvider: () => void
  readonly trackControl: <T>(pending: Promise<T>) => Promise<T>
  readonly stop: () => void
  consumed: boolean
  foregroundStarted: boolean
  foregroundClaimed: boolean
  foreground: OrdinaryPrivateForegroundResource | undefined
}
const privateExistingProviders = new WeakMap<object, PrivateExistingProvider>()
declare const foregroundClaimBrand: unique symbol
export interface OrdinaryPrivateForegroundClaim { readonly [foregroundClaimBrand]: true }
/** This binding is unpacked only by the fixed foreground module. No caller
 * receives its root, owners, source or closed native operations. */
interface PrivateForegroundBinding {
  readonly browser: OrdinaryStateOwner
  readonly tab: OrdinaryStateOwner
  readonly source: Readonly<SignetSession>
  readonly generation: number
  readonly live: () => boolean
  readonly stop: () => void
  readonly assertClientsCurrent: () => Promise<void>
  readonly captureForegroundScopes: () => Promise<readonly [OrdinaryScope, OrdinaryScope]>
  readonly constructForeground: (construct: () => void) => Promise<void>
  readonly readForeground: <T>(live: () => boolean,
    work: (browser: DeviceStore, tab: DeviceStore, custody: OrdinaryPairCustody) => T) => Promise<T>
  readonly joinForeground: <T>(pending: Promise<T>) => Promise<T>
  readonly assertForegroundProvider: () => void
}
const privateForegroundClaims = new WeakMap<object, Readonly<{
  provider: PrivateExistingProvider; binding: PrivateForegroundBinding
}>>()
/** Fixed component-internal take. A claim never leaves the owner's direct
 * call into the foreground module; consume it before reflection or an await. */
export function takeOrdinaryPrivateForegroundClaim(claim: OrdinaryPrivateForegroundClaim): PrivateForegroundBinding {
  const value = privateForegroundClaims.get(claim)
  if (!value) hold()
  privateForegroundClaims.delete(claim)
  if (!value.provider.foregroundClaimed) hold()
  value.provider.controlLive()
  return value.binding
}
let beginPrivateExistingProvider!: (root: OrdinaryPrivateExistingRoot) => OrdinaryPrivateExistingCaptureResource
/** Fixed private-root consumer only; no account, owner or provider input. */
export const beginOrdinaryPrivateExistingProvider = (root: OrdinaryPrivateExistingRoot): OrdinaryPrivateExistingCaptureResource => beginPrivateExistingProvider(root)

let beginPrivateExistingCapture!: (root: OrdinaryPrivateExistingRoot) => OrdinaryPrivateExistingCaptureResource
/** The lexical bridge is installed by the class's static block. Callers cannot
 * replace a public class method to intercept the actual private root. */
export const beginOrdinaryPrivateExistingCapture = (root: OrdinaryPrivateExistingRoot): OrdinaryPrivateExistingCaptureResource => beginPrivateExistingCapture(root)
export interface OrdinaryScope {
  readonly name: string
  readonly generation: string
  readonly fence: number
}
export interface OrdinaryPairMutation<T> {
  readonly browser: { readonly owner: OrdinaryStateOwner; readonly scope: OrdinaryScope }
  readonly tab: { readonly owner: OrdinaryStateOwner; readonly scope: OrdinaryScope }
  readonly live: () => boolean
  readonly work: (browser: DeviceStore, tab: DeviceStore,
    browserMigratedNames: readonly string[], tabMigratedNames: readonly string[], custody: OrdinaryPairCustody) => T
}
export type OrdinaryPairPrewrite = (browser: Pick<DeviceStore, 'get' | 'keys'>, tab: Pick<DeviceStore, 'get' | 'keys'>,
  browserMigratedNames: readonly string[], tabMigratedNames: readonly string[], custody: OrdinaryPairCustody) => void
/** A private producer's validation-only last check, after native authentication
 * and immediately before the two puts. It must perform no effect or asynchronous
 * work. Its readonly views contain acknowledged predecessor records only. */
export interface OrdinaryPairCommitInput extends OrdinaryPairMutation<void> {
  readonly beforeWrite: OrdinaryPairPrewrite
}
declare const pairCommitBrand: unique symbol
export interface OrdinaryPairCommitReceipt { readonly [pairCommitBrand]: true }
/** Custody facts only. Neither result grants permission to mint or adopt. */
export type OrdinaryPairCommitOutcome = Readonly<
  { status: 'committed'; receipt: OrdinaryPairCommitReceipt } | { status: 'definite-abort' }>
declare const pairCustodyBrand: unique symbol
export interface OrdinaryPairCustody { readonly [pairCustodyBrand]: true }
interface PairHeader { purpose: OrdinaryPurpose; expiresAt: number; generation: string; revision: number; fences: ReadonlyMap<string, number> }
const pairCustody = new WeakMap<object, { kind:'read'|'mutation'|'historical-cleanup'; browser: OrdinaryImage; tab: OrdinaryImage; browserOwner: OrdinaryStateOwner; tabOwner: OrdinaryStateOwner; browserStore: DeviceStore; tabStore: DeviceStore; browserScope: OrdinaryScope; tabScope: OrdinaryScope; rows?: readonly [Row, Row]; operationMarkers?: readonly [ReadonlyMap<string,string>, ReadonlyMap<string,string>] }>()
declare const renewalEnrollmentBrand:unique symbol
export interface OrdinaryRenewalEnrollment {readonly [renewalEnrollmentBrand]:true}
export type OrdinaryRenewalEnrollmentOutcome=Readonly<{status:'enrolled';enrollment:OrdinaryRenewalEnrollment}|{status:'definite-abort'}>
/** Storage disposition only. Ordinary reads/effects still owe their native
 * barrier and current role; active phases grant no continuation capability. */
export interface OrdinaryRenewalStartupDisposition {
  readonly status:'empty'|'ordinary'|'recovery-required'
  readonly operations:readonly Readonly<{tab:`tab:${string}`;id:string;sequence:number;phase:OrdinaryOperationJournal['phase']}>[]
}
interface PreparedRenewalTarget {
  readonly purpose:`tab:${string}`
  readonly rows:readonly [string,string]
  readonly controlDigest:string
  readonly header:OrdinaryOperationClassification
}
const renewalEnrollments=new WeakMap<object,Readonly<{obligation:OrdinaryRenewalObligation;request:string;target:PreparedRenewalTarget;classification:OperationClassification;held:ReturnType<typeof import('./ordinary-renewal-obligation.js').takeOrdinaryRenewalObligation>}>>()
const consumedRenewalEnrollments=new WeakSet<object>()
declare const preparedWitnessBrand: unique symbol
export interface OrdinaryPreparedRenewalWitness { readonly [preparedWitnessBrand]: true }
declare const preparedCustodyBrand: unique symbol
export interface OrdinaryPreparedRenewalCustody { readonly [preparedCustodyBrand]: true }
interface PreparedWitness {
  readonly preparation: OrdinaryPreparedRenewalFactory
  readonly root: ProtocolExecution
  readonly browser: OrdinaryStateOwner
  readonly tab: OrdinaryStateOwner
  readonly request: string
  readonly intent: OrdinaryRenewalIntent
  readonly browserScope: OrdinaryScope
  readonly tabScope: OrdinaryScope
  readonly target: PreparedRenewalTarget
  readonly classification: OperationClassification
  claimed: boolean
  signed: boolean
}
const preparedWitnesses = new WeakMap<object, PreparedWitness>()
const preparedCustodies = new WeakMap<object, Readonly<{
  browser: OrdinaryStateOwner; tab: OrdinaryStateOwner; browserStore: DeviceStore; tabStore: DeviceStore; root: ProtocolExecution; check(): void
}>>()
/** Purpose-specific, callback-local E facts. This is never PairReadCU and is
 * not registered in the ordinary read/mutation/resource custody registry. */
export function ordinaryPreparedRenewalCustodyFor(token: OrdinaryPreparedRenewalCustody, browser: DeviceStore, tab: DeviceStore,
  browserOwner: OrdinaryStateOwner, tabOwner: OrdinaryStateOwner, root: ProtocolExecution): void {
  const value = preparedCustodies.get(token)
  if (!value || value.browserStore !== browser || value.tabStore !== tab || value.browser !== browserOwner || value.tab !== tabOwner || value.root !== root) hold()
  value.check()
}
declare const renewalReturnedBrand:unique symbol
export interface OrdinaryRenewalProviderReturned {readonly [renewalReturnedBrand]:true}
const renewalReturned=new WeakMap<object,Readonly<{enrollment:OrdinaryRenewalEnrollment;target:PreparedRenewalTarget;classification:OperationClassification;candidate:readonly [OrdinaryFrame,OrdinaryFrame]}>>()
const consumedRenewalReturned=new WeakSet<object>()
declare const renewalCommittedBrand:unique symbol
/** Custody receipt only. S settlement and current controller adoption remain
 * separate operations; this opaque handle supplies neither permission. */
export interface OrdinaryRenewalCandidateCommitted {readonly [renewalCommittedBrand]:true}
const renewalCommitted=new WeakMap<object,Readonly<{enrollment:OrdinaryRenewalEnrollment;target:PreparedRenewalTarget;classification:OperationClassification}>>()
const consumedRenewalCommitted=new WeakSet<object>()
declare const renewalSettledBrand:unique symbol
export interface OrdinaryRenewalSettled {readonly [renewalSettledBrand]:true}
const renewalSettled=new WeakMap<object,Readonly<{enrollment:OrdinaryRenewalEnrollment;target:PreparedRenewalTarget;classification:OperationClassification}>>()
const pairCommits = new WeakMap<object, {
  browser: { owner: OrdinaryStateOwner; scope: OrdinaryScope }
  tab: { owner: OrdinaryStateOwner; scope: OrdinaryScope }
  frames: readonly [OrdinaryFrame, OrdinaryFrame]
  state: 'available' | 'consuming' | 'consumed' | 'refused'
}>()
/** Only a live native pair callback can supply this opaque provenance. Exact
 * record matching prevents substituting a different image under its headers. */
export function ordinaryPairCustodyFor(token: OrdinaryPairCustody, browser: ReadonlyMap<string, string>, tab: ReadonlyMap<string, string>):
  { browser: PairHeader; tab: PairHeader } {
  const captured = pairCustody.get(token)
  if (!captured) hold()
  const header = (image: OrdinaryImage, store: DeviceStore, records: ReadonlyMap<string, string>): PairHeader => {
    const names = store.keys()
    if (records.size !== names.length || names.some(name => records.get(name) !== store.get(name))) hold()
    return { purpose: image.purpose, expiresAt: image.expiresAt, generation: image.generation, revision: image.revision, fences: new Map(image.fences) }
  }
  return { browser: header(captured.browser, captured.browserStore, browser), tab: header(captured.tab, captured.tabStore, tab) }
}
/** Historical composer headers only; structural kind checking grants no live
 * capability and exposes no token registration or mutation interface. */
export function ordinaryPairHistoricalCustodyFor(token: OrdinaryPairCustody, browser: ReadonlyMap<string,string>, tab: ReadonlyMap<string,string>) {
  if (pairCustody.get(token)?.kind !== 'historical-cleanup') hold()
  return ordinaryPairCustodyFor(token, browser, tab)
}
/** Marker custody only, from the same fully classified native read/write
 * projection. It neither exposes a control row nor advances any journal. */
export function ordinaryPairOperationMarkersFor(token: OrdinaryPairCustody, browser: ReadonlyMap<string,string>, tab: ReadonlyMap<string,string>):
  readonly [ReadonlyMap<string,string>, ReadonlyMap<string,string>] {
  ordinaryPairCustodyFor(token, browser, tab)
  const captured = pairCustody.get(token)
  if (!captured?.operationMarkers) hold()
  for (const [i, records] of [browser, tab].entries()) {
    const markers = [...records].filter(([name]) => name.startsWith('kithmoot.operation-journal'))
    if (markers.length !== captured.operationMarkers[i]!.size || markers.some(([name, raw]) => captured.operationMarkers![i]!.get(name) !== raw)) hold()
  }
  return [new Map(captured.operationMarkers[0]), new Map(captured.operationMarkers[1])]
}
/** Signing may consume only acknowledged input bytes from a read callback,
 * never a writable projection which has not yet acquired a native receipt. */
let validateReadPairCustody!: (token: OrdinaryPairCustody) => void
export function ordinaryPairReadCustodyFor(token:OrdinaryPairCustody,browser:ReadonlyMap<string,string>,tab:ReadonlyMap<string,string>) {
  const captured=pairCustody.get(token)
  if(captured?.kind!=='read')hold()
  validateReadPairCustody(token)
  return ordinaryPairCustodyFor(token,browser,tab)
}
/** Exact native P-image digest only. Raw records or a writable/historical
 * token cannot stand in for the acknowledged predecessor. It includes all
 * records, fences and migration fields, not just the selected room partition. */
export function ordinaryPairPredecessorSemanticDigestFor(token: OrdinaryPairCustody, browser: ReadonlyMap<string,string>,
  tab: ReadonlyMap<string,string>): string {
  ordinaryPairReadCustodyFor(token, browser, tab)
  const captured = pairCustody.get(token)!
  return ordinaryOperationSemanticDigest(captured.browser, captured.tab)
}
/** Fixed E/C/S capacity reservation only, under exact current read custody.
 * Marker placeholders are sizing data: no record, journal phase or writer
 * capability is minted. Full revision growth and a future settled commitment
 * are checked before seal/provider entropy. */
export function ordinaryPairRenewalByteLengths(token: OrdinaryPairCustody, browser: ReadonlyMap<string,string>, tab: ReadonlyMap<string,string>,
  proposed: { readonly browser: ReadonlyMap<string,string>; readonly tab: ReadonlyMap<string,string> }):
  Readonly<{ enrolled: readonly [number,number]; candidate: readonly [number,number]; settled: readonly [number,number] }> {
  ordinaryPairReadCustodyFor(token, browser, tab)
  // Retain the existing strict native-Map/data-descriptor input checks first.
  ordinaryPairProjectedByteLengths(token, browser, tab, proposed, true)
  const captured = pairCustody.get(token)!, purpose = captured.tab.purpose
  const candidateBrowser = new Map(Map.prototype.entries.call(Object.getOwnPropertyDescriptor(proposed,'browser')!.value)),
    candidateTab = new Map(Map.prototype.entries.call(Object.getOwnPropertyDescriptor(proposed,'tab')!.value))
  const name = ordinaryOperationNames(purpose).marker, id = '0'.repeat(64), sequence = Number.MAX_SAFE_INTEGER
  const size = (delta: 1|2|3): readonly [number,number] => {
    const result: number[] = []
    for (const [image, scope, input] of [[captured.browser,captured.browserScope,delta===1?captured.browser.records:candidateBrowser],
      [captured.tab,captured.tabScope,delta===1?captured.tab.records:candidateTab]] as const) {
      const records = new Map(input), fences = new Map(image.fences)
      try {
        records.set(name,ordinaryOperationMarker({id,tab:purpose as `tab:${string}`,sequence,commitment:delta===3?id:null}))
        if (!fences.has(scope.name)) fences.set(scope.name,scope.fence)
        result.push(ordinaryImageByteLength({...image,revision:image.revision+delta,records,fences}))
      } finally { records.clear(); fences.clear() }
    }
    return Object.freeze(result) as unknown as readonly [number,number]
  }
  try { return Object.freeze({enrolled:size(1),candidate:size(2),settled:size(3)}) }
  finally { candidateBrowser.clear(); candidateTab.clear() }
}
/** Capacity-only projection from a live authenticated pair callback. Exact
 * current bytes must still match the opaque token. The projected records do
 * not acquire semantic validity or mutation authority; no mutable image,
 * keyId, key or migration carrier escapes. Both revision+1 images are sized
 * before the caller starts first-use entropy or signing. */
export function ordinaryPairProjectedByteLengths(token: OrdinaryPairCustody, browser: ReadonlyMap<string, string>,
  tab: ReadonlyMap<string, string>, proposed: { readonly browser: ReadonlyMap<string, string>; readonly tab: ReadonlyMap<string, string> }, reserveScopes = false):
  Readonly<{ browser: number; tab: number }> {
  try {
    ordinaryPairCustodyFor(token, browser, tab)
    const captured = pairCustody.get(token)
    if (!captured || captured.kind === 'historical-cleanup' || typeof reserveScopes !== 'boolean' || !proposed || Object.getPrototypeOf(proposed) !== Object.prototype ||
        Reflect.ownKeys(proposed).sort().join(',') !== 'browser,tab') hold()
    const copy = (records: ReadonlyMap<string, string>) => {
      // Native Map brand, no thenable or callback-backed projection object.
      if (Reflect.ownKeys(records).length !== 0) hold()
      return new Map(Map.prototype.entries.call(records) as MapIterator<[string, string]>)
    }
    const data = (name: 'browser' | 'tab') => {
      const field = Object.getOwnPropertyDescriptor(proposed, name)
      if (!field || !Object.hasOwn(field, 'value')) hold()
      return copy(field.value as ReadonlyMap<string, string>)
    }
    const b = data('browser'), t = data('tab')
    try {
      const fences = (image: OrdinaryImage, scope: OrdinaryScope) => {
        const copy = new Map(image.fences)
        if (reserveScopes && !copy.has(scope.name)) copy.set(scope.name, scope.fence)
        return copy
      }
      const first = ordinaryImageByteLength({ ...captured.browser, revision: captured.browser.revision + 1, records: b,
        fences: fences(captured.browser, captured.browserScope) })
      const second = ordinaryImageByteLength({ ...captured.tab, revision: captured.tab.revision + 1, records: t,
        fences: fences(captured.tab, captured.tabScope) })
      return Object.freeze({ browser: first, tab: second })
    } finally { b.clear(); t.clear() }
  } catch { return hold() }
}
interface Row { key: CryptoKey; frame?: OrdinaryFrame; pending?: OrdinaryFrame }
interface OperationClassification {
  readonly owners: readonly (readonly [string, string])[]
  readonly controls: readonly (readonly [string, string])[]
  readonly markers: readonly (readonly [string, string])[]
}
interface OperationTransaction {
  readonly tx: IDBTransaction
  readonly store: IDBObjectStore
  readonly ended: Promise<void>
  read<T>(work: () => IDBRequest<T>): Promise<T>
  step(work: () => void): Promise<void>
  stop(): void
  abort(): void
}
function rowDigest(value: Row): string {
  return JSON.stringify([value.frame ? ordinaryFrameDigest(value.frame) : null, value.pending ? ordinaryFrameDigest(value.pending) : null])
}
function operationTransaction(db: IDBDatabase, mode: IDBTransactionMode): OperationTransaction {
  const tx = db.transaction(OWNER_STORE, mode), store = tx.objectStore(OWNER_STORE), ended = settled(tx)
  void ended.catch(() => {})
  let done = false
  const queue: { run(): void; fail(): void }[] = []
  const stop = () => { done = true; for (const entry of queue.splice(0)) entry.fail() }
  const abort = () => { stop(); try { tx.abort() } catch {} }
  tx.addEventListener('abort', stop); tx.addEventListener('complete', stop)
  const keepAlive = () => {
    if (done) return
    let request: IDBRequest<IDBValidKey | undefined>
    try { request = store.getKey('browser') } catch { abort(); return }
    request.onerror = abort
    request.onsuccess = () => {
      if (done) return
      for (const entry of queue.splice(0)) entry.run()
      keepAlive()
    }
  }
  keepAlive()
  return {
    tx, store, ended, stop, abort,
    read: <T>(work: () => IDBRequest<T>) => new Promise<T>((resolve, reject) => {
      if (done) { reject(new OrdinaryStateHold()); return }
      queue.push({ run: () => { try { const r = work(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(new OrdinaryStateHold()) }
        catch { reject(new OrdinaryStateHold()) } }, fail: () => reject(new OrdinaryStateHold()) })
    }),
    step: work => new Promise<void>((resolve, reject) => {
      if (done) { reject(new OrdinaryStateHold()); return }
      queue.push({ run: () => { try { work(); resolve() } catch { reject(new OrdinaryStateHold()) } }, fail: () => reject(new OrdinaryStateHold()) })
    }),
  }
}
class DefiniteAbort extends Error {}
interface Snapshot { db: IDBDatabase; row?: Row; image?: OrdinaryImage }
function hold(): never { throw new OrdinaryStateHold() }
const random = () => [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('')
function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
}
function settled(tx: IDBTransaction, aborted?: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => { aborted?.(); reject(tx.error ?? new OrdinaryStateHold()) }
    // Only abort is terminal failure: an individual request error can still
    // be prevented by the browser and is not proof that commit was impossible.
  })
}
function row(raw: unknown): Row | undefined {
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== 'object' || Object.getPrototypeOf(raw) !== Object.prototype ||
      !['frame,key', 'key,pending', 'frame,key,pending'].includes(Object.keys(raw).sort().join(','))) hold()
  const value = raw as Row
  return { key: validateOrdinaryKey(value.key),
    ...(Object.hasOwn(raw, 'frame') ? { frame: validateOrdinaryFrame(value.frame) } : {}),
    ...(Object.hasOwn(raw, 'pending') ? { pending: validateOrdinaryFrame(value.pending) } : {}) }
}
function sameRow(a?: Row, b?: Row): boolean {
  return !!a === !!b && sameOrdinaryFrame(a?.frame, b?.frame) && sameOrdinaryFrame(a?.pending, b?.pending)
}
function copyImage(image: OrdinaryImage): OrdinaryImage {
  return { ...image, records: new Map(image.records), fences: new Map(image.fences),
    ...(image.migration ? { migration: { ...image.migration, sources: new Map(image.migration.sources), names: [...image.migration.names] } } : {}) }
}
function clearImage(image?: OrdinaryImage): void {
  if (!image) return
  ;(image.records as Map<string, string>).clear()
  ;(image.fences as Map<string, number>).clear()
  if (image.migration) {
    ;(image.migration.sources as Map<string, string>).clear()
    ;(image.migration.names as string[]).length = 0
  }
}
function preserveOperationMarkers(previous: ReadonlyMap<string, string>, candidate: ReadonlyMap<string, string>): void {
  const selected = (records: ReadonlyMap<string, string>) => [...records].filter(([name]) => name.startsWith('kithmoot.operation-journal'))
  const first = selected(previous), second = selected(candidate)
  if (first.length !== second.length || first.some(([name, raw]) => candidate.get(name) !== raw)) hold()
}
/** A private synchronous helper view; escaping it cannot write after the call. */
function view(records: Map<string, string>, writable: boolean): { store: DeviceStore; close(): void } {
  let active = true
  const check = () => { if (!active) hold() }
  return {
    store: Object.freeze<DeviceStore>({
      get: name => { check(); return records.get(name) ?? null },
      keys: () => { check(); return [...records.keys()] },
      set: (name, value) => { check(); if (!writable) hold(); records.set(name, value) },
      remove: name => { check(); if (!writable) hold(); records.delete(name) },
    }),
    close: () => { active = false; records.clear() },
  }
}

/** Native origin-local encrypted custody. The app must supply a live foreground
 * guard and finish legacy/client fencing before admitting effects. This class
 * alone is neither membership authority nor independent rollback resistance. */
export class OrdinaryStateOwner {
  #db?: IDBDatabase
  #generation?: string
  #closed = false
  #work = new Set<Promise<unknown>>()
  #resources = new Set<{ stop(): void }>()
  #retry?: () => void
  #operationControls = new Set<string>()
  #operationMarkerValues = new Map<string,string>()
  #operationControlDigests = new Map<string,string>()
  /** An unknown native result keeps both the exact candidate and Web Lock. */
  get holdingRetention(): boolean { return this.#retry !== undefined }
  retryRetention(): void { this.#retry?.() }
  #custodyCheck(live: () => boolean, reconciling: boolean): void {
    if (reconciling) { if (!live()) hold() }
    else this.#check(live)
  }
  constructor(readonly purpose: OrdinaryPurpose = 'browser', readonly expiresAt = 0) {
    // These identities are immutable at runtime too. An accessor cannot run
    // between the final native check and a put argument.
    Object.defineProperties(this, { purpose: { value: purpose, enumerable: true, writable: false, configurable: false },
      expiresAt: { value: expiresAt, enumerable: true, writable: false, configurable: false } })
  }
  #check(live: () => boolean, expiredCleanup = false): void {
    if (this.#closed) hold()
    const selected = live()
    if (this.#closed || selected !== true || !expiredCleanup && this.purpose !== 'browser' && Date.now() >= this.expiresAt) hold()
  }
  #track<T>(work: Promise<T>): Promise<T> {
    this.#work.add(work)
    void work.finally(() => this.#work.delete(work)).catch(() => {})
    return work
  }
  /** Resource ownership only: this does not authorise the operation or expose
   * a native image. Register before its first continuation so closing either
   * lifetime joins borrowed provider/deferred work after revoking storage.
   * An operation must never await the close which is joining that same work. */
  static joinPairLifetime<T>(browser: OrdinaryStateOwner, tab: OrdinaryStateOwner, operation: Promise<T>, revoke?: () => void): Promise<T> {
    return OrdinaryStateOwner.#joinPairLifetime(browser, tab, operation, revoke)
  }
  static #joinPairLifetime<T>(browser: OrdinaryStateOwner, tab: OrdinaryStateOwner, operation: Promise<T>, revoke?: () => void): Promise<T> {
    if (typeof browser !== 'object' || browser === null || !(#work in browser) ||
        typeof tab !== 'object' || tab === null || !(#work in tab) || browser === tab ||
        browser.purpose !== 'browser' || !TAB_PURPOSE.test(tab.purpose) || !(operation instanceof Promise)) hold()
    if (revoke !== undefined && typeof revoke !== 'function') hold()
    browser.#track(operation); tab.#track(operation)
    if (revoke) {
      // A startup may own neutral recovery before any current read exists.
      // This callback revokes its lifetime only; it grants no native custody
      // or permission to invoke a provider, and never joins from itself.
      let active = true
      const release = () => { active = false; browser.#resources.delete(resource); tab.#resources.delete(resource) }
      const resource = { stop: () => { if (!active) return; release(); try { revoke() } catch { /* operation remains joined */ } } }
      browser.#resources.add(resource); tab.#resources.add(resource)
      void operation.finally(release).catch(() => {})
      if (browser.#closed || tab.#closed) resource.stop()
    }
    return operation
  }
  /** Retain an already-authorised resource on both exact native lifetimes.
   * Only a current read can register it. Closing either owner, database
   * invalidation or the tab deadline revokes synchronously, then joins cleanup.
   * Registration supplies no permission to sign, dial, read or mutate. */
  static retainPairResource(custody: OrdinaryPairCustody,
    binding: Pick<OrdinaryPairMutation<unknown>, 'browser' | 'tab' | 'live'>,
    callbacks: { readonly revoke: () => void; readonly join: () => Promise<void> }): () => void {
    if (pairCustody.get(custody)?.kind !== 'read') hold()
    const captured = { browser: { owner: binding.browser.owner, scope: { ...binding.browser.scope } },
      tab: { owner: binding.tab.owner, scope: { ...binding.tab.scope } }, live: binding.live }
    OrdinaryStateOwner.#validatePairBinding(custody, captured)
    const browser = captured.browser.owner, tab = captured.tab.owner, revoke = callbacks.revoke, join = callbacks.join
    if (typeof revoke !== 'function' || typeof join !== 'function') hold()
    let active = true, timer: ReturnType<typeof setTimeout>
    const release = () => {
      if (!active) return false
      active = false; clearTimeout(timer); browser.#resources.delete(resource); tab.#resources.delete(resource)
      return true
    }
    const resource = { stop: () => {
      if (!release()) return
      try { revoke() } catch { /* join still owns cleanup */ }
      const cleanup = Promise.resolve().then(join)
      browser.#track(cleanup); tab.#track(cleanup); void cleanup.catch(() => {})
    } }
    const expire = () => {
      if (!active) return
      if (Date.now() >= tab.expiresAt) resource.stop()
      else timer = setTimeout(expire, Math.min(2_147_483_647, Math.max(1, tab.expiresAt - Date.now())))
    }
    // Callback getters above may revoke an owner. Recheck before retaining.
    OrdinaryStateOwner.#validatePairBinding(custody, captured)
    browser.#resources.add(resource); tab.#resources.add(resource)
    timer = setTimeout(expire, Math.min(2_147_483_647, Math.max(1, tab.expiresAt - Date.now())))
    return () => { release() }
  }
  #revoke(): void {
    this.#closed = true
    for (const resource of [...this.#resources]) resource.stop()
    this.#resources.clear()
  }
  /** Fixed renewal predecessor metadata only, from this actual current read.
   * The encrypted frames never escape; their digests freeze the original P
   * transaction independently of later semantic reconstruction. */
  static captureRenewalPredecessor(custody: OrdinaryPairCustody): Readonly<{
    frames:readonly [string,string]; controlDigest:string|null; markers:readonly [string|null,string|null]
  }> {
    const captured=pairCustody.get(custody)
    if(captured?.kind!=='read'||!captured.rows)hold()
    const b=new Map(captured.browserStore.keys().map(n=>[n,captured.browserStore.get(n)!])),
      t=new Map(captured.tabStore.keys().map(n=>[n,captured.tabStore.get(n)!]))
    try {
      ordinaryPairReadCustodyFor(custody,b,t)
      const name=ordinaryOperationNames(captured.tab.purpose),controlDigest=captured.browserOwner.#operationControlDigests.get(name.control)??null
      const markers=[b.get(name.marker)??null,t.get(name.marker)??null] as const
      if(markers[0]!==markers[1]||(controlDigest===null)!==(markers[0]===null)||captured.rows.some(row=>!row.frame||row.pending))hold()
      return Object.freeze({frames:Object.freeze(captured.rows.map(row=>ordinaryFrameDigest(row.frame!))) as unknown as readonly [string,string],
        controlDigest,markers:Object.freeze(markers)})
    } finally { b.clear();t.clear() }
  }
  /** Reuse a genuine current pair read for another native component's scopes.
   * Exact owner instances and their live lifetimes are required; matching rows
   * or caller-supplied generation strings cannot substitute for provenance.
   * This synchronous restriction neither starts a read nor exports an image. */
  static validatePairBinding(custody: OrdinaryPairCustody,
    input: Pick<OrdinaryPairMutation<unknown>, 'browser' | 'tab' | 'live'>): void {
    OrdinaryStateOwner.#validatePairBinding(custody, input)
  }
  static #validatePairBinding(custody: OrdinaryPairCustody,
    input: Pick<OrdinaryPairMutation<unknown>, 'browser' | 'tab' | 'live'>): void {
    const browser=input.browser.owner,tab=input.tab.owner,
      browserScope={...input.browser.scope},tabScope={...input.tab.scope},live=input.live
    const captured=pairCustody.get(custody)
    if(!captured||captured.kind==='historical-cleanup'||captured.browserOwner!==browser||captured.tabOwner!==tab||browser===tab||
      typeof browser!=='object'||browser===null||!(#closed in browser)||
      typeof tab!=='object'||tab===null||!(#closed in tab)||typeof live!=='function')hold()
    // Invoke the trusted selector before the final lifetime checks: it may
    // synchronously close an owner while still returning true.
    const selected = live(), now = Date.now()
    if(selected!==true||browser.#closed||tab.#closed||browser.#retry||tab.#retry||
      browser.purpose!=='browser'||browser.expiresAt!==0||!TAB_PURPOSE.test(tab.purpose)||
      captured.browser.purpose!==browser.purpose||captured.browser.expiresAt!==browser.expiresAt||
      captured.tab.purpose!==tab.purpose||captured.tab.expiresAt!==tab.expiresAt||now>=tab.expiresAt||
      captured.browser.generation!==browser.#generation||captured.tab.generation!==tab.#generation)hold()
    for(const scope of [browserScope,tabScope])if(typeof scope.name!=='string'||!scope.name.length||scope.name.length>512||
      !Number.isSafeInteger(scope.fence)||scope.fence<0)hold()
    browser.#scope(captured.browser,browserScope);tab.#scope(captured.tab,tabScope)
  }
  async #locked<T>(live: () => boolean, work: () => Promise<T>): Promise<T> {
    this.#check(live)
    if (!navigator.locks) hold()
    return navigator.locks.request(WRITE_LOCK, async () => {
      this.#check(live)
      await this.#operationBarrier(live)
      const result = await work()
      this.#check(live)
      return result
    })
  }
  static {
    // A read-custody token resolves its exact owners here. The fixed helper
    // must not pass those owners through a replaceable public class method.
    validateReadPairCustody = token => {
      const captured = pairCustody.get(token)
      if (captured?.kind !== 'read') hold()
      this.#validatePairBinding(token, { browser: { owner: captured.browserOwner, scope: captured.browserScope },
        tab: { owner: captured.tabOwner, scope: captured.tabScope }, live: () => true })
    }
    beginPrivateExistingCapture = root => this.#beginPrivateExistingCapture(root)
    beginPrivateExistingProvider = root => this.#beginPrivateExistingProvider(root)
  }
  /** Fixed restore-only native operation. Its sole selector is the actual
   * unexported document root, authenticated by the private root WeakMap. */
  static #beginPrivateExistingCapture(root: OrdinaryPrivateExistingRoot): OrdinaryPrivateExistingCaptureResource {
    const binding = claimOrdinaryPrivateExistingRoot(root), browser = new OrdinaryStateOwner()
    const purpose: OrdinaryPurpose = `tab:${binding.marker}`
    let tab: OrdinaryStateOwner | undefined, context: OperationTransaction | undefined
    let timer: ReturnType<typeof setTimeout> | undefined, stopped = false, closing: Promise<void> | undefined
    const stop = () => {
      if (stopped) return
      stopped = true
      privateExistingCaptures.delete(root)
      if (timer !== undefined) clearTimeout(timer)
      context?.abort()
      binding.revoke()
      browser.#revoke(); if (tab) tab.#revoke()
    }
    const cancel = { stop }
    browser.#resources.add(cancel)
    const check = () => {
      if (stopped || !binding.live() || navigator.serviceWorker.controller !== binding.controller) hold()
      browser.#check(binding.live); if (tab) tab.#check(binding.live)
    }
    let operation!: Promise<void>
    try {
      check()
      // Queue the real exclusive WRITE before returning the resource. The
      // root releases its initial shared WRITE only after this call returns.
      operation = Promise.resolve(navigator.locks.request(WRITE_LOCK, async () => {
        check()
        await binding.assertClientsCurrent(); check()
        const snapshot = await import('./ordinary-snapshot.js'), proofs = await import('./persistent-admission-proof.js'),
          lease = await import('./ordinary-member-lease.js'), devices = await import('./device-store.js'),
          identity = await import('./ordinary-identity-snapshot.js'), rooms = await import('./rooms-store.js')
        check()
        let db: IDBDatabase | undefined, b: OrdinaryImage | undefined, t: OrdinaryImage | undefined
        try {
          db = await browser.#existingStartupDatabase(binding.live); check(); if (!db) hold()
          db.onversionchange = () => { stop(); db?.close() }
          context = operationTransaction(db, 'readonly')
          const raw = await Promise.all([context.read(() => context!.store.get('browser')),
            context.read(() => context!.store.get(purpose))])
          check()
          const br = row(raw[0]), tr = row(raw[1])
          if (!br?.frame || !tr?.frame || br.pending || tr.pending) hold()
          b = await openOrdinaryFrame(br.frame, br.key); check()
          t = await openOrdinaryFrame(tr.frame, tr.key); check()
          const now = Date.now()
          if (b.purpose !== 'browser' || b.expiresAt !== 0 || t.purpose !== purpose ||
              !Number.isSafeInteger(t.expiresAt) || t.expiresAt <= now || t.expiresAt > now + 12 * 60 * 60 * 1000 ||
              b.migration?.phase !== 'complete' || t.migration?.phase !== 'complete') hold()
          // Only authenticated existing metadata may establish the tab owner.
          // No creating database path, marker allocation or expireTabs occurs.
          tab = new OrdinaryStateOwner(purpose, t.expiresAt)
          browser.#generation = b.generation; tab.#generation = t.generation
          tab.#resources.add(cancel); tab.#track(operation)
          timer = setTimeout(stop, t.expiresAt - Date.now())
          const facts = await browser.#classifyOperations(binding.live, context); check()
          if (facts.owners.some(([, value]) => JSON.parse(value)[1] !== null)) hold()
          browser.#validateCleanupImage(b, t, tab, facts, snapshot)
          const bv = view(new Map(b.records), false), tv = view(new Map(t.records), false)
          const inspected = proofs.inspectPersistentAdmissionProofs(bv.store, tv.store)
          try {
            lease.inspectOrdinaryMemberLeases(bv.store, tv.store, inspected)
            const incoming = parseRoomLink(binding.href)
            let invitationId: string
            try {
              if (incoming.secret || incoming.pairingCode || !incoming.invitation?.persistent) hold()
              const invitation = await import('../../src/invitation.js'); check()
              invitationId = invitation.deriveInvitationId(incoming.invitation)
            } finally { incoming.secret?.fill(0); incoming.invitation?.bearer.fill(0); incoming.pairingCode?.fill(0) }
            const matches = [...inspected.selected.values()].filter(value => value.proof.binding.invitationId === invitationId)
            if (matches.length !== 1) hold()
            const selected = matches[0]!, proof = selected.proof, bound = proof.binding
            if (proof.version !== 2 || !bound.deviceCustody || bound.account === null ||
                bound.account !== bound.participant || bound.tab.purpose !== purpose || bound.tab.expiresAt !== tab.expiresAt ||
                bound.browser.name !== 'invitation:' + bound.account + ':' + invitationId || bound.tab.name !== bound.browser.name) hold()
            browser.#scope(b, bound.browser); tab.#scope(t, bound.tab)
            const prefix = proofs.accountPrefix(bound.account), owner = proof.kept.enabled ? b : t, device = bound.deviceCustody
            if (device.owner !== (proof.kept.enabled ? 'browser' : 'tab') || device.scope.name !== 'room:' + bound.roomId ||
                device.owner === 'tab' && (device.scope.purpose !== purpose || device.scope.expiresAt !== tab.expiresAt)) hold()
            ;(proof.kept.enabled ? browser : tab).#scope(owner, device.scope)
            const metadataRaw = b.records.get(prefix + rooms.ROOM_PREFIX + bound.roomId)
            if (!metadataRaw) hold()
            const metadata = JSON.parse(metadataRaw)
            if (metadata.link !== binding.href || metadata.keep !== proof.kept.enabled || metadata.endedAt !== undefined) hold()
            // Complete snapshot validation already binds the exact stored link,
            // invitation capability, room, admission rows and device continuity.
            const credentialRaw = owner.records.get(prefix + devices.OWN_CREDENTIAL_PREFIX + bound.roomId),
              sealsRaw = owner.records.get(prefix + devices.OWN_SEAL_PREFIX + bound.roomId),
              keyRaw = owner.records.get(prefix + devices.DEVICE_PREFIX + bound.roomId)
            if (!credentialRaw || !sealsRaw || !keyRaw) hold()
            const credential = JSON.parse(credentialRaw), seals = JSON.parse(sealsRaw) as string[]
            identity.validateOrdinaryEmbeddedDeviceCredential(credential, bound.roomId)
            if (JSON.stringify(lease.ordinaryMemberLeaseCredential(proof, credential.id)) !== credentialRaw ||
                credential.pubkey !== bound.account || credential.tags[1]?.[1] !== bound.device.pubkey) hold()
            const key = hexToBytes(JSON.parse(keyRaw).sk)
            try { if (getPublicKey(key) !== bound.device.pubkey) hold() } finally { key.fill(0) }
            let foundSeal = false
            for (const encoded of seals) {
              const secret = hexToBytes(encoded)
              try { if (getPublicKey(secret) === credential.tags[3]?.[1]) foundSeal = true } finally { secret.fill(0) }
            }
            if (!foundSeal) hold()
            const credentialExpiresAt = Number(credential.tags[2]?.[1]), admissionEndsAt = selected.admission.endsAt
            const prior = t.records.get(lease.ordinaryMemberLeaseName(bound))
            let bootstrap = proof, memberLeaseOperation: string | null = null
            let leaseAuthority: import('./ordinary-member-lease.js').OrdinaryMemberAuthority | undefined
            if (prior !== undefined) {
              const current = lease.readOrdinaryMemberLease(prior, JSON.stringify(proof))
              bootstrap = JSON.parse(current.bootstrapProof); leaseAuthority = current.header.authority
              memberLeaseOperation = current.header.operation
              if (bootstrap.binding.operation !== current.header.bootstrap || current.header.expiresAt !== credentialExpiresAt ||
                  leaseAuthority.tabExpiresAt !== tab.expiresAt || leaseAuthority.admissionEndsAt !== (admissionEndsAt ?? null) ||
                  leaseAuthority.membershipEndsAt !== null || credentialExpiresAt > lease.ordinaryMemberAuthorityUntil(leaseAuthority)) hold()
            } else if (seals.length !== 1) hold()
            const first = lease.ordinaryMemberLeaseCredential(bootstrap, bootstrap.binding.device.credentialIds[0]!)
            const bootstrapCredentialExpiresAt = Number(first.tags[2]![1]), seconds = Math.floor(Date.now() / 1000)
            if (!Number.isSafeInteger(bootstrapCredentialExpiresAt) || bootstrapCredentialExpiresAt <= first.created_at ||
                !Number.isSafeInteger(credentialExpiresAt) || credentialExpiresAt <= credential.created_at ||
                credential.created_at > seconds || credentialExpiresAt - seconds < 600 ||
                credentialExpiresAt > Math.floor(tab.expiresAt / 1000) ||
                admissionEndsAt !== undefined && credentialExpiresAt > admissionEndsAt ||
                metadata.endsAt !== undefined && credentialExpiresAt > metadata.endsAt) hold()
            const k = ORDINARY_SIGNET_KEYS, account = b.records.get(k.pubkey), auth = b.records.get(k.authEvent),
              expiry = b.records.get(k.expiresAt), expiresAt = expiry === undefined ? undefined : Number(expiry)
            if (account !== bound.account || b.records.get(k.method) !== 'nip07' || !auth ||
                b.records.has(k.bunkerUri) || b.records.has(k.bunkerClientSk) || b.records.has(k.pendingRedirect) ||
                b.records.has(k.pendingRelayAuth) || t.records.has(ORDINARY_INITIAL_LOGIN_KEY) ||
                expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || String(expiresAt) !== expiry || Date.now() >= expiresAt ||
                  credentialExpiresAt > Math.floor(expiresAt / 1000)) ||
                leaseAuthority && (expiresAt ?? null) !== leaseAuthority.foregroundExpiresAt) hold()
            const authEvent = captureOrdinaryForegroundProof(JSON.parse(auth))
            if (authEvent.kind !== 21236 || authEvent.pubkey !== account || JSON.stringify(authEvent) !== auth || !verifyEventUncached(authEvent) ||
                authEvent.tags.filter(tag => tag[0] === 'origin').length !== 1 ||
                !authEvent.tags.some(tag => tag.length === 2 && tag[0] === 'origin' && tag[1] === binding.origin) ||
                authEvent.tags.filter(tag => tag[0] === 'app').length !== 1 ||
                !authEvent.tags.some(tag => tag.length === 2 && tag[0] === 'app' && tag[1] === 'KithMoot')) hold()
            const selection = Object.freeze({ account: bound.account, participant: bound.participant, invitationId,
              roomId: bound.roomId, link: metadata.link as string, keep: proof.kept.enabled, credentialExpiresAt,
              bootstrapCredentialExpiresAt, proofOperation: bound.operation, memberLeaseOperation })
            await context.step(() => {
              check()
              if (privateExistingCaptures.has(root)) hold()
              privateExistingCaptures.set(root, { token: Object.freeze({}), root, binding, browser, tab: tab!, purpose,
                expiresAt: tab!.expiresAt, rows: Object.freeze([rowDigest(br), rowDigest(tr)]),
                revisions: Object.freeze([b!.revision, t!.revision]), generations: Object.freeze([b!.generation, t!.generation]),
                classification: JSON.stringify(facts), selection, consumed: false })
            })
            check()
          } finally { inspected.close(); bv.close(); tv.close() }
          context.stop(); await context.ended; check()
        } catch (error) { context?.abort(); await context?.ended.catch(() => {}); stop(); throw error }
        finally { context?.stop(); context = undefined; clearImage(b); clearImage(t); db?.close() }
      }))
    } catch (error) { stop(); throw error }
    browser.#track(operation)
    const completed = operation.catch(error => { stop(); throw error })
    void completed.catch(() => {})
    return Object.freeze({ completed, stop, close: () => {
      if (closing) return closing
      let resolve!: () => void, reject!: (error: unknown) => void
      closing = new Promise<void>((yes, no) => { resolve = yes; reject = no })
      stop()
      // One rejected owner must not release the root while the other still
      // owns a native terminal tail. The root releases MIGRATION after this.
      void Promise.allSettled([browser.#close(), tab ? tab.#close() : undefined]).then(results => {
        const failed = results.find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') reject(failed.reason)
        else resolve()
      })
      return closing
    } })
  }
  /** Consume the actual private capture before any asynchronous or external
   * work. The resource retains the SDK privately; it supplies no member/current
   * MLS authority and no raw signer or selection to the document caller. */
  static #beginPrivateExistingProvider(root: OrdinaryPrivateExistingRoot): OrdinaryPrivateExistingCaptureResource {
    const captured = privateExistingCaptures.get(root)
    if (!captured || captured.consumed) hold()
    captured.consumed = true // Permanent, before getters, imports, callbacks or await.
    const { browser, tab, binding } = captured
    let stopped = false, closing: Promise<void> | undefined, context: OperationTransaction | undefined
    let source: Readonly<SignetSession> | undefined
    let closeSource: (() => Promise<void>) | undefined
    let expiryTimer: ReturnType<typeof setTimeout> | undefined
    let provider: NonNullable<Window['nostr']> | undefined, fields: readonly unknown[] | undefined
    let retainedProvider: PrivateExistingProvider | undefined, foregroundConstructionStarted = false
    let controlMode = false
    let sdkCurrent: (() => boolean) | undefined
    // Descriptor reflection can itself invoke Proxy traps. During explicit
    // control it is used only in the final authenticated native decision.
    const own = (object: object, key: PropertyKey, optional = false): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key)
      nativeCheck()
      if (!descriptor && optional) return undefined
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) hold()
      return descriptor.value
    }
    const controlWork = new Set<Promise<unknown>>()
    const trackControl = <T>(pending: Promise<T>): Promise<T> => {
      controlWork.add(pending); browser.#track(pending); tab.#track(pending)
      void pending.finally(() => controlWork.delete(pending)).catch(() => {})
      return pending
    }
    const nativeCheck = () => {
      if (stopped || privateExistingCaptures.get(root) !== captured || !binding.live() || stopped ||
          navigator.serviceWorker.controller !== binding.controller) hold()
      browser.#check(binding.live); tab.#check(binding.live)
      const now = Date.now()
      if (stopped || privateExistingCaptures.get(root) !== captured || !Number.isSafeInteger(now) || now < 0 ||
          now >= captured.expiresAt || captured.selection.credentialExpiresAt - Math.floor(now / 1000) < 600) hold()
    }
    const providerFields = (): unknown[] => {
      if (!provider) hold()
      const read = <T>(work: () => T): T => { const value = work(); nativeCheck(); return value }
      if (controlMode) {
        const n04 = own(provider!, 'nip04', true), n44 = own(provider!, 'nip44', true)
        return [own(provider!, 'getPublicKey'), own(provider!, 'signEvent'), n04, n44,
          n04 === undefined ? undefined : own(n04 as object, 'encrypt'),
          n04 === undefined ? undefined : own(n04 as object, 'decrypt'),
          n44 === undefined ? undefined : own(n44 as object, 'encrypt'),
          n44 === undefined ? undefined : own(n44 as object, 'decrypt')]
      }
      const n04 = read(() => provider!.nip04), n44 = read(() => provider!.nip44)
      return [read(() => provider!.getPublicKey), read(() => provider!.signEvent), n04, n44,
        read(() => n04?.encrypt), read(() => n04?.decrypt), read(() => n44?.encrypt), read(() => n44?.decrypt)]
    }
    const check = () => {
      nativeCheck()
      if (provider) {
        const actual = controlMode ? own(window, 'nostr') : window.nostr; nativeCheck()
        if (actual !== provider || fields && !providerFields().every((value, i) => value === fields![i])) hold()
      }
      nativeCheck()
    }
    const readCheck = () => { if (controlMode) nativeCheck(); else check() }
    const stop = () => {
      if (stopped) return
      stopped = true; if (expiryTimer !== undefined) clearTimeout(expiryTimer)
      privateExistingProviders.delete(root); context?.abort()
      retainedProvider?.foreground?.stop()
      binding.revoke(); browser.#revoke(); tab.#revoke()
    }
    const cancel = { stop }; browser.#resources.add(cancel); tab.#resources.add(cancel)
    const operation = Promise.resolve().then(async () => {
      nativeCheck()
      const expire = () => {
        if (stopped) return
        try {
          nativeCheck()
          const deadline = Math.min(captured.expiresAt, (captured.selection.credentialExpiresAt - 599) * 1000)
          expiryTimer = setTimeout(expire, Math.max(1, deadline - Date.now()))
        } catch { stop() }
      }
      expire(); nativeCheck()
      await binding.assertClientsCurrent(); nativeCheck()
      if (HEADLESS_NIP07_DISCOVERY_BOUNDARY !== 1) hold()
      return navigator.locks.request(WRITE_LOCK, async () => {
        nativeCheck()
        const snapshot = await import('./ordinary-snapshot.js'); nativeCheck()
        let db: IDBDatabase | undefined, sdk: Promise<SignetSigner> | undefined, raw: SignetSigner | undefined
        let providerPending: Promise<unknown> | undefined, used = false
        let retained: Omit<SignetSession, 'method' | 'signer'> | undefined
        const fresh = async (start?: () => void) => {
          let b: OrdinaryImage | undefined, t: OrdinaryImage | undefined
          try {
            readCheck(); db?.close(); db = await browser.#existingStartupDatabase(binding.live); readCheck(); if (!db) hold()
            db.onversionchange = () => { stop(); db?.close() }
            context = operationTransaction(db, 'readonly')
            const rows = await Promise.all([context.read(() => context!.store.get('browser')),
              context.read(() => context!.store.get(captured.purpose))])
            readCheck(); const br = row(rows[0]), tr = row(rows[1])
            if (!br?.frame || !tr?.frame || br.pending || tr.pending ||
                rowDigest(br) !== captured.rows[0] || rowDigest(tr) !== captured.rows[1]) hold()
            b = await openOrdinaryFrame(br.frame, br.key); readCheck()
            t = await openOrdinaryFrame(tr.frame, tr.key); readCheck()
            if (b.purpose !== 'browser' || b.expiresAt !== 0 || t.purpose !== captured.purpose ||
                t.expiresAt !== captured.expiresAt || b.revision !== captured.revisions[0] || t.revision !== captured.revisions[1] ||
                b.generation !== captured.generations[0] || t.generation !== captured.generations[1] ||
                b.migration?.phase !== 'complete' || t.migration?.phase !== 'complete') hold()
            const facts = await browser.#classifyOperations(binding.live, context); readCheck()
            if (JSON.stringify(facts) !== captured.classification) hold()
            browser.#validateCleanupImage(b, t, tab, facts, snapshot)
            const k = ORDINARY_SIGNET_KEYS, pubkey = b.records.get(k.pubkey), method = b.records.get(k.method),
              auth = b.records.get(k.authEvent), expiry = b.records.get(k.expiresAt), displayName = b.records.get(k.displayName)
            if (pubkey !== captured.selection.account || method !== 'nip07' || !auth ||
                b.records.has(k.bunkerUri) || b.records.has(k.bunkerClientSk) || b.records.has(k.pendingRedirect) ||
                b.records.has(k.pendingRelayAuth) || t.records.has(ORDINARY_INITIAL_LOGIN_KEY)) hold()
            const expiresAt = expiry === undefined ? undefined : Number(expiry)
            if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || String(expiresAt) !== expiry ||
                captured.selection.credentialExpiresAt > Math.floor(expiresAt / 1000))) hold()
            const proof = captureOrdinaryForegroundProof(JSON.parse(auth))
            if (JSON.stringify(proof) !== auth || proof.kind !== 21236 || proof.pubkey !== pubkey || !verifyEventUncached(proof) ||
                proof.tags.filter(tag => tag[0] === 'origin').length !== 1 ||
                !proof.tags.some(tag => tag.length === 2 && tag[0] === 'origin' && tag[1] === binding.origin) ||
                proof.tags.filter(tag => tag[0] === 'app').length !== 1 ||
                !proof.tags.some(tag => tag.length === 2 && tag[0] === 'app' && tag[1] === 'KithMoot')) hold()
            if (!retained) retained = Object.freeze({ pubkey, authEvent: { ...proof, kind: 21236 as const },
              ...(expiresAt === undefined ? {} : { expiresAt }), ...(displayName === undefined ? {} : { displayName }) })
            await context.step(() => {
              check(); if (controlMode && (!sdkCurrent || !sdkCurrent())) hold()
              const now = Date.now(); nativeCheck()
              if (!Number.isSafeInteger(now) || now < 0 || now >= captured.expiresAt ||
                  captured.selection.credentialExpiresAt - Math.floor(now / 1000) < 600 ||
                  expiresAt !== undefined && now >= expiresAt) hold()
              start?.(); check(); if (controlMode && (!sdkCurrent || !sdkCurrent())) hold()
            })
            context.stop(); await context.ended; readCheck()
          } finally {
            context?.abort(); await context?.ended.catch(() => {}); context?.stop(); context = undefined
            clearImage(b); clearImage(t); db?.close(); db = undefined
          }
        }
        const clients = async () => { readCheck(); await binding.assertClientsCurrent(); readCheck() }
        try {
          // Establish actual provider identity only after fresh native custody.
          await fresh(); nativeCheck()
          provider = window.nostr; nativeCheck(); if (!provider) hold()
          fields = Object.freeze(providerFields()); check()
          const boundary: Nip07DiscoveryBoundary = Object.freeze({ discoveryPreflightBoundary: 1 as const,
            start: <T>(prepare: () => void, effect: () => Promise<T>): Promise<T> => {
              if (used) return Promise.reject(new OrdinaryStateHold())
              used = true
              return (async () => {
                await clients(); prepare(); check()
                let actual: Promise<T> | undefined
                try {
                  await fresh(() => {
                    try { actual = Promise.resolve(effect()) } catch (error) { actual = Promise.reject(error) }
                    void actual.catch(() => {}); providerPending = actual
                    browser.#track(actual); tab.#track(actual)
                  })
                  if (!actual) hold(); const result = await actual
                  await clients(); await fresh(); check(); return result
                } finally { if (actual) await Promise.allSettled([actual]) }
              })()
            } })
          sdk = createPinnedNip07SignerWithDiscoveryBoundary(boundary)
          browser.#track(sdk); tab.#track(sdk); void sdk.catch(() => {})
          raw = await sdk; check()
          if (!used || raw.providerEffectBoundary !== 1 || raw.method !== 'nip07' || raw.pubkey !== captured.selection.account) hold()
          await clients(); await fresh(); check()
          source = Object.freeze({ ...retained!, method: 'nip07' as const, signer: raw })
          const sdkSigner = source.signer
          const sdkFields = () => {
            const get = (object: object, key: PropertyKey, optional = false): unknown => {
              const value = controlMode ? own(object, key, optional) : Reflect.get(object, key)
              readCheck(); return value
            }
            const capabilities = get(sdkSigner, 'capabilities') as object,
              n04 = get(sdkSigner, 'nip04', true) as object | undefined, n44 = get(sdkSigner, 'nip44', true) as object | undefined
            return [get(sdkSigner, 'pubkey'), get(sdkSigner, 'method'), get(sdkSigner, 'signEvent'),
              get(sdkSigner, 'providerEffectBoundary'), get(sdkSigner, 'pinnedProviderCalls'), capabilities,
              get(capabilities, 'canSignEvents'), get(capabilities, 'hasNip44'), n04, n44,
              n04 === undefined ? undefined : get(n04, 'encrypt'), n04 === undefined ? undefined : get(n04, 'decrypt'),
              n44 === undefined ? undefined : get(n44, 'encrypt'), n44 === undefined ? undefined : get(n44, 'decrypt'),
              Object.getPrototypeOf(sdkSigner)]
          }
          const expectedSdk = Object.freeze(sdkFields()), sdkClose = sdkSigner.close
          check()
          if (expectedSdk[4] !== 1 || typeof sdkClose !== 'function') hold()
          closeSource = () => sdkClose.call(sdkSigner)
          sdkCurrent = () => source?.signer === sdkSigner && sdkFields().every((value, index) => value === expectedSdk[index])
          retainedProvider = { capture: captured, source,
            beginControl: () => { controlMode = true; nativeCheck() },
            controlLive: nativeCheck,
            freshControl: async start => {
              // Wallet waits and all reflective provider/proof work are kept
              // out of the native reader until its final authenticated step.
              nativeCheck()
              if (retainedProvider?.foregroundClaimed) hold()
              await navigator.locks.request(WRITE_LOCK, async () => {
                if (retainedProvider?.foregroundClaimed) hold()
                await clients(); await fresh(start); nativeCheck()
              })
              nativeCheck()
            }, constructForeground: async construct => {
              if (foregroundConstructionStarted || !retainedProvider?.foregroundClaimed) hold()
              foregroundConstructionStarted = true
              await navigator.locks.request(WRITE_LOCK, async () => {
                await clients()
                await fresh(() => { construct(); nativeCheck() })
                // Constructor reflection is followed by another complete read.
                await fresh(); nativeCheck()
              })
              nativeCheck()
            }, assertForegroundProvider: () => {
              check(); if (!sdkCurrent || !sdkCurrent()) hold()
            }, trackControl, stop, consumed: false, foregroundStarted: false, foregroundClaimed: false, foreground: undefined }
          privateExistingProviders.set(root, retainedProvider)
          raw = undefined
        } finally {
          if (sdk) await Promise.allSettled([sdk]); if (providerPending) await Promise.allSettled([providerPending])
          try { await raw?.close() }
          finally {
            context?.abort(); await context?.ended.catch(() => {}); context?.stop(); db?.close()
            retained = undefined
          }
        }
      })
    }).catch(error => { stop(); throw error })
    browser.#track(operation); tab.#track(operation); void operation.catch(() => {})
    return Object.freeze({ completed: operation, stop, close: () => {
      if (closing) return closing
      let resolve!: () => void, reject!: (error: unknown) => void
      closing = new Promise<void>((yes, no) => { resolve = yes; reject = no })
      stop()
      void (async () => {
        await operation.catch(() => {})
        // Any later explicit authentication/member work must join before the
        // borrowed raw SDK is closed, even when that work refused or rejected.
        while (controlWork.size) await Promise.allSettled([...controlWork])
        // A foreground may have been assigned after revocation while its
        // construction was joining. Always settle it before the borrowed SDK.
        const results = await Promise.allSettled([retainedProvider?.foreground?.close()])
        results.push(...await Promise.allSettled([closeSource?.()])); source = undefined; closeSource = undefined
        browser.#resources.delete(cancel); tab.#resources.delete(cancel)
        results.push(...await Promise.allSettled([browser.#close(), tab.#close()]))
        const failed = results.find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      })().then(resolve, reject)
      return closing
    } })
  }
  /** Private construction stage only. It remains unreachable from discovery,
   * restore and public APIs. The full member driver must call it solely after
   * consuming its actual trusted UI action, then confine the resulting proof
   * to the exact one-use foreground claim. No historical auth row is replaced. */
  static #authenticatePrivateExistingProvider(root: OrdinaryPrivateExistingRoot): Promise<Readonly<SignetAuthEvent>> {
    const provider = privateExistingProviders.get(root)
    if (!provider || provider.consumed) return Promise.reject(new OrdinaryStateHold())
    provider.consumed = true // Before getters, imports, awaits or signing effects.
    try { provider.beginControl() } catch (error) { provider.stop(); return Promise.reject(error) }
    let phase: 'ready' | 'signing' | 'signed' | 'finalising' | 'complete' | 'failed' = 'ready'
    const pending = Promise.resolve().then(async () => {
      const { capture, source } = provider
      const current = () => {
        // Memory/native liveness only. No SDK/provider field or proof reflection
        // is allowed outside the authenticated final freshControl decision.
        provider.controlLive()
        if (privateExistingProviders.get(root) !== provider || phase === 'failed') hold()
      }
      const fresh = async (start?: () => void) => {
        current()
        await provider.freshControl(() => { current(); start?.(); current() })
        current()
      }
      let challenge = '', sdkStartedAt = 0, sdkPreparedAt = 0
      let signed: Readonly<SignetAuthEvent> | undefined, rawSigned: unknown
      let facade: SignetSigner | undefined
      const proof = (input: unknown) => captureOrdinaryFreshAccountProof(input, Object.freeze({
        account: capture.selection.account, challenge, origin: capture.binding.origin, sdkStartedAt, sdkPreparedAt,
      }))
      const boundary: SignerEffectBoundary = Object.freeze({
        start: <T>(effect: () => Promise<T>): Promise<T> => {
          const signing = phase === 'ready'
          if (!signing && phase !== 'signed') {
            phase = 'failed'; provider.stop(); return Promise.reject(new OrdinaryStateHold())
          }
          phase = signing ? 'signing' : 'finalising'
          return provider.trackControl(Promise.resolve().then(async () => {
            let actual: Promise<T> | undefined
            try {
              await fresh(() => {
                if (phase !== (signing ? 'signing' : 'finalising')) hold()
                try { actual = Promise.resolve(effect()) } catch (error) { actual = Promise.reject(error) }
                provider.trackControl(actual); void actual.catch(() => {})
              })
              if (!actual) hold()
              const result = await actual
              let detached: Readonly<SignetAuthEvent> | undefined
              await fresh(() => { detached = proof(result) })
              // Reflective proof capture may execute hostile Proxy traps. A
              // second complete native read follows it before accepting phase.
              await fresh()
              if (!detached || phase !== (signing ? 'signing' : 'finalising')) hold()
              if (signing) { rawSigned = result; signed = detached; phase = 'signed' }
              else {
                if (!signed || JSON.stringify(detached) !== JSON.stringify(signed)) hold()
                phase = 'complete'
              }
              return result // Every SDK boundary retains its actual result identity.
            } catch { phase = 'failed'; provider.stop(); throw new OrdinaryStateHold() }
            finally { if (actual) await Promise.allSettled([actual]) }
          }))
        },
      })
      try {
        await fresh(() => {
          challenge = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
          const signer = source.signer, sign = signer.signEvent
          const pubkey = signer.pubkey, method = signer.method
          if (pubkey !== capture.selection.account || method !== 'nip07' || signer.providerEffectBoundary !== 1 ||
              signer.capabilities.canSignEvents !== true || typeof sign !== 'function') hold()
          // This SDK-owned callable normalises owned templates and invokes only
          // captured provider functions behind the supplied unchanged boundary.
          // The outer SDK helper receives owned plain proof, never raw Proxy data.
          facade = Object.freeze({ pubkey, method, providerEffectBoundary: 1 as const,
            capabilities: Object.freeze({ ...signer.capabilities }),
            signEvent: async (template, supplied) => {
              if (supplied === undefined) hold()
              const actual = await Reflect.apply(sign, signer, [template, supplied])
              current()
              if (actual !== rawSigned || !signed || phase !== 'signed') hold()
              return signed
            },
            close: async () => { provider.stop() },
          } satisfies SignetSigner)
        })
        await fresh()
        if (!facade) hold()
        sdkStartedAt = Date.now()
        const sdk = provider.trackControl(createSessionFromSigner(facade, {
          appName: 'KithMoot', origin: capture.binding.origin, challenge, boundary,
        }))
        sdkPreparedAt = Date.now()
        const session = await sdk
        let detached: Readonly<SignetAuthEvent> | undefined
        await fresh(() => {
          detached = proof(session.authEvent)
          if (phase !== 'complete' || !signed || session.signer !== facade || session.pubkey !== capture.selection.account ||
              session.method !== 'nip07' || JSON.stringify(detached) !== JSON.stringify(signed)) hold()
        })
        await fresh()
        if (!detached) hold()
        return detached
      } catch (error) { phase = 'failed'; provider.stop(); throw error }
    }).catch(error => { phase = 'failed'; provider.stop(); throw error })
    return provider.trackControl(pending)
  }
  /** Internal part of the unfinished member driver. No proof, signer, owner,
   * foreground instance or claim is returned to the document controller. */
  static #beginPrivateExistingForeground(root: OrdinaryPrivateExistingRoot): Promise<void> {
    const provider = privateExistingProviders.get(root)
    if (!provider || provider.foregroundStarted || provider.consumed) return Promise.reject(new OrdinaryStateHold())
    provider.foregroundStarted = true
    // Authentication spends the provider synchronously before the first await.
    const authentication = OrdinaryStateOwner.#authenticatePrivateExistingProvider(root)
    return provider.trackControl(Promise.resolve().then(async () => {
      try {
        await authentication // The detached fresh proof remains within this owner.
        provider.controlLive()
        const { capture, source } = provider
        let scopes: readonly [OrdinaryScope, OrdinaryScope] | undefined, scopeCaptureStarted = false
        let sdkExpiresAt: number | null = null
        const live = () => {
          try {
            provider.controlLive()
            return sdkExpiresAt === null || Date.now() < sdkExpiresAt
          } catch { return false }
        }
        const binding: PrivateForegroundBinding = Object.freeze({
          browser: capture.browser, tab: capture.tab, source, generation: capture.binding.generation,
          live, stop: provider.stop, assertClientsCurrent: capture.binding.assertClientsCurrent,
          captureForegroundScopes: async () => {
            if (scopeCaptureStarted) hold()
            scopeCaptureStarted = true
            const browserScope = await capture.browser.#capture('@ordinary-signet', live)
            const tabScope = await capture.tab.#capture('@ordinary-signet', live)
            if (!live()) hold()
            scopes = Object.freeze([browserScope, tabScope] as const)
            return scopes
          },
          constructForeground: provider.constructForeground,
          readForeground: <T>(selected: () => boolean,
            work: (browser: DeviceStore, tab: DeviceStore, custody: OrdinaryPairCustody) => T) => {
            if (!scopes) return Promise.reject(new OrdinaryStateHold())
            const current = () => live() && selected() === true && live()
            return OrdinaryStateOwner.#readPairMigrated({
              browser: { owner: capture.browser, scope: scopes[0] },
              tab: { owner: capture.tab, scope: scopes[1] }, live: current,
              work: (browser, tab, _bn, _tn, custody) => {
                // This construction stage still owns the exact predecessor.
                // A later acknowledged member epoch must replace this binding
                // through the fixed adoption path before renewal can extend it.
                const native = pairCustody.get(custody)
                if (native?.kind !== 'read' || !native.rows ||
                    native.rows.some((row, index) => rowDigest(row) !== capture.rows[index])) hold()
                return work(browser, tab, custody)
              },
            })
          },
          joinForeground: <T>(pending: Promise<T>) => OrdinaryStateOwner.#joinPairLifetime(capture.browser, capture.tab, pending),
          assertForegroundProvider: provider.assertForegroundProvider,
        })
        let opening: Promise<OrdinaryPrivateForegroundResource> | undefined
        await provider.freshControl(() => {
          if (provider.foregroundClaimed || privateExistingProviders.get(root) !== provider) hold()
          const expiry = Object.getOwnPropertyDescriptor(source, 'expiresAt')
          sdkExpiresAt = expiry === undefined ? null : expiry.value
          if (sdkExpiresAt !== null && (!Number.isSafeInteger(sdkExpiresAt) || Date.now() >= sdkExpiresAt)) hold()
          provider.foregroundClaimed = true // Spend the predecessor control seam.
          const claim = Object.freeze({}) as OrdinaryPrivateForegroundClaim
          privateForegroundClaims.set(claim, Object.freeze({ provider, binding }))
          // The fixed ESM wrapper takes the token synchronously, without an
          // unlocked handoff or a mutable public class method in between.
          opening = openOrdinaryPrivateForegroundFromOwnerClaim(claim)
          provider.trackControl(opening); void opening.catch(() => {})
        })
        if (!opening) hold()
        provider.foreground = await opening // Own even a late assignment.
        provider.controlLive()
      } catch {
        provider.stop()
        // Join this component only. Joining the provider/root here would join
        // the very driver whose rejection their close is waiting to settle.
        await Promise.allSettled([provider.foreground?.close()])
        throw new OrdinaryStateHold()
      }
    }))
  }
  /** @internal A one-use witness is consumed solely by the captured private
   * startup factory. It grants no ordinary read or arbitrary phase writer. */
  static consumePreparedRenewalWitness(witness: OrdinaryPreparedRenewalWitness, preparation: OrdinaryPreparedRenewalFactory,
    root: ProtocolExecution, browser: OrdinaryStateOwner, tab: OrdinaryStateOwner): Readonly<{
      intent: OrdinaryRenewalIntent; browserScope: OrdinaryScope; tabScope: OrdinaryScope
    }> {
    const value = preparedWitnesses.get(witness)
    if (!value || value.claimed || value.preparation !== preparation || value.root !== root || value.browser !== browser || value.tab !== tab) hold()
    browser.#check(() => true); tab.#check(() => true)
    value.claimed = true
    return Object.freeze({ intent: value.intent, browserScope: value.browserScope, tabScope: value.tabScope })
  }
  /** @internal Actual SDK account discovery under fixed prepared E. The
   * returned raw SDK session remains private to its extension-startup owner;
   * it supplies no ordinary view, native CU, phase writer or current member. */
  static restorePreparedExtensionAtStartup(preparation: OrdinaryPreparedExtensionFactory, root: ProtocolExecution): Promise<Readonly<SignetSession>> {
    const binding = takeOrdinaryPreparedExtensionFactory(preparation, root), browser = binding.browser, tab = binding.tab
    let resolve!: (value: Readonly<SignetSession>) => void, reject!: (error: unknown) => void
    const pending = new Promise<Readonly<SignetSession>>((yes, no) => { resolve = yes; reject = no })
    browser.#track(pending); tab.#track(pending)
    try { root.retain(pending) } catch (error) { reject(error); return pending }
    void Promise.resolve().then(async () => {
      const check = () => { browser.#check(binding.live); tab.#check(binding.live); checkOrdinaryPreparedExtensionPromise(preparation, root, pending) }
      const clients = async () => { check(); await binding.checkClients(); check() }
      check()
      if (HEADLESS_NIP07_DISCOVERY_BOUNDARY !== 1 || !navigator.locks || browser.#retry || tab.#retry) hold()
      await clients()
      return navigator.locks.request(WRITE_LOCK, async () => {
        const startup = await import('./ordinary-renewal-startup.js'), codec = await import('./ordinary-renewal-request.js'),
          snapshot = await import('./ordinary-snapshot.js'), proofs = await import('./persistent-admission-proof.js'), lease = await import('./ordinary-member-lease.js')
        let db: IDBDatabase | undefined, context: OperationTransaction | undefined
        let facts: OperationClassification | undefined, target: PreparedRenewalTarget | undefined
        let retained: Omit<SignetSession, 'signer' | 'method'> | undefined, sessionValues: readonly (string | null)[] | undefined
        let raw: SignetSigner | undefined, sdk: Promise<SignetSigner> | undefined, providerPending: Promise<unknown> | undefined, used = false
        const cancel = { stop: () => context?.abort() }; browser.#resources.add(cancel); tab.#resources.add(cancel)
        const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
        // Fixed private reader: its only effect is the SDK's one account
        // discovery callback, started in this authentic native transaction.
        const withE = async (start?: () => void): Promise<void> => {
          let b: OrdinaryImage | undefined, t: OrdinaryImage | undefined, journal: OrdinaryOperationJournal | undefined
          try {
            check(); db?.close(); db = await browser.#existingStartupDatabase(binding.live); check(); if (!db) hold()
            db.onversionchange = () => { browser.#revoke(); tab.#revoke(); db?.close() }
            context = operationTransaction(db, 'readonly')
            const names = ordinaryOperationNames(tab.purpose), rows = await Promise.all([
              context.read(() => context!.store.get('browser')), context.read(() => context!.store.get(tab.purpose)), context.read(() => context!.store.get(names.control)),
            ])
            check(); const br = row(rows[0]), tr = row(rows[1]); if (!br?.frame || !tr?.frame || br.pending || tr.pending) hold()
            b = await openOrdinaryFrame(br.frame, br.key); check(); t = await openOrdinaryFrame(tr.frame, tr.key); check()
            const header = (image: OrdinaryImage) => ({ purpose: image.purpose, keyId: image.keyId, generation: image.generation, expiresAt: image.expiresAt })
            journal = await openOrdinaryOperationControl(rows[2], { browser: { binding: header(b), key: br.key }, tab: { binding: header(t), key: tr.key } }); check()
            if (journal.phase !== 'prepared' || journal.tab !== tab.purpose || t.expiresAt !== tab.expiresAt ||
                journal.result !== null || journal.secrets.length || journal.nonces !== null || journal.target !== null) hold()
            await startup.validateOrdinaryRenewalStartupRows(journal, [br.frame, tr.frame], [b, t]); check()
            const request = codec.readOrdinaryRenewalRequest(journal.request), intent = request.intent
            if (intent.account !== binding.account || intent.participant !== binding.account || intent.invitationId !== binding.invitationId ||
                intent.keep !== binding.keep || intent.issuedAt > Math.floor(Date.now() / 1000) || intent.expiresAt - Math.floor(Date.now() / 1000) < 600) hold()
            const linkBytes = new TextEncoder().encode(binding.link)
            try { if (bytesToHex(sha256(linkBytes)) !== intent.linkDigest) hold() } finally { linkBytes.fill(0) }
            const packet = encodeOrdinaryOperationJournal(journal); let classification: OrdinaryOperationClassification
            try { classification = decodeOrdinaryOperationClassification(packet) } finally { packet.fill(0) }
            const actual: PreparedRenewalTarget = { purpose: tab.purpose as `tab:${string}`, rows: [rowDigest(br), rowDigest(tr)],
              controlDigest: ordinaryOperationControlDigest(rows[2]), header: classification }
            const currentFacts = await browser.#classifyOperations(binding.live, context, false, actual); check()
            if (target && (!same(actual, target) || !same(currentFacts, facts))) hold()
            const inverse = [copyImage(b), copyImage(t)] as const
            try {
              codec.restoreOrdinaryRenewalPredecessor(inverse[0], inverse[1], journal.request, { id: journal.id, sequence: journal.sequence })
              const markers = new Map(currentFacts.markers), marker = inverse[0].records.get(names.marker)
              if (marker === undefined) markers.delete(names.marker); else markers.set(names.marker, marker)
              browser.#validateCleanupImage(inverse[0], inverse[1], tab, { ...currentFacts, markers: [...markers] }, snapshot)
              const bv = view(new Map(inverse[0].records), false), tv = view(new Map(inverse[1].records), false), inspected = proofs.inspectPersistentAdmissionProofs(bv.store, tv.store)
              try {
                const selected = inspected.selected.get(proofs.accountPrefix(binding.account) + proofs.PERSISTENT_TAB_PROOF_V2_PREFIX + binding.invitationId)
                if (!selected) hold()
                const prior = inverse[1].records.get(lease.ordinaryMemberLeaseName(selected.proof.binding))
                const bootstrap = prior === undefined ? selected.proof : JSON.parse(lease.readOrdinaryMemberLease(prior, JSON.stringify(selected.proof)).bootstrapProof)
                const first = lease.ordinaryMemberLeaseCredential(bootstrap, bootstrap.binding.device.credentialIds[0]!)
                if (Number(first.tags[2]![1]) !== binding.bootstrapCredentialExpiresAt) hold()
              } finally { inspected.close(); bv.close(); tv.close() }
            } finally { inverse.forEach(clearImage) }
            const k = ORDINARY_SIGNET_KEYS, keys = [k.pubkey, k.method, k.authEvent, k.bunkerUri, k.bunkerClientSk, k.expiresAt, k.displayName]
            const values = keys.map(name => b!.records.get(name) ?? null), [pubkey, method, proof, bunkerUri, bunkerKey, expiry, displayName] = values
            if (pubkey !== binding.account || method !== 'nip07' || !proof || bunkerUri !== null || bunkerKey !== null ||
                b.records.has(k.pendingRedirect) || b.records.has(k.pendingRelayAuth) || t.records.has(ORDINARY_INITIAL_LOGIN_KEY) ||
                sessionValues && !same(values, sessionValues)) hold()
            const expiresAt = expiry === null ? undefined : Number(expiry)
            if (expiresAt !== undefined && Date.now() >= expiresAt || (expiresAt ?? null) !== intent.authority.foregroundExpiresAt) hold()
            const captured = captureOrdinaryForegroundProof(JSON.parse(proof))
            if (captured.kind !== 21236 || captured.pubkey !== pubkey || JSON.stringify(captured) !== proof) hold()
            if (!retained) retained = Object.freeze({ pubkey, authEvent: { ...captured, kind: 21236 as const },
              ...(expiresAt === undefined ? {} : { expiresAt }), ...(displayName === null ? {} : { displayName }) })
            target = actual; facts = currentFacts; sessionValues = Object.freeze(values)
            await context.step(() => {
              check()
              const now = Date.now()
              if (!Number.isSafeInteger(now) || now < 0 || intent.issuedAt > Math.floor(now / 1000) ||
                  intent.expiresAt - Math.floor(now / 1000) < 600 || expiresAt !== undefined && now >= expiresAt) hold()
              check()
              const result: unknown = start?.()
              if (result && typeof (result as PromiseLike<unknown>).then === 'function') hold()
              check()
            })
            context.stop(); await context.ended; check()
          } finally {
            context?.abort(); await context?.ended.catch(() => {}); context?.stop(); context = undefined
            journal?.secrets.forEach(secret => secret.fill(0)); clearImage(b); clearImage(t)
          }
        }
        const boundary: Nip07DiscoveryBoundary = Object.freeze({ discoveryPreflightBoundary: 1 as const, start: <T>(prepare: () => void, provider: () => Promise<T>): Promise<T> => {
          if (used) return Promise.reject(new OrdinaryStateHold())
          used = true
          return (async () => {
            await clients()
            // SDK metadata accessors run before the fresh native E decision.
            prepare()
            let actual: Promise<T> | undefined
            try {
              await withE(() => {
                try { actual = Promise.resolve(provider()) } catch (error) { actual = Promise.reject(error) }
                void actual.catch(() => {}); providerPending = actual
                browser.#track(actual); tab.#track(actual)
              })
              if (!actual) hold(); const value = await actual
              await clients(); await withE(); check(); return value
            } finally { if (actual) await Promise.allSettled([actual]) }
          })()
        } })
        try {
          await withE(); check()
          sdk = createNip07SignerWithDiscoveryBoundary(boundary); browser.#track(sdk); tab.#track(sdk); void sdk.catch(() => {})
          raw = await sdk
          if (!used || raw.providerEffectBoundary !== 1 || raw.method !== 'nip07' || raw.pubkey !== binding.account) hold()
          await clients(); await withE(); check()
          const result = Object.freeze({ ...retained!, method: 'nip07' as const, signer: raw })
          raw = undefined; return result
        } finally {
          if (sdk) await Promise.allSettled([sdk]); if (providerPending) await Promise.allSettled([providerPending])
          await raw?.close(); context?.abort(); await context?.ended.catch(() => {}); context?.stop(); db?.close()
          retained = undefined; sessionValues = undefined; browser.#resources.delete(cancel); tab.#resources.delete(cancel)
        }
      })
    }).then(resolve, reject)
    return pending
  }
  /** @internal Fixed ordinary-P SDK discovery, using a separate one-use
   * resource-only root capture. Historical validation supplies no live CU.
   * No native image, read cache, phase parameter or signer executor escapes. */
  static restoreOrdinaryExtensionAtStartup(preparation: OrdinaryColdExtensionFactory, root: ProtocolExecution): Promise<Readonly<SignetSession>> {
    const binding = takeOrdinaryColdExtensionFactory(preparation, root), browser = binding.browser, tab = binding.tab
    let resolve!: (value: Readonly<SignetSession>) => void, reject!: (error: unknown) => void
    const pending = new Promise<Readonly<SignetSession>>((yes, no) => { resolve = yes; reject = no })
    browser.#track(pending); tab.#track(pending)
    try { root.retain(pending) } catch (error) { reject(error); return pending }
    void Promise.resolve().then(async () => {
      const check = () => { browser.#check(binding.live); tab.#check(binding.live); checkOrdinaryColdExtensionPromise(preparation, root, pending) }
      const clients = async () => { check(); await binding.checkClients(); check() }
      check()
      if (HEADLESS_NIP07_DISCOVERY_BOUNDARY !== 1 || !navigator.locks || browser.#retry || tab.#retry) hold()
      await clients()
      return navigator.locks.request(WRITE_LOCK, async () => {
        const identity = await import('./ordinary-identity-snapshot.js'), devices = await import('./device-store.js'), rooms = await import('./rooms-store.js'),
          snapshot = await import('./ordinary-snapshot.js'), proofs = await import('./persistent-admission-proof.js'), lease = await import('./ordinary-member-lease.js')
        let db: IDBDatabase | undefined, context: OperationTransaction | undefined
        let facts: OperationClassification | undefined, target: readonly string[] | undefined
        const origin = location.origin
        if (!origin || origin === 'null' || new URL(origin).origin !== origin) hold()
        let retained: Omit<SignetSession, 'signer' | 'method'> | undefined, sessionValues: readonly (string | null)[] | undefined
        let raw: SignetSigner | undefined, sdk: Promise<SignetSigner> | undefined, providerPending: Promise<unknown> | undefined, used = false
        const cancel = { stop: () => context?.abort() }; browser.#resources.add(cancel); tab.#resources.add(cancel)
        const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
        // Fixed private reader: its only effect is the SDK's one account
        // discovery callback, started in this authentic native transaction.
        const withP = async (start?: () => void): Promise<void> => {
          let b: OrdinaryImage | undefined, t: OrdinaryImage | undefined
          try {
            check(); db?.close(); db = await browser.#existingStartupDatabase(binding.live); check(); if (!db) hold()
            db.onversionchange = () => { browser.#revoke(); tab.#revoke(); db?.close() }
            context = operationTransaction(db, 'readonly')
            const rows = await Promise.all([context.read(() => context!.store.get('browser')), context.read(() => context!.store.get(tab.purpose))])
            check(); const br = row(rows[0]), tr = row(rows[1]); if (!br?.frame || !tr?.frame || br.pending || tr.pending) hold()
            b = await openOrdinaryFrame(br.frame, br.key); check(); t = await openOrdinaryFrame(tr.frame, tr.key); check()
            if (browser.purpose !== 'browser' || browser.expiresAt !== 0 || !TAB_PURPOSE.test(tab.purpose) ||
                b.purpose !== browser.purpose || b.expiresAt !== 0 || t.purpose !== tab.purpose || t.expiresAt !== tab.expiresAt ||
                browser.#generation !== undefined && browser.#generation !== b.generation ||
                tab.#generation !== undefined && tab.#generation !== t.generation ||
                b.migration?.phase !== 'complete' || t.migration?.phase !== 'complete') hold()
            const actual = [rowDigest(br), rowDigest(tr)]
            const currentFacts = await browser.#classifyOperations(binding.live, context); check()
            if (currentFacts.owners.some(([, digest]) => JSON.parse(digest)[1] !== null) ||
                target && (!same(actual, target) || !same(currentFacts, facts)) || location.origin !== origin) hold()
            // This composer checks historical semantics only. Current role,
            // native owner scopes and deadlines are independently checked below.
            browser.#validateCleanupImage(b, t, tab, currentFacts, snapshot)
            const bv = view(new Map(b.records), false), tv = view(new Map(t.records), false)
            const inspected = proofs.inspectPersistentAdmissionProofs(bv.store, tv.store)
            let credentialExpiry: number, admissionEndsAt: number | undefined, leaseAuthority: import('./ordinary-member-lease.js').OrdinaryMemberAuthority | undefined
            try {
              const selected = inspected.selected.get(proofs.accountPrefix(binding.account) + proofs.PERSISTENT_TAB_PROOF_V2_PREFIX + binding.invitationId)
              if (!selected) hold()
              const proof = selected.proof, bound = proof.binding, prefix = proofs.accountPrefix(binding.account)
              if (proof.version !== 2 || !bound.deviceCustody || bound.account !== binding.account || bound.participant !== binding.account ||
                  bound.invitationId !== binding.invitationId || proof.kept.enabled !== binding.keep || bound.tab.purpose !== tab.purpose ||
                  bound.tab.expiresAt !== tab.expiresAt || bound.browser.name !== 'invitation:' + binding.account + ':' + binding.invitationId ||
                  bound.tab.name !== bound.browser.name) hold()
              browser.#scope(b, bound.browser); tab.#scope(t, bound.tab)
              const owner = binding.keep ? b : t, device = bound.deviceCustody
              if (device.owner !== (binding.keep ? 'browser' : 'tab') || device.scope.name !== 'room:' + bound.roomId ||
                  device.owner === 'tab' && (device.scope.purpose !== tab.purpose || device.scope.expiresAt !== tab.expiresAt)) hold()
              ;(binding.keep ? browser : tab).#scope(owner, device.scope)
              const linked = parseRoomLink(binding.link)
              try {
                if (linked.secret || linked.pairingCode || !linked.invitation?.persistent ||
                    linked.invitation.inviter !== proof.capability.inviter || bytesToHex(linked.invitation.bearer) !== proof.capability.bearer) hold()
              } finally { linked.secret?.fill(0); linked.invitation?.bearer.fill(0); linked.pairingCode?.fill(0) }
              const metadataRaw = b.records.get(prefix + rooms.ROOM_PREFIX + bound.roomId)
              if (!metadataRaw) hold()
              const metadata = JSON.parse(metadataRaw)
              if (metadata.link !== binding.link || metadata.keep !== binding.keep || metadata.endedAt !== undefined) hold()
              const credentialRaw = owner.records.get(prefix + devices.OWN_CREDENTIAL_PREFIX + bound.roomId)
              const sealsRaw = owner.records.get(prefix + devices.OWN_SEAL_PREFIX + bound.roomId)
              const keyRaw = owner.records.get(prefix + devices.DEVICE_PREFIX + bound.roomId)
              if (!credentialRaw || !sealsRaw || !keyRaw) hold()
              const credential = JSON.parse(credentialRaw), seals = JSON.parse(sealsRaw) as string[]
              identity.validateOrdinaryEmbeddedDeviceCredential(credential, bound.roomId)
              if (JSON.stringify(lease.ordinaryMemberLeaseCredential(proof, credential.id)) !== credentialRaw ||
                  credential.pubkey !== binding.account || credential.tags[1]?.[1] !== bound.device.pubkey) hold()
              const key = hexToBytes(JSON.parse(keyRaw).sk)
              try { if (getPublicKey(key) !== bound.device.pubkey) hold() } finally { key.fill(0) }
              let foundSeal = false
              for (const encoded of seals) {
                const key = hexToBytes(encoded)
                try { if (getPublicKey(key) === credential.tags[3]?.[1]) foundSeal = true } finally { key.fill(0) }
              }
              if (!foundSeal) hold()
              credentialExpiry = Number(credential.tags[2]?.[1]); admissionEndsAt = selected.admission.endsAt
              const prior = t.records.get(lease.ordinaryMemberLeaseName(bound))
              let bootstrap = proof
              if (prior !== undefined) {
                const current = lease.readOrdinaryMemberLease(prior, JSON.stringify(proof)), authority = current.header.authority
                bootstrap = JSON.parse(current.bootstrapProof)
                if (bootstrap.binding.operation !== current.header.bootstrap || current.header.expiresAt !== credentialExpiry ||
                    authority.tabExpiresAt !== tab.expiresAt || authority.admissionEndsAt !== (admissionEndsAt ?? null) ||
                    authority.membershipEndsAt !== null || credentialExpiry > lease.ordinaryMemberAuthorityUntil(authority)) hold()
                leaseAuthority = authority
              } else if (seals.length !== 1) hold()
              const first = lease.ordinaryMemberLeaseCredential(bootstrap, bootstrap.binding.device.credentialIds[0]!)
              if (Number(first.tags[2]![1]) !== binding.bootstrapCredentialExpiresAt || !Number.isSafeInteger(credentialExpiry) ||
                  credentialExpiry <= credential.created_at || credential.created_at > Math.floor(Date.now() / 1000) ||
                  credentialExpiry - Math.floor(Date.now() / 1000) < 600 || credentialExpiry > Math.floor(tab.expiresAt / 1000) ||
                  admissionEndsAt !== undefined && credentialExpiry > admissionEndsAt ||
                  metadata.endsAt !== undefined && credentialExpiry > metadata.endsAt) hold()
            } finally { inspected.close(); bv.close(); tv.close() }
            const k = ORDINARY_SIGNET_KEYS, keys = [k.pubkey, k.method, k.authEvent, k.bunkerUri, k.bunkerClientSk, k.expiresAt, k.displayName]
            const values = keys.map(name => b!.records.get(name) ?? null), [pubkey, method, proof, bunkerUri, bunkerKey, expiry, displayName] = values
            if (pubkey !== binding.account || method !== 'nip07' || !proof || bunkerUri !== null || bunkerKey !== null ||
                b.records.has(k.pendingRedirect) || b.records.has(k.pendingRelayAuth) || t.records.has(ORDINARY_INITIAL_LOGIN_KEY) ||
                sessionValues && !same(values, sessionValues)) hold()
            const expiresAt = expiry === null ? undefined : Number(expiry)
            if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || String(expiresAt) !== expiry || Date.now() >= expiresAt ||
                credentialExpiry > Math.floor(expiresAt / 1000)) || leaseAuthority && (expiresAt ?? null) !== leaseAuthority.foregroundExpiresAt) hold()
            const captured = captureOrdinaryForegroundProof(JSON.parse(proof))
            if (captured.kind !== 21236 || captured.pubkey !== pubkey || JSON.stringify(captured) !== proof || !verifyEventUncached(captured) ||
                location.origin !== origin || captured.tags.filter(tag => tag[0] === 'origin').length !== 1 ||
                !captured.tags.some(tag => tag.length === 2 && tag[0] === 'origin' && tag[1] === origin) ||
                captured.tags.filter(tag => tag[0] === 'app').length !== 1 ||
                !captured.tags.some(tag => tag.length === 2 && tag[0] === 'app' && tag[1] === 'KithMoot')) hold()
            if (!retained) retained = Object.freeze({ pubkey, authEvent: { ...captured, kind: 21236 as const },
              ...(expiresAt === undefined ? {} : { expiresAt }), ...(displayName === null ? {} : { displayName }) })
            target = actual; facts = currentFacts; sessionValues = Object.freeze(values)
            await context.step(() => {
              check()
              const now = Date.now()
              if (!Number.isSafeInteger(now) || now < 0 || location.origin !== origin || credentialExpiry - Math.floor(now / 1000) < 600 ||
                  now >= tab.expiresAt || admissionEndsAt !== undefined && Math.floor(now / 1000) >= admissionEndsAt ||
                  expiresAt !== undefined && now >= expiresAt) hold()
              check()
              const result: unknown = start?.()
              if (result && typeof (result as PromiseLike<unknown>).then === 'function') hold()
              check()
            })
            context.stop(); await context.ended; check()
          } finally {
            context?.abort(); await context?.ended.catch(() => {}); context?.stop(); context = undefined
            clearImage(b); clearImage(t)
          }
        }
        const boundary: Nip07DiscoveryBoundary = Object.freeze({ discoveryPreflightBoundary: 1 as const, start: <T>(prepare: () => void, provider: () => Promise<T>): Promise<T> => {
          if (used) return Promise.reject(new OrdinaryStateHold())
          used = true
          return (async () => {
            await clients()
            // SDK metadata accessors run before the fresh native P decision.
            prepare()
            let actual: Promise<T> | undefined
            try {
              await withP(() => {
                try { actual = Promise.resolve(provider()) } catch (error) { actual = Promise.reject(error) }
                void actual.catch(() => {}); providerPending = actual
                browser.#track(actual); tab.#track(actual)
              })
              if (!actual) hold(); const value = await actual
              await clients(); await withP(); check(); return value
            } finally { if (actual) await Promise.allSettled([actual]) }
          })()
        } })
        try {
          await withP(); check()
          sdk = createNip07SignerWithDiscoveryBoundary(boundary); browser.#track(sdk); tab.#track(sdk); void sdk.catch(() => {})
          raw = await sdk
          if (!used || raw.providerEffectBoundary !== 1 || raw.method !== 'nip07' || raw.pubkey !== binding.account) hold()
          await clients(); await withP(); check()
          const result = Object.freeze({ ...retained!, method: 'nip07' as const, signer: raw })
          raw = undefined; return result
        } finally {
          if (sdk) await Promise.allSettled([sdk]); if (providerPending) await Promise.allSettled([providerPending])
          await raw?.close(); context?.abort(); await context?.ended.catch(() => {}); context?.stop(); db?.close()
          retained = undefined; sessionValues = undefined; browser.#resources.delete(cancel); tab.#resources.delete(cancel)
        }
      })
    }).then(resolve, reject)
    return pending
  }
  /** Fixed native authentication of an unstarted operation. Capture/ownership
   * is not phase permission; every fact is authenticated under the origin lock. */
  static authenticatePreparedRenewalAtStartup(preparation: OrdinaryPreparedRenewalFactory, root: ProtocolExecution): Promise<OrdinaryPreparedRenewalWitness> {
    const binding = takeOrdinaryPreparedFactory(preparation, root), browser = binding.browser, tab = binding.tab
    let resolve!: (value: OrdinaryPreparedRenewalWitness) => void, reject!: (error: unknown) => void
    const pending = new Promise<OrdinaryPreparedRenewalWitness>((yes, no) => { resolve = yes; reject = no })
    browser.#track(pending); tab.#track(pending)
    try {
      root.retain(pending)
      if (binding.account !== null) OrdinaryForegroundSigner.retainPreparedStartupAuthentication(binding.identity as OrdinaryForegroundSigner, root, pending)
    } catch (error) { reject(error); return pending }
    void Promise.resolve().then(async () => {
      const check = () => { browser.#check(binding.live); tab.#check(binding.live); checkOrdinaryPreparedFactoryPromise(preparation, root, pending) }
      check()
      if (binding.account !== null) await OrdinaryForegroundSigner.checkPreparedStartupAuthentication(binding.identity as OrdinaryForegroundSigner, root, pending)
      check()
      if (!navigator.locks || browser.#retry || tab.#retry) hold()
      return navigator.locks.request(WRITE_LOCK, async () => {
        const startup = await import('./ordinary-renewal-startup.js'), requestCodec = await import('./ordinary-renewal-request.js'),
          snapshot = await import('./ordinary-snapshot.js'), proofs = await import('./persistent-admission-proof.js'), lease = await import('./ordinary-member-lease.js')
        check()
        const db = await browser.#existingStartupDatabase(binding.live)
        if (!db) hold()
        db.onversionchange = () => { browser.#revoke(); tab.#revoke(); db.close() }
        let context: OperationTransaction | undefined, b: OrdinaryImage | undefined, t: OrdinaryImage | undefined, journal: OrdinaryOperationJournal | undefined
        const cancel = { stop: () => context?.abort() }; browser.#resources.add(cancel); tab.#resources.add(cancel)
        try {
          context = operationTransaction(db, 'readonly')
          const names = ordinaryOperationNames(tab.purpose), raw = await Promise.all([
            context.read(() => context!.store.get('browser')), context.read(() => context!.store.get(tab.purpose)), context.read(() => context!.store.get(names.control)),
          ])
          check()
          const br = row(raw[0]), tr = row(raw[1]); if (!br?.frame || !tr?.frame || br.pending || tr.pending) hold()
          b = await openOrdinaryFrame(br.frame, br.key); check(); t = await openOrdinaryFrame(tr.frame, tr.key); check()
          const frameBinding = (image: OrdinaryImage) => ({ purpose: image.purpose, keyId: image.keyId, generation: image.generation, expiresAt: image.expiresAt })
          journal = await openOrdinaryOperationControl(raw[2], { browser: { binding: frameBinding(b), key: br.key }, tab: { binding: frameBinding(t), key: tr.key } }); check()
          if (journal.phase !== 'prepared' || journal.tab !== tab.purpose || t.expiresAt !== tab.expiresAt ||
              journal.result !== null || journal.secrets.length || journal.nonces !== null || journal.target !== null) hold()
          await startup.validateOrdinaryRenewalStartupRows(journal, [br.frame, tr.frame], [b, t]); check()
          const request = requestCodec.readOrdinaryRenewalRequest(journal.request), intent = request.intent
          if (intent.account !== binding.account || intent.participant !== binding.participant || intent.invitationId !== binding.invitationId ||
              intent.keep !== binding.keep || intent.issuedAt > Math.floor(Date.now() / 1000) || intent.expiresAt - Math.floor(Date.now() / 1000) < 600) hold()
          const linkBytes = new TextEncoder().encode(binding.link)
          try { if (bytesToHex(sha256(linkBytes)) !== intent.linkDigest) hold() } finally { linkBytes.fill(0) }
          const packet = encodeOrdinaryOperationJournal(journal); let header: OrdinaryOperationClassification
          try { header = decodeOrdinaryOperationClassification(packet) } finally { packet.fill(0) }
          const target: PreparedRenewalTarget = { purpose: tab.purpose as `tab:${string}`, rows: [rowDigest(br), rowDigest(tr)],
            controlDigest: ordinaryOperationControlDigest(raw[2]), header }
          const facts = await browser.#classifyOperations(binding.live, context, false, target); check()
          const inverse = [copyImage(b), copyImage(t)] as const
          try {
            requestCodec.restoreOrdinaryRenewalPredecessor(inverse[0], inverse[1], journal.request, { id: journal.id, sequence: journal.sequence })
            const markers = new Map(facts.markers), marker = inverse[0].records.get(names.marker)
            if (marker === undefined) markers.delete(names.marker); else markers.set(names.marker, marker)
            browser.#validateCleanupImage(inverse[0], inverse[1], tab, { ...facts, markers: [...markers] }, snapshot)
            const bv = view(new Map(inverse[0].records), false), tv = view(new Map(inverse[1].records), false), inspected = proofs.inspectPersistentAdmissionProofs(bv.store, tv.store)
            try {
              const selected = inspected.selected.get(proofs.accountPrefix(intent.participant) + proofs.PERSISTENT_TAB_PROOF_V2_PREFIX + intent.invitationId)
              if (!selected) hold()
              const prior = inverse[1].records.get(lease.ordinaryMemberLeaseName(selected.proof.binding))
              const bootstrap = prior === undefined ? selected.proof : JSON.parse(lease.readOrdinaryMemberLease(prior, JSON.stringify(selected.proof)).bootstrapProof)
              const first = lease.ordinaryMemberLeaseCredential(bootstrap, bootstrap.binding.device.credentialIds[0]!)
              if (Number(first.tags[2]![1]) !== binding.bootstrapCredentialExpiresAt) hold()
            } finally { inspected.close(); bv.close(); tv.close() }
          } finally { inverse.forEach(clearImage) }
          const bv = view(new Map(b.records), false), tv = view(new Map(t.records), false), custody = Object.freeze({}) as OrdinaryPreparedRenewalCustody
          let callback = false
          const current = () => { if (!callback) hold(); check() }
          preparedCustodies.set(custody, { browser, tab, browserStore: bv.store, tabStore: tv.store, root, check: current })
          try {
            await context.step(() => {
              callback = true
              try {
                check()
                if (binding.account !== null) OrdinaryForegroundSigner.nativePreparedDeadline(binding.identity as OrdinaryForegroundSigner, root, bv.store, tv.store,
                  custody, binding.participant, intent.authority.foregroundExpiresAt)
                else {
                  const secret = b!.records.get('kithmoot.participant'); if (secret === undefined) hold()
                  const bytes = Uint8Array.from(secret.match(/../g)!.map(value => parseInt(value, 16)))
                  try { if (getPublicKey(bytes) !== binding.participant) hold() } finally { bytes.fill(0) }
                }
                check()
              } finally { callback = false }
            })
          } finally { preparedCustodies.delete(custody); bv.close(); tv.close() }
          context.stop(); await context.ended; check()
          const witness = Object.freeze({}) as OrdinaryPreparedRenewalWitness
          const scope = (i: 0 | 1): OrdinaryScope => Object.freeze({ name: request.scopes[i]![1], generation: request.scopes[i]![2], fence: request.scopes[i]![3] })
          const immutableIntent: OrdinaryRenewalIntent = Object.freeze({ ...intent, authority: Object.freeze({ ...intent.authority }),
            sourceRevisions: Object.freeze([...intent.sourceRevisions]) as readonly [number, number],
            sourceFrames: Object.freeze([...intent.sourceFrames]) as readonly [string, string],
            previousMarkers: Object.freeze([...intent.previousMarkers]) as readonly [string | null, string | null] })
          preparedWitnesses.set(witness, { preparation, root, browser, tab, request: journal.request,
            intent: immutableIntent, browserScope: scope(0), tabScope: scope(1), target, classification: facts, claimed: false, signed: false })
          return witness
        } finally {
          context?.stop(); await context?.ended.catch(() => {}); journal?.secrets.forEach(secret => secret.fill(0)); clearImage(b); clearImage(t)
          browser.#resources.delete(cancel); tab.#resources.delete(cancel); db.close()
        }
      })
    }).then(resolve, reject)
    return pending
  }
  /** Fixed prepared-startup producer. It returns only durable result status;
   * no C image, current role, Session or writable continuation escapes. */
  static signPreparedRenewalAtStartup(obligation: OrdinaryRenewalObligation): Promise<Readonly<{ status: 'provider-returned' }>> {
    const held = takeOrdinaryPreparedSigningObligation(obligation), captured = preparedWitnesses.get(held.witness)
    if (!captured || !captured.claimed || captured.signed || captured.root !== held.root || captured.browser !== held.binding.browser.owner ||
        captured.tab !== held.binding.tab.owner || captured.request === '') hold()
    captured.signed = true
    const browser = captured.browser, tab = captured.tab, purpose = tab.purpose as `tab:${string}`, names = ordinaryOperationNames(purpose)
    let resolve!: (value: Readonly<{ status: 'provider-returned' }>) => void, reject!: (error: unknown) => void
    const pending = new Promise<Readonly<{ status: 'provider-returned' }>>((yes, no) => { resolve = yes; reject = no })
    browser.#track(pending); tab.#track(pending)
    let lifetime: OrdinaryRenewalSigningLifetime | undefined
    try {
      held.root.retain(pending)
      if (held.binding.account !== null) {
        lifetime = registerOrdinaryRenewalSigningLifetime({ obligation, pending, signer: held.binding.identity as OrdinaryForegroundSigner })
        OrdinaryForegroundSigner.retainMemberRenewal(held.binding.identity as OrdinaryForegroundSigner, lifetime)
      }
    } catch (error) { releaseOrdinaryRenewalSigningLifetime(lifetime); reject(error); return pending }
    void Promise.resolve().then(async () => {
      const startup = await import('./ordinary-renewal-startup.js'), codec = await import('./ordinary-renewal-request.js'), snapshot = await import('./ordinary-snapshot.js'),
        capacity = await import('./ordinary-prepared-renewal-capacity.js'), credential = await import('./ordinary-renewal-credential.js'), sealModule = await import('../../src/seal.js'),
        nostr = await import('nostr-tools/pure')
      const check = () => { browser.#check(held.binding.live); tab.#check(held.binding.live); checkOrdinaryRenewalSigningObligation(obligation, pending) }
      check(); if (!navigator.locks || browser.#retry || tab.#retry) hold()
      if (lifetime) await OrdinaryForegroundSigner.checkMemberRenewalClients(held.binding.identity as OrdinaryForegroundSigner, lifetime)
      return navigator.locks.request(WRITE_LOCK, async () => {
        const equal = (a: OperationClassification, b: OperationClassification) => JSON.stringify(a) === JSON.stringify(b)
        const binding = (image: OrdinaryImage) => ({ purpose: image.purpose, keyId: image.keyId, generation: image.generation, expiresAt: image.expiresAt })
        const replaceControl = (facts: OperationClassification, digest: string): OperationClassification => Object.freeze({ ...facts,
          controls: Object.freeze(facts.controls.map(([name, value]) => Object.freeze([name, name === names.control ? digest : value] as const))) })
        let expected = captured.classification, active = captured.target, context: OperationTransaction | undefined, db: IDBDatabase | undefined,
          seal: ReturnType<typeof sealModule.generateSealKey> | undefined, nonces: readonly [string, string] | undefined,
          resultNonces: readonly [string, string] | undefined, custodyCompleting = false, providerAvailable = true, providerOpen = true,
          completionArmed = false, completionResult: string | undefined, completionConsumed = false
        const providerRuns = new Set<Promise<unknown>>()
        const cancel = { stop: () => { if (!custodyCompleting) context?.abort() } }; browser.#resources.add(cancel); tab.#resources.add(cancel)
        const reopen = async (custodyOnly = false) => {
          db?.close(); db = await browser.#existingStartupDatabase(custodyOnly ? () => true : held.binding.live, custodyOnly)
          if (!db) hold()
          const opened = db; opened.onversionchange = () => { browser.#revoke(); tab.#revoke(); opened.close() }
        }
        const withE = async <T>(mode: IDBTransactionMode, work: (journal: OrdinaryOperationJournal, rows: readonly [Row, Row], images: readonly [OrdinaryImage, OrdinaryImage]) => T): Promise<T> => {
          let b: OrdinaryImage | undefined, t: OrdinaryImage | undefined, j: OrdinaryOperationJournal | undefined, completed = false
          try {
            check(); await reopen(); check(); context = operationTransaction(db!, mode)
            const raw = await Promise.all([context.read(() => context!.store.get('browser')), context.read(() => context!.store.get(purpose)), context.read(() => context!.store.get(names.control))]); check()
            const br = row(raw[0]), tr = row(raw[1]); if (!br?.frame || !tr?.frame || br.pending || tr.pending) hold()
            b = await openOrdinaryFrame(br.frame, br.key); check(); t = await openOrdinaryFrame(tr.frame, tr.key); check()
            j = await openOrdinaryOperationControl(raw[2], { browser: { binding: binding(b), key: br.key }, tab: { binding: binding(t), key: tr.key } }); check()
            if (j.request !== captured.request || j.id !== captured.target.header.id || j.sequence !== captured.target.header.sequence ||
                j.phase !== active.header.phase || !['prepared', 'provider-started', 'provider-returned'].includes(j.phase) || t.expiresAt !== tab.expiresAt) hold()
            if (j.phase !== 'prepared' && (!seal || !nonces || j.secrets.length !== 1 || !j.secrets[0]!.every((value, i) => value === seal!.secretKey[i]) ||
                JSON.stringify(j.nonces) !== JSON.stringify(nonces))) hold()
            await startup.validateOrdinaryRenewalStartupRows(j, [br.frame, tr.frame], [b, t]); check()
            const facts = await browser.#classifyOperations(held.binding.live, context, false, active); check(); if (!equal(facts, expected)) hold()
            const inverse = [copyImage(b), copyImage(t)] as const
            try {
              codec.restoreOrdinaryRenewalPredecessor(inverse[0], inverse[1], j.request, { id: j.id, sequence: j.sequence })
              const markers = new Map(facts.markers), marker = inverse[0].records.get(names.marker)
              if (marker === undefined) markers.delete(names.marker); else markers.set(names.marker, marker)
              browser.#validateCleanupImage(inverse[0], inverse[1], tab, { ...facts, markers: [...markers] }, snapshot)
              capacity.reserveOrdinaryPreparedRenewalImages(inverse, [b, t], j.request)
            } finally { inverse.forEach(clearImage) }
            const bv = view(new Map(b.records), false), tv = view(new Map(t.records), false), custody = Object.freeze({}) as OrdinaryPreparedRenewalCustody
            let callback = false, value!: T
            preparedCustodies.set(custody, { browser, tab, browserStore: bv.store, tabStore: tv.store, root: held.root, check: () => { if (!callback) hold(); check() } })
            try {
              await context.step(() => {
                callback = true
                try {
                  check()
                  if (held.binding.account !== null) OrdinaryForegroundSigner.nativePreparedDeadline(held.binding.identity as OrdinaryForegroundSigner, held.root,
                    bv.store, tv.store, custody, held.intent.participant, held.intent.authority.foregroundExpiresAt)
                  else {
                    const raw = bv.store.get('kithmoot.participant'); if (raw === null) hold()
                    const key = Uint8Array.from(raw.match(/../g)!.map(part => parseInt(part, 16)))
                    try { if (nostr.getPublicKey(key) !== held.intent.participant) hold() } finally { key.fill(0) }
                  }
                  check(); const result = work(j!, [br, tr], [b!, t!])
                  if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') { void Promise.resolve(result).catch(() => {}); hold() }
                  check(); value = result
                } finally { callback = false }
              })
            } finally { preparedCustodies.delete(custody); bv.close(); tv.close() }
            context.stop(); await context.ended; completed = true; return value
          } finally {
            if (!completed && mode === 'readwrite') context?.abort()
            context?.stop(); await context?.ended.catch(() => {}); context = undefined; j?.secrets.forEach(key => key.fill(0)); clearImage(b); clearImage(t)
          }
        }
        const exactControl = async (journal: OrdinaryOperationJournal, rows: readonly [Row, Row], bindings: readonly [ReturnType<typeof binding>, ReturnType<typeof binding>], sourceCrypto: Crypto) => {
          const desired = encodeOrdinaryOperationJournal(journal), digest = bytesToHex(sha256(desired)); desired.fill(0)
          const input = { browser: { binding: bindings[0], key: rows[0].key }, tab: { binding: bindings[1], key: rows[1].key } }
          const control = await sealOrdinaryOperationControl(journal, input, sourceCrypto), opened = await openOrdinaryOperationControl(control, input)
          try { const actual = encodeOrdinaryOperationJournal(opened); try { if (bytesToHex(sha256(actual)) !== digest) hold() } finally { actual.fill(0) } }
          finally { opened.secrets.forEach(key => key.fill(0)) }
          return control
        }
        const classifiedHeader = (journal: OrdinaryOperationJournal) => {
          const packet = encodeOrdinaryOperationJournal(journal)
          try { return decodeOrdinaryOperationClassification(packet) } finally { packet.fill(0) }
        }
        const reconcile = async (prior: PreparedRenewalTarget, next: PreparedRenewalTarget, priorFacts: OperationClassification,
          targetFacts: OperationClassification, mayRetry: boolean): Promise<'target' | 'prior'> => {
          let retriedPrior = false
          for (;;) {
            let read: OperationTransaction | undefined, isPrior = false
            try {
              await reopen(true); read = operationTransaction(db!, 'readonly')
              const facts = await browser.#classifyOperations(() => true, read, true, [prior, next]); read.stop(); await read.ended
              if (equal(facts, targetFacts)) return 'target'
              isPrior = equal(facts, priorFacts)
            } catch { read?.abort(); await read?.ended.catch(() => {}) } finally { read?.stop() }
            if (isPrior && mayRetry) check()
            if (isPrior && retriedPrior) return 'prior'
            await new Promise<void>(yes => { browser.#retry = yes; tab.#retry = yes })
            browser.#retry = undefined; tab.#retry = undefined; retriedPrior = isPrior
          }
        }
        try {
          const prepared = await withE('readonly', (j, rows, images) => {
            if (j.phase !== 'prepared') hold()
            const zero = '0'.repeat(64), signed = JSON.stringify({ kind: 20460, created_at: held.intent.issuedAt,
              tags: [['d', held.intent.roomId], ['device', held.intent.device], ['expiration', String(held.intent.expiresAt)], ['seal', zero]],
              content: '', pubkey: held.intent.participant, id: zero, sig: zero + zero })
            const resultBytes = new TextEncoder().encode(signed), dummyDigest = bytesToHex(sha256(resultBytes)); resultBytes.fill(0)
            const dummy = new Uint8Array(32).fill(1), dummyNonces = ['0'.repeat(24), '1'.repeat(24)] as const
            try {
              for (const phase of ['provider-started', 'provider-returned', 'candidate-prepared', 'candidate-committed', 'settled'] as const) {
                const privateBody = ['provider-started', 'provider-returned', 'candidate-prepared'].includes(phase), returned = ['provider-returned', 'candidate-prepared', 'candidate-committed'].includes(phase),
                  candidate = ['candidate-prepared', 'candidate-committed', 'settled'].includes(phase)
                const probe: OrdinaryOperationJournal = { ...j, phase, request: phase === 'settled' ? '' : j.request,
                  result: returned ? signed : null, resultDigest: phase === 'provider-started' ? null : dummyDigest,
                  secrets: privateBody ? [dummy] : [], nonces: privateBody ? dummyNonces : null,
                  target: candidate ? ['3'.repeat(64), '4'.repeat(64)] : null,
                  targetRevisions: candidate ? [images[0].revision + 1, images[1].revision + 1] : null }
                const bytes = encodeOrdinaryOperationJournal(probe); bytes.fill(0)
              }
            } finally { dummy.fill(0) }
            return { journal: { ...j, secrets: [], nonces: null }, rows, bindings: [binding(images[0]), binding(images[1])] as const }
          })
          check(); seal = sealModule.generateSealKey(); check()
          const nonce = () => { check(); const bytes = new Uint8Array(12); try { crypto.getRandomValues(bytes); check(); return bytesToHex(bytes) } finally { bytes.fill(0) } }
          const cBrowser = nonce(), cTab = nonce(); nonces = Object.freeze([cBrowser, cTab])
          const resultBrowser = nonce(), resultTab = nonce(); resultNonces = Object.freeze([resultBrowser, resultTab])
          const started: OrdinaryOperationJournal = { ...prepared.journal, phase: 'provider-started', secrets: [seal.secretKey as Uint8Array<ArrayBuffer>], nonces }
          await withE('readonly', () => undefined); check()
          const guardedCrypto = { subtle: crypto.subtle, getRandomValues: <A extends ArrayBufferView>(value: A): A => { check(); const result = crypto.getRandomValues(value); check(); return result } } as unknown as Crypto
          const startedControl = await exactControl(started, prepared.rows, prepared.bindings, guardedCrypto); check()
          const prior = active, priorFacts = expected, next: PreparedRenewalTarget = { ...prior, header: classifiedHeader(started), controlDigest: ordinaryOperationControlDigest(startedControl) }, targetFacts = replaceControl(priorFacts, next.controlDigest)
          for (;;) {
            let attempted = false
            try { await withE('readwrite', () => { const packet = validateOrdinaryOperationControl(startedControl); check(); attempted = true; context!.store.put(packet, names.control) }) }
            catch (error) { if (!attempted) throw error }
            const outcome = await reconcile(prior, next, priorFacts, targetFacts, true)
            if (outcome === 'target') { expected = targetFacts; active = next; break }
          }
          check()
          const statement = await credential.ordinaryRenewalStatement(captured.request, seal.secretKey); check()
          const completion = await withE('readonly', (j, rows, images) => {
            if (j.phase !== 'provider-started') hold()
            return { rows, bindings: [binding(images[0]), binding(images[1])] as const, target: active, facts: expected }
          })
          const captureResult = (result: import('signet-login').NostrEvent) => {
            if (!completionArmed || completionResult !== undefined) hold()
            completionResult = credential.ordinaryRenewalResultForStatement(captured.request, statement, result)
          }
          const finishResult = async () => {
            if (!completionArmed || completionConsumed || completionResult === undefined || !resultNonces || completion.target.header.phase !== 'provider-started') hold()
            completionConsumed = true; custodyCompleting = true
            const bytes = new TextEncoder().encode(completionResult), resultDigest = bytesToHex(sha256(bytes)); bytes.fill(0)
            const returned: OrdinaryOperationJournal = { ...started, phase: 'provider-returned', result: completionResult, resultDigest }
            const fixedNonces = resultNonces.map(value => Uint8Array.from(value.match(/../g)!.map(part => parseInt(part, 16))))
            let used = 0, returnedControl: OrdinaryOperationControl | undefined
            const fixedCrypto = { subtle: crypto.subtle, getRandomValues: <A extends ArrayBufferView>(value: A): A => {
              if (used >= 2 || !(value instanceof Uint8Array) || value.length !== 12) hold(); value.set(fixedNonces[used++]!); return value
            } } as unknown as Crypto
            try {
              while (!returnedControl) {
                used = 0
                try { returnedControl = await exactControl(returned, completion.rows, completion.bindings, fixedCrypto) }
                catch { await new Promise<void>(yes => { browser.#retry = yes; tab.#retry = yes }); browser.#retry = undefined; tab.#retry = undefined }
              }
            } finally { fixedNonces.forEach(value => value.fill(0)) }
            const returnedTarget: PreparedRenewalTarget = { ...completion.target, header: classifiedHeader(returned), controlDigest: ordinaryOperationControlDigest(returnedControl) },
              returnedFacts = replaceControl(completion.facts, returnedTarget.controlDigest)
            for (;;) {
              try {
                await reopen(true); context = operationTransaction(db!, 'readwrite')
                const facts = await browser.#classifyOperations(() => true, context, true, [completion.target, returnedTarget])
                if (equal(facts, returnedFacts)) { context.stop(); await context.ended; expected = returnedFacts; active = returnedTarget; return }
                if (!equal(facts, completion.facts)) hold()
                await context.step(() => { context!.store.put(validateOrdinaryOperationControl(returnedControl!), names.control) })
                context.stop(); await context.ended.catch(() => {})
              } catch { context?.abort(); await context?.ended.catch(() => {}) } finally { context?.stop(); context = undefined }
              if (await reconcile(completion.target, returnedTarget, completion.facts, returnedFacts, false) === 'target') { expected = returnedFacts; active = returnedTarget; return }
            }
          }
          if (held.binding.account === null) {
            let nativeError: unknown
            try {
              await withE('readonly', (_j, _rows, images) => {
                const raw = images[0].records.get('kithmoot.participant'); if (raw === undefined || !providerAvailable) hold()
                const key = Uint8Array.from(raw.match(/../g)!.map(part => parseInt(part, 16)))
                try { if (nostr.getPublicKey(key) !== held.intent.participant) hold(); providerAvailable = false; completionArmed = true
                  captureResult(nostr.finalizeEvent({ ...statement, tags: statement.tags.map(tag => [...tag]) }, key))
                } finally { key.fill(0) }
              })
            } catch (error) { nativeError = error }
            if (completionResult === undefined) { if (nativeError) throw nativeError; hold() }
            try { await finishResult() } finally { custodyCompleting = false }
            if (nativeError) throw nativeError
          } else {
            const boundary: import('signet-login').SignerEffectBoundary = Object.freeze({ start: <T>(provider: () => Promise<T>): Promise<T> => {
              if (!providerOpen || !providerAvailable) return Promise.reject(new OrdinaryStateHold())
              providerAvailable = false
              const run = (async () => {
                let operation: Promise<T> | undefined, result: Promise<T> | undefined, nativeError: unknown
                try {
                  await OrdinaryForegroundSigner.checkMemberRenewalClients(held.binding.identity as OrdinaryForegroundSigner, lifetime!)
                  try { await withE('readonly', () => {
                    completionArmed = true
                    try { operation = Promise.resolve(provider()) } catch (error) { operation = Promise.reject(error) }
                    result = operation.then(value => { captureResult(value as import('signet-login').NostrEvent); return value })
                    browser.#track(operation); tab.#track(operation); browser.#track(result); tab.#track(result); void operation.catch(() => {}); void result.catch(() => {})
                  }) } catch (error) { nativeError = error }
                  if (!operation || !result) hold(); const signed = await result
                  try { await finishResult() } finally { custodyCompleting = false }
                  if (nativeError) throw nativeError
                  return signed
                } finally { if (operation) await Promise.allSettled([operation]) }
              })()
              providerRuns.add(run); browser.#track(run); tab.#track(run); return run
            } })
            const attempt = registerOrdinaryRenewalSigningAttempt(lifetime!, statement, boundary)
            try { await OrdinaryForegroundSigner.signMemberRenewal(held.binding.identity as OrdinaryForegroundSigner, attempt) }
            finally { providerOpen = false; await Promise.allSettled([...providerRuns]) }
          }
          check(); if (active.header.phase !== 'provider-returned' || completionResult === undefined) hold()
          return Object.freeze({ status: 'provider-returned' as const })
        } finally {
          providerOpen = false; await Promise.allSettled([...providerRuns]); context?.abort(); await context?.ended.catch(() => {}); context?.stop(); db?.close()
          seal?.secretKey.fill(0); browser.#resources.delete(cancel); tab.#resources.delete(cancel)
        }
      })
    }).then(resolve, reject).finally(() => releaseOrdinaryRenewalSigningLifetime(lifetime)).catch(() => {})
    return pending
  }
  /** Existing native storage only. Custody-only reopening is private to an
   * attempted fixed write's reconciliation; it never starts a fresh writer. */
  async #existingStartupDatabase(live:()=>boolean,custodyOnly=false):Promise<IDBDatabase|undefined>{
    const check=()=>this.#custodyCheck(live,custodyOnly)
    check();let absent=false,refused=false
    const open=indexedDB.open(ORDINARY_DATABASE,1)
    let finish!:()=>void
    const terminal=this.#track(new Promise<void>(resolve=>{finish=resolve}))
    try{
      const db=await new Promise<IDBDatabase|undefined>((yes,no)=>{
        open.onupgradeneeded=event=>{if(event.oldVersion===0)absent=true;open.transaction!.abort()}
        open.onblocked=()=>{refused=true;no(new OrdinaryStateHold());this.#revoke()}
        open.onerror=()=>{try{if(absent&&!refused)yes(undefined);else no(new OrdinaryStateHold())}finally{finish()}}
        open.onsuccess=()=>{
          const value=open.result
          try{
            if(refused){value.close();return}
            try{check();if(value.version!==1||value.objectStoreNames.length!==1||!value.objectStoreNames.contains(OWNER_STORE))hold();yes(value)}
            catch(error){value.close();no(error)}
          }finally{finish()}
        }
      });try{check()}catch(error){db?.close();throw error}
      return db
    }finally{
      // A blocked decision revokes immediately, but the native request has
      // no cancellation API. Keep its owner and enclosing lock joined until
      // an error or a closed late success establishes the terminal outcome.
      await terminal
    }
  }
  /** Inspect storage before factory construction, new custody or expiry. The
   * one native read is separate from ordinary pair custody: it publishes no
   * owner caches, view, key, phase grant, signer or writable continuation. */
  inspectRenewalStartup(live:()=>boolean):Promise<OrdinaryRenewalStartupDisposition>{
    if(this.purpose!=='browser'||this.expiresAt!==0)hold()
    const pending=Promise.resolve().then(async()=>{
      this.#check(live);const inspector=await import('./ordinary-renewal-startup.js');this.#check(live)
      if(this.#retry||!navigator.locks)hold()
      return navigator.locks.request(WRITE_LOCK,async()=>{
        this.#check(live)
        // Abort an absent database upgrade. Classification must not install a
        // new database or turn a missing origin into fresh key allocation.
        const db=await this.#existingStartupDatabase(live)
        if(!db)return Object.freeze({status:'empty',operations:Object.freeze([])}) as OrdinaryRenewalStartupDisposition
        let context:OperationTransaction|undefined
        const cancel={stop:()=>context?.abort()};this.#resources.add(cancel)
        db.onversionchange=()=>{this.#revoke();db.close()}
        try{
          context=operationTransaction(db,'readonly')
          const keys=await context.read(()=>context!.store.getAllKeys(undefined,2*MAX_ORDINARY_TAB_OWNERS+2));this.#check(live)
          if(keys.length>2*MAX_ORDINARY_TAB_OWNERS+1)hold()
          const targets:PreparedRenewalTarget[]=[],operations:OrdinaryRenewalStartupDisposition['operations'][number][]=[]
          for(const key of keys){
            if(typeof key!=='string')hold()
            if(!key.startsWith(ORDINARY_OPERATION_CONTROL_PREFIX))continue
            if(key.length!==ORDINARY_OPERATION_CONTROL_PREFIX.length+64||!/^[0-9a-f]{64}$/.test(key.slice(ORDINARY_OPERATION_CONTROL_PREFIX.length)))hold()
            const purpose=('tab:'+key.slice(ORDINARY_OPERATION_CONTROL_PREFIX.length)) as `tab:${string}`
            const raw=await Promise.all([context.read(()=>context!.store.get('browser')),context.read(()=>context!.store.get(purpose)),context.read(()=>context!.store.get(key))]);this.#check(live)
            const br=row(raw[0]),tr=row(raw[1]);if(!br?.frame||!tr?.frame)hold()
            let b:OrdinaryImage|undefined,t:OrdinaryImage|undefined,j:OrdinaryOperationJournal|undefined
            try{
              b=await openOrdinaryFrame(br.frame,br.key);this.#check(live);t=await openOrdinaryFrame(tr.frame,tr.key);this.#check(live)
              const binding=(image:OrdinaryImage)=>({purpose:image.purpose,keyId:image.keyId,generation:image.generation,expiresAt:image.expiresAt})
              j=await openOrdinaryOperationControl(raw[2],{browser:{binding:binding(b),key:br.key},tab:{binding:binding(t),key:tr.key}});this.#check(live)
              if(j.tab!==purpose)hold()
              if(j.phase!=='settled'){
                if(br.pending||tr.pending)hold()
                await inspector.validateOrdinaryRenewalStartupRows(j,[br.frame,tr.frame],[b,t]);this.#check(live)
                const bytes=encodeOrdinaryOperationJournal(j)
                let header:OrdinaryOperationClassification;try{header=decodeOrdinaryOperationClassification(bytes)}finally{bytes.fill(0)}
                targets.push({purpose,rows:[rowDigest(br),rowDigest(tr)],controlDigest:ordinaryOperationControlDigest(raw[2]),header})
              }
              operations.push(Object.freeze({tab:purpose,id:j.id,sequence:j.sequence,phase:j.phase}))
            }finally{j?.secrets.forEach(secret=>secret.fill(0));clearImage(b);clearImage(t)}
          }
          // Reuse whole-origin structural authentication without installing
          // these fixed startup targets into any ordinary-owner cache.
          await this.#classifyOperations(live,context,false,targets);this.#check(live)
          context.stop();await context.ended;this.#check(live)
          return Object.freeze({status:targets.length?'recovery-required':'ordinary',operations:Object.freeze(operations)}) as OrdinaryRenewalStartupDisposition
        }catch{context?.abort();await context?.ended.catch(()=>{});hold()}
        finally{context?.stop();this.#resources.delete(cancel);db.close()}
      })
    })
    return this.#track(pending)
  }
  /** Fixed startup C->S custody maintenance only. Historical expiry grants
   * no effects; fresh startup-owner liveness controls this neutral projection.
   * No journal, image, writer, signer, current role or adoption token is input. */
  recoverCommittedRenewalAtStartup(purpose:`tab:${string}`,live:()=>boolean):Promise<Readonly<{status:'settled'|'already-settled'}>>{
    if(this.purpose!=='browser'||this.expiresAt!==0||typeof purpose!=='string'||!TAB_PURPOSE.test(purpose)||typeof live!=='function')hold()
    const pending=Promise.resolve().then(async()=>{
      const inspector=await import('./ordinary-renewal-startup.js'),snapshot=await import('./ordinary-snapshot.js')
      const check=()=>this.#check(live);check();if(this.#retry||!navigator.locks)hold()
      return navigator.locks.request(WRITE_LOCK,async()=>{
        check();const names=ordinaryOperationNames(purpose),equal=(a:OperationClassification,b:OperationClassification)=>JSON.stringify(a)===JSON.stringify(b)
        let context:OperationTransaction|undefined,db:IDBDatabase|undefined,attempted=false,expected:OperationClassification|undefined
        const cancel={stop:()=>context?.abort()};this.#resources.add(cancel)
        const reopen=async(custodyOnly=false)=>{
          db?.close();db=await this.#existingStartupDatabase(custodyOnly?()=>true:live,custodyOnly)
          if(!db)hold();const opened=db;opened.onversionchange=()=>{this.#revoke();opened.close()}
        }
        const binding=(image:Pick<OrdinaryImage,'purpose'|'keyId'|'generation'|'expiresAt'>)=>({purpose:image.purpose,keyId:image.keyId,generation:image.generation,expiresAt:image.expiresAt})
        /** This callback is private fixed construction/put plumbing only. It
         * runs in the same coherent native C transaction as final validation. */
        const withC=async<T>(mode:IDBTransactionMode,work:(j:OrdinaryOperationJournal,rows:readonly [Row,Row],images:readonly [OrdinaryImage,OrdinaryImage],facts:OperationClassification,prior:PreparedRenewalTarget)=>T):Promise<T>=>{
          let b:OrdinaryImage|undefined,t:OrdinaryImage|undefined,j:OrdinaryOperationJournal|undefined,done=false
          try{
            check();await reopen();check();context=operationTransaction(db!,mode)
            const raw=await Promise.all([context.read(()=>context!.store.get('browser')),context.read(()=>context!.store.get(purpose)),context.read(()=>context!.store.get(names.control))]);check()
            const br=row(raw[0]),tr=row(raw[1]);if(!br?.frame||!tr?.frame||br.pending||tr.pending)hold()
            b=await openOrdinaryFrame(br.frame,br.key);check();t=await openOrdinaryFrame(tr.frame,tr.key);check()
            j=await openOrdinaryOperationControl(raw[2],{browser:{binding:binding(b),key:br.key},tab:{binding:binding(t),key:tr.key}});check()
            if(j.tab!==purpose||j.phase!=='candidate-committed')hold()
            await inspector.validateOrdinaryRenewalStartupRows(j,[br.frame,tr.frame],[b,t]);check()
            const packet=encodeOrdinaryOperationJournal(j);let header:OrdinaryOperationClassification
            try{header=decodeOrdinaryOperationClassification(packet)}finally{packet.fill(0)}
            const selected:PreparedRenewalTarget={purpose,rows:[rowDigest(br),rowDigest(tr)],controlDigest:ordinaryOperationControlDigest(raw[2]),header}
            const facts=await this.#classifyOperations(live,context,false,selected);check();if(expected&&!equal(facts,expected))hold()
            const historicalTab=new OrdinaryStateOwner(purpose,t.expiresAt)
            this.#validateCleanupImage(b,t,historicalTab,facts,snapshot);check()
            let result!:T
            await context.step(()=>{check();const value=work(j!,[br,tr],[b!,t!],facts,selected)
              if(value&&typeof(value as unknown as PromiseLike<unknown>).then==='function'){void Promise.resolve(value).catch(()=>{});hold()};check();result=value})
            context.stop();await context.ended;done=true;return result
          }finally{if(!done&&mode==='readwrite')context?.abort();context?.stop();await context?.ended.catch(()=>{});context=undefined;j?.secrets.forEach(secret=>secret.fill(0));clearImage(b);clearImage(t)}
        }
        try{
          // Already settled is reported only after a complete fresh ordinary
          // classification. It still supplies no current controller authority.
          const disposition=await (async()=>{
            check();await reopen();context=operationTransaction(db!,'readonly')
            try{const raw=await context.read(()=>context!.store.get(names.control));check()
              const br=row(await context.read(()=>context!.store.get('browser'))),tr=row(await context.read(()=>context!.store.get(purpose)));check()
              if(!br?.frame||!tr?.frame)hold()
              const header=await openOrdinaryOperationClassification(raw,{browser:{binding:binding(br.frame),key:br.key},tab:{binding:binding(tr.frame),key:tr.key}});check()
              if(header.phase==='settled'){await this.#classifyOperations(live,context);context.stop();await context.ended;check();return true}return false
            }finally{context?.stop();await context?.ended.catch(()=>{});context=undefined}
          })()
          if(disposition)return Object.freeze({status:'already-settled'})
          const prepared=await withC('readonly',(journal,rows,images,facts,prior)=>{
            expected=facts
            const settled:OrdinaryOperationJournal={...journal,phase:'settled',request:'',result:null,secrets:[],nonces:null},packet=encodeOrdinaryOperationJournal(settled)
            let header:OrdinaryOperationClassification;try{header=decodeOrdinaryOperationClassification(packet)}finally{packet.fill(0)}
            const marker=ordinaryOperationMarker({id:journal.id,tab:journal.tab,sequence:journal.sequence,commitment:ordinaryOperationCommitment(header)}),copies=[copyImage(images[0]),copyImage(images[1])] as const
            let success=false
            try{for(const image of copies){(image.records as Map<string,string>).set(names.marker,marker);image.revision++;ordinaryImageByteLength(image)}
              success=true;return{journal:settled,header,marker,images:copies,rows,prior,bindings:[binding(images[0]),binding(images[1])] as const}}
            finally{if(!success)copies.forEach(clearImage)}
          })
          check()
          const guardedCrypto={subtle:crypto.subtle,getRandomValues:<A extends ArrayBufferView>(value:A):A=>{check();const result=crypto.getRandomValues(value);check();return result}} as unknown as Crypto
          let sf:OrdinaryFrame,st:OrdinaryFrame
          try{sf=await sealOrdinaryImage(prepared.images[0],prepared.rows[0].key,guardedCrypto);check();st=await sealOrdinaryImage(prepared.images[1],prepared.rows[1].key,guardedCrypto);check()}
          finally{prepared.images.forEach(clearImage)}
          const control=await sealOrdinaryOperationControl(prepared.journal,{browser:{binding:prepared.bindings[0],key:prepared.rows[0].key},tab:{binding:prepared.bindings[1],key:prepared.rows[1].key}},guardedCrypto);check()
          const frames=Object.freeze([sf,st]) as readonly [OrdinaryFrame,OrdinaryFrame],next:PreparedRenewalTarget={purpose,rows:[rowDigest({frame:sf} as Row),rowDigest({frame:st} as Row)],
            controlDigest:ordinaryOperationControlDigest(control),header:prepared.header},target:OperationClassification=Object.freeze({...expected!,
              owners:Object.freeze(expected!.owners.map(([name,digest])=>Object.freeze([name,name==='browser'?next.rows[0]:name===purpose?next.rows[1]:digest] as const))),
              controls:Object.freeze(expected!.controls.map(([name,digest])=>Object.freeze([name,name===names.control?next.controlDigest:digest] as const))),
              markers:Object.freeze(expected!.markers.map(([name,marker])=>Object.freeze([name,name===names.marker?prepared.marker:marker] as const)))})
          for(;;){
            attempted=false
            try{await withC('readwrite',(_j,rows)=>{
              const br={key:rows[0].key,frame:validateOrdinaryFrame(frames[0])},tr={key:rows[1].key,frame:validateOrdinaryFrame(frames[1])},packet=validateOrdinaryOperationControl(control)
              check();attempted=true;context!.store.put(br,'browser');check();context!.store.put(tr,purpose);check();context!.store.put(packet,names.control)
            })}catch(error){if(!attempted)throw error}
            let retriedPrior=false
            for(;;){
              let read:OperationTransaction|undefined,isPrior=false
              try{await reopen(true);read=operationTransaction(db!,'readonly');const current=await this.#classifyOperations(()=>true,read,true,[prepared.prior,next]);read.stop();await read.ended
                if(equal(current,target))return Object.freeze({status:'settled'})
                isPrior=equal(current,expected!)
              }catch{read?.abort();await read?.ended.catch(()=>{})}finally{read?.stop()}
              if(isPrior){check();if(retriedPrior)break}
              await new Promise<void>(yes=>{this.#retry=yes});this.#retry=undefined;retriedPrior=isPrior
            }
          }
        }finally{context?.abort();await context?.ended.catch(()=>{});context?.stop();db?.close();this.#resources.delete(cancel)}
      })
    })
    return this.#track(pending)
  }
  /** Fixed retained-result E->C startup custody. This creates no current
   * role, provider attempt, key, seal, credential or adoption capability. */
  recoverRetainedRenewalAtStartup(purpose:`tab:${string}`,live:()=>boolean):Promise<Readonly<{status:'candidate-committed'|'already-committed'|'already-settled'}>>{
    if(this.purpose!=='browser'||this.expiresAt!==0||typeof purpose!=='string'||!TAB_PURPOSE.test(purpose)||typeof live!=='function')hold()
    const pending=Promise.resolve().then(async()=>{
      const inspector=await import('./ordinary-renewal-startup.js'),snapshot=await import('./ordinary-snapshot.js'),
        requestCodec=await import('./ordinary-renewal-request.js'),candidateModule=await import('./ordinary-renewal-candidate.js')
      const check=()=>this.#check(live);check();if(this.#retry||!navigator.locks)hold()
      return navigator.locks.request(WRITE_LOCK,async()=>{
        check();const names=ordinaryOperationNames(purpose),equal=(a:OperationClassification,b:OperationClassification)=>JSON.stringify(a)===JSON.stringify(b)
        let context:OperationTransaction|undefined,db:IDBDatabase|undefined,expected:OperationClassification|undefined,active:PreparedRenewalTarget|undefined,
          retainedJournal:OrdinaryOperationJournal|undefined,candidateImages:readonly [OrdinaryImage,OrdinaryImage]|undefined
        const cancel={stop:()=>context?.abort()};this.#resources.add(cancel)
        const reopen=async(custodyOnly=false)=>{db?.close();db=await this.#existingStartupDatabase(custodyOnly?()=>true:live,custodyOnly)
          if(!db)hold();const opened=db;opened.onversionchange=()=>{this.#revoke();opened.close()}}
        const binding=(image:Pick<OrdinaryImage,'purpose'|'keyId'|'generation'|'expiresAt'>)=>({purpose:image.purpose,keyId:image.keyId,generation:image.generation,expiresAt:image.expiresAt})
        const headerFor=(journal:OrdinaryOperationJournal)=>{const packet=encodeOrdinaryOperationJournal(journal)
          try{return decodeOrdinaryOperationClassification(packet)}finally{packet.fill(0)}}
        /** Private fixed preparation/write plumbing. No callback or journal
         * input is accepted by the exported startup entry point. */
        const withNative=async<T>(mode:IDBTransactionMode,work:(journal:OrdinaryOperationJournal,rows:readonly [Row,Row],images:readonly [OrdinaryImage,OrdinaryImage],
          inverse:readonly [OrdinaryImage,OrdinaryImage]|undefined,facts:OperationClassification,selected:PreparedRenewalTarget)=>T):Promise<T>=>{
          let b:OrdinaryImage|undefined,t:OrdinaryImage|undefined,j:OrdinaryOperationJournal|undefined,inverse:readonly [OrdinaryImage,OrdinaryImage]|undefined,done=false
          try{
            check();await reopen();check();context=operationTransaction(db!,mode)
            const raw=await Promise.all([context.read(()=>context!.store.get('browser')),context.read(()=>context!.store.get(purpose)),context.read(()=>context!.store.get(names.control))]);check()
            const br=row(raw[0]),tr=row(raw[1]);if(!br?.frame||!tr?.frame||br.pending||tr.pending)hold()
            b=await openOrdinaryFrame(br.frame,br.key);check();t=await openOrdinaryFrame(tr.frame,tr.key);check()
            j=await openOrdinaryOperationControl(raw[2],{browser:{binding:binding(b),key:br.key},tab:{binding:binding(t),key:tr.key}});check()
            if(j.tab!==purpose||!['provider-returned','candidate-prepared','candidate-committed','settled'].includes(j.phase)||
              active&&(j.id!==active.header.id||j.sequence!==active.header.sequence||j.phase!==active.header.phase))hold()
            if(j.phase!=='settled'){await inspector.validateOrdinaryRenewalStartupRows(j,[br.frame,tr.frame],[b,t]);check()}
            const selected:PreparedRenewalTarget={purpose,rows:[rowDigest(br),rowDigest(tr)],controlDigest:ordinaryOperationControlDigest(raw[2]),header:headerFor(j)}
            const facts=await this.#classifyOperations(live,context,false,j.phase==='settled'?undefined:selected);check();if(expected&&!equal(facts,expected))hold()
            const historicalTab=new OrdinaryStateOwner(purpose,t.expiresAt)
            if(j.phase==='provider-returned'||j.phase==='candidate-prepared'){
              inverse=[copyImage(b),copyImage(t)]
              requestCodec.restoreOrdinaryRenewalPredecessor(inverse[0],inverse[1],j.request,{id:j.id,sequence:j.sequence})
              const oldMarker=inverse[0].records.get(names.marker),historicalFacts:OperationClassification={...facts,
                markers:facts.markers.flatMap(([name,value])=>name!==names.marker?[[name,value] as const]:oldMarker===undefined?[]:[[name,oldMarker] as const])}
              this.#validateCleanupImage(inverse[0],inverse[1],historicalTab,historicalFacts,snapshot);check()
            }else if(j.phase==='candidate-committed'){this.#validateCleanupImage(b,t,historicalTab,facts,snapshot);check()}
            let result!:T
            await context.step(()=>{check();const value=work(j!,[br,tr],[b!,t!],inverse,facts,selected)
              if(value&&typeof(value as unknown as PromiseLike<unknown>).then==='function'){void Promise.resolve(value).catch(()=>{});hold()};check();result=value})
            context.stop();await context.ended;done=true;return result
          }finally{if(!done&&mode==='readwrite')context?.abort();context?.stop();await context?.ended.catch(()=>{});context=undefined;
            j?.secrets.forEach(secret=>secret.fill(0));inverse?.forEach(clearImage);clearImage(b);clearImage(t)}
        }
        const guardedCrypto={subtle:crypto.subtle,getRandomValues:<A extends ArrayBufferView>(value:A):A=>{check();const result=crypto.getRandomValues(value);check();return result}} as unknown as Crypto
        try{
          const prepared=await withNative('readonly',(journal,rows,images,inverse,facts,selected)=>{
            expected=facts;active=selected
            if(journal.phase==='settled'||journal.phase==='candidate-committed')return {terminal:journal.phase}
            if(!inverse||!journal.result||journal.secrets.length!==1||!journal.nonces)hold()
            retainedJournal={...journal,secrets:journal.secrets.map(secret=>secret.slice())}
            candidateImages=candidateModule.prepareOrdinaryRetainedRenewalCandidate(inverse,journal.request,journal.result,journal.secrets[0]!,images)
            const historicalTab=new OrdinaryStateOwner(purpose,images[1].expiresAt)
            this.#validateCleanupImage(candidateImages[0],candidateImages[1],historicalTab,facts,snapshot);check()
            candidateImages.forEach(ordinaryImageByteLength)
            // Digest placeholders have the same exact encoded lengths as real
            // digests; choose values distinct from every P/E digest.
            const used=new Set([...journal.source,...journal.enrolled]),placeholder=['0','1','2','3','4'].map(v=>v.repeat(64)).find(v=>!used.has(v))!
            const reservation:OrdinaryOperationJournal={...retainedJournal,phase:'candidate-prepared',target:[placeholder,placeholder],targetRevisions:[candidateImages[0].revision,candidateImages[1].revision]}
            headerFor(reservation);headerFor({...reservation,phase:'candidate-committed',secrets:[],nonces:null})
            return{rows,bindings:[binding(images[0]),binding(images[1])] as const,imageSemanticDigest:ordinaryOperationSemanticDigest(candidateImages[0],candidateImages[1])}
          })
          if('terminal' in prepared)return Object.freeze({status:prepared.terminal==='settled'?'already-settled':'already-committed'})
          check();if(!retainedJournal?.nonces||!candidateImages)hold()
          const freeze=async(image:OrdinaryImage,key:CryptoKey,encoded:string)=>{
            const bytes=Uint8Array.from(encoded.match(/../g)!.map(value=>parseInt(value,16)));let used=false
            const fixedCrypto={subtle:crypto.subtle,getRandomValues:<A extends ArrayBufferView>(value:A):A=>{
              check();if(used||!(value instanceof Uint8Array)||value.length!==12)hold();used=true;value.set(bytes);check();return value}} as unknown as Crypto
            try{const frame=await sealOrdinaryImage(image,key,fixedCrypto);check();return frame}finally{bytes.fill(0);clearImage(image)}
          }
          const cf=await freeze(candidateImages[0],prepared.rows[0].key,retainedJournal.nonces[0]);check()
          const ct=await freeze(candidateImages[1],prepared.rows[1].key,retainedJournal.nonces[1]);check()
          // Reopening the actual frozen frames confirms that encryption kept
          // the complete uniquely projected plaintext before phase wrapping.
          let cb:OrdinaryImage|undefined,ctab:OrdinaryImage|undefined
          try{cb=await openOrdinaryFrame(cf,prepared.rows[0].key);check();ctab=await openOrdinaryFrame(ct,prepared.rows[1].key);check()
            if(ordinaryOperationSemanticDigest(cb,ctab)!==prepared.imageSemanticDigest)hold()}
          finally{clearImage(cb);clearImage(ctab)}
          const frames=Object.freeze([cf,ct]) as readonly [OrdinaryFrame,OrdinaryFrame],digests=[ordinaryFrameDigest(cf),ordinaryFrameDigest(ct)] as const,revisions=[cf.revision,ct.revision] as const
          if(retainedJournal.phase==='candidate-prepared'&&(!retainedJournal.target||!retainedJournal.targetRevisions||
            retainedJournal.target.some((value,i)=>value!==digests[i])||retainedJournal.targetRevisions.some((value,i)=>value!==revisions[i])))hold()
          const candidatePrepared:OrdinaryOperationJournal={...retainedJournal,phase:'candidate-prepared',target:digests,targetRevisions:revisions}
          const preparedHeader=headerFor(candidatePrepared),committed:OrdinaryOperationJournal={...candidatePrepared,phase:'candidate-committed',secrets:[],nonces:null},committedHeader=headerFor(committed)
          /** The only two physical transitions: one prepared control, then
           * the fixed three-row C cohort. No arbitrary writer is exported. */
          const writeFixed=async(stage:'prepare'|'commit',control:OrdinaryOperationControl,header:OrdinaryOperationClassification)=>{
            if(!active||!expected||stage==='prepare'&&(active.header.phase!=='provider-returned'||header.phase!=='candidate-prepared')||
              stage==='commit'&&(active.header.phase!=='candidate-prepared'||header.phase!=='candidate-committed'))hold()
            const prior=active,priorFacts=expected,next:PreparedRenewalTarget={purpose,
              rows:stage==='prepare'?prior.rows:[rowDigest({frame:frames[0]} as Row),rowDigest({frame:frames[1]} as Row)],controlDigest:ordinaryOperationControlDigest(control),header}
            const target:OperationClassification=Object.freeze({...priorFacts,
              owners:Object.freeze(priorFacts.owners.map(([name,digest])=>Object.freeze([name,name==='browser'?next.rows[0]:name===purpose?next.rows[1]:digest] as const))),
              controls:Object.freeze(priorFacts.controls.map(([name,digest])=>Object.freeze([name,name===names.control?next.controlDigest:digest] as const)))})
            for(;;){
              let attempted=false
              try{await withNative('readwrite',(journal,rows)=>{
                if(stage==='commit'&&(!journal.target||!journal.targetRevisions||journal.target.some((value,i)=>value!==digests[i])||
                  journal.targetRevisions.some((value,i)=>value!==revisions[i])))hold()
                const packet=validateOrdinaryOperationControl(control)
                if(stage==='prepare'){check();attempted=true;context!.store.put(packet,names.control)}
                else{const br={key:rows[0].key,frame:validateOrdinaryFrame(frames[0])},tr={key:rows[1].key,frame:validateOrdinaryFrame(frames[1])}
                  check();attempted=true;context!.store.put(br,'browser');check();context!.store.put(tr,purpose);check();context!.store.put(packet,names.control)}
              })}catch(error){if(!attempted)throw error}
              let retriedPrior=false
              for(;;){
                let read:OperationTransaction|undefined,isPrior=false
                try{await reopen(true);read=operationTransaction(db!,'readonly');const current=await this.#classifyOperations(()=>true,read,true,[prior,next]);read.stop();await read.ended
                  if(equal(current,target)){active=next;expected=target;return}isPrior=equal(current,priorFacts)
                }catch{read?.abort();await read?.ended.catch(()=>{})}finally{read?.stop()}
                if(isPrior){check();if(retriedPrior)break}
                await new Promise<void>(yes=>{this.#retry=yes});this.#retry=undefined;retriedPrior=isPrior
              }
            }
          }
          if(retainedJournal.phase==='provider-returned'){
            await withNative('readonly',()=>undefined);check()
            const control=await sealOrdinaryOperationControl(candidatePrepared,{browser:{binding:prepared.bindings[0],key:prepared.rows[0].key},tab:{binding:prepared.bindings[1],key:prepared.rows[1].key}},guardedCrypto);check()
            await writeFixed('prepare',control,preparedHeader);check()
          }
          await withNative('readonly',()=>undefined);check()
          const control=await sealOrdinaryOperationControl(committed,{browser:{binding:prepared.bindings[0],key:prepared.rows[0].key},tab:{binding:prepared.bindings[1],key:prepared.rows[1].key}},guardedCrypto);check()
          await writeFixed('commit',control,committedHeader)
          return Object.freeze({status:'candidate-committed'})
        }finally{retainedJournal?.secrets.forEach(secret=>secret.fill(0));candidateImages?.forEach(clearImage);
          context?.abort();await context?.ended.catch(()=>{});context?.stop();db?.close();this.#resources.delete(cancel)}
      })
    })
    return this.#track(pending)
  }
  /** Classify the whole origin before ordinary callbacks, single-row intent
   * promotion or expiry cleanup. The coherent reader stays alive across native
   * crypto; rows are opened one at a time rather than cloning every large tab
   * into memory. An active journal grants no ordinary read/write capability. */
  async #operationBarrier(live: () => boolean): Promise<void> {
    const context = operationTransaction(await this.#database(live), 'readonly'), cancel = { stop: context.abort }
    this.#resources.add(cancel)
    try {
      const classified = await this.#classifyOperations(live, context)
      context.stop(); await context.ended; this.#check(live)
      this.#operationControlDigests = new Map(classified.controls)
      this.#operationMarkerValues = new Map(classified.markers)
      this.#operationControls = new Set(classified.controls.map(([name]) => 'tab:' + name.slice(ORDINARY_OPERATION_CONTROL_PREFIX.length)))
    } catch { context.abort(); await context.ended.catch(() => {}); hold() }
    finally { context.stop(); this.#resources.delete(cancel) }
  }
  /** Immutable classification local to this coherent transaction. Fixed
   * writers never publish a partially authenticated scan into owner caches. */
  async #classifyOperations(live: () => boolean, context: OperationTransaction, reconciling = false, prepared?:PreparedRenewalTarget|readonly PreparedRenewalTarget[]): Promise<OperationClassification> {
    const store = context.store, read = context.read
    let browserImage: OrdinaryImage | undefined
    const check = () => this.#custodyCheck(live, reconciling)
    const controlNames = new Set<string>(), tabNames = new Set<string>(), controlDigests = new Map<string,string>(), ownerDigests = new Map<string,string>()
    const isTab = (name: string) => name.length === 68 && TAB_PURPOSE.test(name)
    const marked = (image: OrdinaryImage) => [...image.records].filter(([name]) => name.startsWith('kithmoot.operation-journal'))
    try {
      const keys = await read(() => store.getAllKeys(undefined, 2 * MAX_ORDINARY_TAB_OWNERS + 2)); check()
      if (keys.length > 2 * MAX_ORDINARY_TAB_OWNERS + 1) hold()
      for (const key of keys) {
        if (typeof key !== 'string') hold()
        if (key === 'browser') continue
        if (isTab(key)) tabNames.add(key)
        else if (key.startsWith(ORDINARY_OPERATION_CONTROL_PREFIX) && key.length === ORDINARY_OPERATION_CONTROL_PREFIX.length + 64 &&
          /^[0-9a-f]{64}$/.test(key.slice(ORDINARY_OPERATION_CONTROL_PREFIX.length))) controlNames.add(key)
        else hold()
      }
      if (tabNames.size > MAX_ORDINARY_TAB_OWNERS || controlNames.size > MAX_ORDINARY_TAB_OWNERS) hold()
      const open = async (name: string): Promise<{ key: CryptoKey; image: OrdinaryImage } | undefined> => {
        const saved = row(await read(() => store.get(name))); check()
        if (!saved) return undefined
        ownerDigests.set(name, rowDigest(saved))
        let active: OrdinaryImage | undefined, intended: OrdinaryImage | undefined
        try {
          for (const frame of [saved.frame, saved.pending]) {
            if (!frame) continue
            let image: OrdinaryImage | undefined = await openOrdinaryFrame(frame, saved.key)
            try {
              check()
              if (image.purpose !== name || !controlNames.size && marked(image).length) hold()
              if (frame === saved.frame) active = image
              else intended = image
              image = undefined
            } finally { clearImage(image) }
          }
          if (intended && active) {
            if (intended.keyId !== active.keyId || intended.generation !== active.generation || intended.expiresAt !== active.expiresAt ||
                intended.revision !== active.revision + 1 || [...active.fences].some(([name, fence]) => (intended!.fences.get(name) ?? 0) < fence)) hold()
            preserveOperationMarkers(active.records, intended.records)
          } else if (intended && marked(intended).length) hold()
          if (!active) return undefined
          const result = { key: saved.key, image: active }; active = undefined; return result
        } finally { clearImage(active); clearImage(intended) }
      }
      const browser = keys.includes('browser') ? await open('browser') : undefined
      browserImage = browser?.image
      if (controlNames.size && !browser) hold()
      const browserMarkers = new Map<string, string>()
      if (browser) for (const [name, raw] of marked(browser.image)) {
        const value = validateOrdinaryOperationMarker(raw), names = ordinaryOperationNames(value.tab)
        if (name !== names.marker || !controlNames.has(names.control) || browserMarkers.has(value.tab)) hold()
        browserMarkers.set(value.tab, raw)
      }
      for (const purpose of tabNames) {
        const opened = await open(purpose)
        if (!opened) continue
        const names = ordinaryOperationNames(purpose as OrdinaryPurpose), markers = marked(opened.image)
        try {
          if (!controlNames.has(names.control)) { if (markers.length) hold(); continue }
          if (markers.length !== 1 || markers[0]![0] !== names.marker || !browserMarkers.has(purpose) ||
              markers[0]![1] !== browserMarkers.get(purpose) || opened.image.migration?.phase !== 'complete' ||
              browser!.image.migration?.phase !== 'complete') hold()
          const header = (image: OrdinaryImage) => ({ purpose: image.purpose, keyId: image.keyId,
            generation: image.generation, expiresAt: image.expiresAt })
          const control = await read(() => store.get(names.control)); check()
          const journal = await openOrdinaryOperationClassification(control, { browser: { binding: header(browser!.image), key: browser!.key },
            tab: { binding: header(opened.image), key: opened.key } }); check()
          const candidates:readonly PreparedRenewalTarget[]=prepared?('purpose' in prepared?[prepared]:prepared):[]
          const selected=candidates.find(target=>target.purpose===purpose&&target.header.phase===journal.phase)
          if(selected&&journal.phase!=='settled'){
            const digest=ordinaryOperationControlDigest(control)
            if(digest!==selected.controlDigest||JSON.stringify(journal)!==JSON.stringify(selected.header)||
              ownerDigests.get('browser')!==selected.rows[0]||ownerDigests.get(purpose)!==selected.rows[1])hold()
            const marker=ordinaryOperationMarker({id:journal.id,tab:journal.tab,sequence:journal.sequence,commitment:null})
            if(marker!==markers[0]![1])hold()
            controlDigests.set(names.control,digest);controlNames.delete(names.control);continue
          }
          if (journal.phase !== 'settled') hold()
          const expected = ordinaryOperationMarker({ id: journal.id, tab: journal.tab, sequence: journal.sequence, commitment: ordinaryOperationCommitment(journal) })
          if (expected !== markers[0]![1] || journal.phase !== 'settled' || !journal.targetRevisions ||
              browser!.image.revision <= journal.targetRevisions[0] || opened.image.revision <= journal.targetRevisions[1]) hold()
          for (const [owner, name, generation, fence] of journal.scopes) {
            const current = owner === 'browser' ? browser!.image : opened.image
            if (current.purpose !== owner || current.generation !== generation || (current.fences.get(name) ?? 0) < fence) hold()
          }
          controlDigests.set(names.control, ordinaryOperationControlDigest(control))
          controlNames.delete(names.control)
        } finally { clearImage(opened.image) }
      }
      if (controlNames.size || browserMarkers.size !== keys.filter(key => typeof key === 'string' && key.startsWith(ORDINARY_OPERATION_CONTROL_PREFIX)).length) hold()
      const sorted = (values: ReadonlyMap<string,string>) => Object.freeze([...values].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(pair => Object.freeze(pair)))
      return Object.freeze({ owners: sorted(ownerDigests), controls: sorted(controlDigests),
        markers: sorted(new Map([...browserMarkers].map(([purpose, raw]) => [ordinaryOperationNames(purpose as OrdinaryPurpose).marker, raw]))) })
    } catch { hold() }
    finally { clearImage(browserImage) }
  }
  /** Re-read in the consumer's own coherent transaction. A control inserted,
   * removed or changed after classification cannot inherit old provenance. */
  #operationControlSnapshot(store: IDBObjectStore): Promise<void> {
    return new Promise((resolve, reject) => {
      const keys = store.getAllKeys(undefined, 2 * MAX_ORDINARY_TAB_OWNERS + 2)
      keys.onerror = () => reject(new OrdinaryStateHold())
      keys.onsuccess = () => {
        try {
          const values = keys.result
          if (values.length > 2 * MAX_ORDINARY_TAB_OWNERS + 1 || values.some(key => typeof key !== 'string' ||
              key !== 'browser' && !(key.length === 68 && TAB_PURPOSE.test(key)) &&
              !this.#operationControlDigests.has(key))) hold()
          if (values.filter(key => typeof key === 'string' && key.startsWith('tab:')).length > MAX_ORDINARY_TAB_OWNERS) hold()
          const controls = values.filter(key => typeof key === 'string' && key.startsWith(ORDINARY_OPERATION_CONTROL_PREFIX)) as string[]
          if (controls.length !== this.#operationControlDigests.size || controls.some(name => !values.includes('browser') ||
              !values.includes('tab:' + name.slice(ORDINARY_OPERATION_CONTROL_PREFIX.length)))) hold()
          if (!controls.length) { resolve(); return }
          let index = 0
          // Stream one control at a time from genuine request callbacks. A
          // bounded header check must not retain all large cipher copies.
          const read = () => {
            if (index === controls.length) { resolve(); return }
            const name = controls[index]!, next = store.get(name)
            next.onerror = () => reject(new OrdinaryStateHold())
            next.onsuccess = () => {
              try {
                if (ordinaryOperationControlDigest(next.result) !== this.#operationControlDigests.get(name)) hold()
                index++; read()
              } catch { reject(new OrdinaryStateHold()) }
            }
          }
          read()
        } catch { reject(new OrdinaryStateHold()) }
      }
    })
  }
  #classifiedPairMarkers(browser: OrdinaryImage, tab: OrdinaryImage): readonly [ReadonlyMap<string,string>, ReadonlyMap<string,string>] {
    const marked = (image: OrdinaryImage) => new Map([...image.records].filter(([name]) => name.startsWith('kithmoot.operation-journal')))
    const b = marked(browser), t = marked(tab), names = ordinaryOperationNames(tab.purpose)
    if (b.size !== this.#operationMarkerValues.size || [...b].some(([name, raw]) => this.#operationMarkerValues.get(name) !== raw) ||
        t.size !== (b.has(names.marker) ? 1 : 0) || [...t].some(([name, raw]) => name !== names.marker || b.get(name) !== raw)) hold()
    return [b, t]
  }
  async #database(live: () => boolean, reconciling = false): Promise<IDBDatabase> {
    this.#custodyCheck(live, reconciling)
    if (this.#db) return this.#db
    const opened = indexedDB.open(ORDINARY_DATABASE, 1)
    let refused = false
    let finish!: () => void
    const terminal = this.#track(new Promise<void>(resolve => { finish = resolve }))
    const resource = { stop: () => { try { opened.transaction?.abort() } catch { /* The request remains joined. */ } } }
    this.#resources.add(resource)
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        opened.onupgradeneeded = event => {
          try {
            if (refused || this.#closed || event.oldVersion !== 0) { opened.transaction!.abort(); return }
            this.#custodyCheck(live, reconciling)
            opened.result.createObjectStore(OWNER_STORE)
          } catch (error) {
            refused = true
            resource.stop(); reject(error); this.#revoke()
          }
        }
        opened.onerror = () => { try { reject(opened.error) } finally { finish() } }
        opened.onblocked = () => { refused = true; reject(new OrdinaryStateHold()); this.#revoke() }
        opened.onsuccess = () => {
          const value = opened.result
          try {
            if (refused) { value.close(); return }
            try {
              this.#custodyCheck(live, reconciling)
              if (value.version !== 1 || value.objectStoreNames.length !== 1 || !value.objectStoreNames.contains(OWNER_STORE)) hold()
              resolve(value)
            } catch (error) { value.close(); reject(error) }
          } finally { finish() }
        }
      })
      try { this.#custodyCheck(live, reconciling) } catch (error) { db.close(); throw error }
      this.#db = db
      db.onversionchange = () => { this.#revoke(); db.close(); this.#db = undefined }
      return db
    } finally {
      await terminal
      this.#resources.delete(resource)
    }
  }
  async #snapshot(live: () => boolean, reconciling = false, barrier: OrdinaryStateOwner = this): Promise<Snapshot> {
    let db = await this.#database(live, reconciling)
    const tx = db.transaction(OWNER_STORE, 'readonly'), ended = settled(tx)
    void ended.catch(() => {})
    let saved: Row | undefined
    try {
      const store = tx.objectStore(OWNER_STORE)
      const [raw] = await Promise.all([request(store.get(this.purpose)), barrier.#operationControlSnapshot(store)])
      saved = row(raw); await ended
    }
    catch (error) { try { tx.abort() } catch {} await ended.catch(() => {}); throw error }
    this.#custodyCheck(live, reconciling)
    if (!saved) return { db }
    if (saved.pending && !reconciling) {
      // A restarted owner reconciles the durable frozen intent before reading
      // ordinary state or creating any replacement identity/candidate.
      await this.#verifyRow(saved)
      const active: Row = { key: saved.key, frame: saved.pending }
      await this.#install(db, saved, active, live)
      db = await this.#database(live)
      saved = active
    }
    if (reconciling) return { db, row: saved }
    if (!saved.frame || saved.frame.purpose !== this.purpose || saved.frame.expiresAt !== this.expiresAt) hold()
    const image = await openOrdinaryFrame(saved.frame, saved.key)
    try {
      this.#custodyCheck(live, reconciling)
      if (!reconciling && this.#generation !== undefined && this.#generation !== image.generation) hold()
    } catch (error) { clearImage(image); throw error }
    return { db, row: saved, image }
  }
  #scope(image: OrdinaryImage, scope: OrdinaryScope): void {
    if (scope.generation !== image.generation || scope.fence !== (image.fences.get(scope.name) ?? 0)) hold()
  }
  async #ownerNames(live: () => boolean): Promise<IDBValidKey[]> {
    const db = await this.#database(live), tx = db.transaction(OWNER_STORE, 'readonly'), ended = settled(tx)
    void ended.catch(() => {})
    const keys = await request(tx.objectStore(OWNER_STORE).getAllKeys(undefined, 2 * MAX_ORDINARY_TAB_OWNERS + 2))
    await ended; this.#check(live)
    if (keys.length > 2 * MAX_ORDINARY_TAB_OWNERS + 1 || keys.some(name => typeof name !== 'string' ||
      name !== 'browser' && !(name.length === 68 && TAB_PURPOSE.test(name)) &&
      !(name.startsWith(ORDINARY_OPERATION_CONTROL_PREFIX) && name.length === ORDINARY_OPERATION_CONTROL_PREFIX.length + 64 &&
        this.#operationControls.has('tab:' + name.slice(ORDINARY_OPERATION_CONTROL_PREFIX.length))))) hold()
    const names = keys.filter(name => !(name as string).startsWith(ORDINARY_OPERATION_CONTROL_PREFIX))
    if (names.length > MAX_ORDINARY_TAB_OWNERS + 1) hold()
    return names
  }
  /** Read only authenticated lease metadata. Missing custody is reported to
   * the lifetime service, which must distinguish a new marker from a restore. */
  static async tabLease(purpose: OrdinaryPurpose, live: () => boolean): Promise<number | undefined> {
    if (!TAB_PURPOSE.test(purpose)) hold()
    const manager = new OrdinaryStateOwner()
    try {
      return await manager.#locked(live, async () => {
        const db = await manager.#database(live), tx = db.transaction(OWNER_STORE, 'readonly'), ended = settled(tx)
        void ended.catch(() => {})
        const store = tx.objectStore(OWNER_STORE)
        const [raw] = await Promise.all([request(store.get(purpose)), manager.#operationControlSnapshot(store)])
        const saved = row(raw)
        await ended; manager.#check(live)
        if (!saved) return undefined
        const frame = saved.pending ?? saved.frame
        if (!frame || frame.purpose !== purpose) hold()
        const owner = new OrdinaryStateOwner(purpose, frame.expiresAt)
        await owner.#verifyRow(saved); manager.#check(live)
        return frame.expiresAt
      })
    } finally { await manager.close() }
  }
  async #cleanupImages(browser: Row, tab: Row, purpose: OrdinaryPurpose): Promise<readonly [OrdinaryImage, OrdinaryImage]> {
    const open = async (saved: Row, name: OrdinaryPurpose) => {
      let active: OrdinaryImage | undefined, pending: OrdinaryImage | undefined
      try {
        if (!saved.frame) hold()
        active = await openOrdinaryFrame(saved.frame, saved.key)
        if (saved.pending) pending = await openOrdinaryFrame(saved.pending, saved.key)
        for (const image of [active, pending]) if (image && (image.purpose !== name || image.migration?.phase !== 'complete')) hold()
        if (pending && (pending.keyId !== active.keyId || pending.generation !== active.generation || pending.expiresAt !== active.expiresAt ||
            pending.revision !== active.revision + 1 || [...active.fences].some(([key, value]) => (pending!.fences.get(key) ?? 0) < value))) hold()
        if (pending) preserveOperationMarkers(active.records, pending.records)
        const result = pending ?? active
        if (pending) { pending = undefined; clearImage(active) }
        active = undefined; return result
      } finally { clearImage(active); clearImage(pending) }
    }
    const b = await open(browser, 'browser')
    try { return [b, await open(tab, purpose)] } catch (error) { clearImage(b); throw error }
  }
  /** Inert semantic provenance for exact authenticated expired images. This
   * private token can validate retained data but can never supply a live read,
   * resource, signer or Session adoption boundary. */
  #validateCleanupImage(b: OrdinaryImage, t: OrdinaryImage, retained: OrdinaryStateOwner, classified: OperationClassification,
    snapshot: typeof import('./ordinary-snapshot.js')): void {
    const browserView = view(new Map(b.records), false), tabView = view(new Map(t.records), false)
    const custody = Object.freeze({}) as OrdinaryPairCustody
    const scope = (image: OrdinaryImage): OrdinaryScope => ({ name: '@expired-cleanup', generation: image.generation,
      fence: image.fences.get('@expired-cleanup') ?? 0 })
    const markers = new Map(classified.markers), name = ordinaryOperationNames(t.purpose).marker
    pairCustody.set(custody, { kind: 'historical-cleanup', browser: b, tab: t, browserOwner: this, tabOwner: retained,
      browserStore: browserView.store, tabStore: tabView.store, browserScope: scope(b), tabScope: scope(t),
      operationMarkers: [markers, new Map(t.records.has(name)?[[name,t.records.get(name)!]]:[])] })
    try { snapshot.validateOrdinarySnapshot(b.records, t.records, { browser: true, tab: true }, snapshot.captureOrdinaryHistoricalSnapshotContext(b.records, t.records, custody)) }
    finally { pairCustody.delete(custody); browserView.close(); tabView.close() }
  }
  async #cleanupSettledTab(purpose: OrdinaryPurpose, retained: OrdinaryStateOwner, live: () => boolean,
    snapshot: typeof import('./ordinary-snapshot.js')): Promise<void> {
    const names = ordinaryOperationNames(purpose)
    const check = () => { this.#check(live); retained.#check(live, true); if (Date.now() < retained.expiresAt) hold() }
    const equal = (a: OperationClassification, b: OperationClassification) => JSON.stringify(a) === JSON.stringify(b)
    let context: OperationTransaction | undefined, browserImage: OrdinaryImage | undefined, tabImage: OrdinaryImage | undefined
    let expectedPrior: OperationClassification | undefined, expectedTarget: OperationClassification | undefined
    let browserPrior: Row | undefined, tabPrior: Row | undefined, controlPrior: unknown, candidate: Row | undefined
    let attempted = false
    const cancel = { stop: () => context?.abort() }
    this.#resources.add(cancel); retained.#resources.add(cancel)
    try {
      check()
      context = operationTransaction(await this.#database(live), 'readonly')
      expectedPrior = await this.#classifyOperations(live, context)
      check()
      const raw = await Promise.all([context.read(() => context!.store.get('browser')),
        context.read(() => context!.store.get(purpose)), context.read(() => context!.store.get(names.control))])
      browserPrior = row(raw[0]); tabPrior = row(raw[1]); controlPrior = raw[2]
      if (!browserPrior || !tabPrior || new Map(expectedPrior.controls).get(names.control) !== ordinaryOperationControlDigest(controlPrior)) hold()
      ;[browserImage, tabImage] = await this.#cleanupImages(browserPrior, tabPrior, purpose)
      check()
      if (tabImage.expiresAt !== retained.expiresAt || browserImage.records.get(names.marker) !== tabImage.records.get(names.marker)) hold()
      this.#validateCleanupImage(browserImage, tabImage, retained, expectedPrior, snapshot)
      context.stop(); await context.ended; context = undefined
      // The exact fixed transform preserves every effective pending record,
      // fence and migration field except this one expired-tab marker.
      const records = new Map(browserImage.records)
      if (!records.delete(names.marker)) hold()
      browserImage.records = records; browserImage.revision++
      ordinaryImageByteLength(browserImage); check()
      const frame = await sealOrdinaryImage(browserImage, browserPrior.key); check()
      candidate = { key: browserPrior.key, frame: validateOrdinaryFrame(frame) }
      clearImage(browserImage); clearImage(tabImage); browserImage = tabImage = undefined
      const replace = (pairs: readonly (readonly [string,string])[], name: string, value?: string) => Object.freeze(pairs
        .filter(([key]) => key !== name).concat(value === undefined ? [] : [[name,value]])
        .sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(pair => Object.freeze(pair)))
      expectedTarget = Object.freeze({ owners: replace(replace(expectedPrior.owners, purpose), 'browser', rowDigest(candidate)),
        controls: replace(expectedPrior.controls, names.control), markers: replace(expectedPrior.markers, names.marker) })
      context = operationTransaction(await this.#database(live), 'readwrite')
      const current = await this.#classifyOperations(live, context); check()
      if (!equal(current, expectedPrior)) hold()
      const native = await Promise.all([context.read(() => context!.store.get('browser')),
        context.read(() => context!.store.get(purpose)), context.read(() => context!.store.get(names.control))])
      const b = row(native[0]), t = row(native[1])
      if (!b || !t || !sameRow(b, browserPrior) || !sameRow(t, tabPrior) ||
          ordinaryOperationControlDigest(native[2]) !== ordinaryOperationControlDigest(controlPrior)) hold()
      ;[browserImage, tabImage] = await this.#cleanupImages(b,t,purpose)
      check(); this.#validateCleanupImage(browserImage, tabImage, retained, current, snapshot)
      const target = await openOrdinaryFrame(candidate.frame!, b.key)
      try {
        const effective = copyImage(browserImage), values = new Map(effective.records)
        try {
          values.delete(names.marker); effective.records = values; effective.revision++
          const actual = encodeOrdinaryImage(target), expected = encodeOrdinaryImage(effective)
          try { if (actual.length !== expected.length || actual.some((byte,i) => byte !== expected[i])) hold() }
          finally { actual.fill(0); expected.fill(0) }
        } finally { clearImage(effective) }
      } finally { clearImage(target) }
      candidate = { key: b.key, frame: candidate.frame }
      await context.step(() => {
        // All selector-bearing checks precede these exact source comparisons.
        // No async work, entropy or application callback separates mutations.
        check()
        if (!sameRow(b,browserPrior) || !sameRow(t,tabPrior) || ordinaryOperationControlDigest(native[2]) !== ordinaryOperationControlDigest(controlPrior)) hold()
        attempted = true
        context!.store.put(candidate!,'browser')
        context!.store.delete(purpose)
        context!.store.delete(names.control)
      })
      context.stop()
      await context.ended.catch(() => {})
    } catch {
      context?.abort(); await context?.ended.catch(() => {})
      if (!attempted) hold()
    } finally {
      context?.stop(); this.#resources.delete(cancel); retained.#resources.delete(cancel)
      clearImage(browserImage); clearImage(tabImage)
    }
    if (!attempted || !candidate || !expectedPrior || !expectedTarget) hold()
    // A terminal callback is not acknowledgment of all three exact values.
    // Only complete authenticated target or complete prior can resolve it.
    for (;;) {
      this.#db?.close(); this.#db = undefined
      let read: OperationTransaction | undefined
      try {
        read = operationTransaction(await this.#database(() => true, true), 'readonly')
        const classified = await this.#classifyOperations(() => true, read, true)
        read.stop(); await read.ended
        if (equal(classified, expectedTarget)) return
        if (equal(classified, expectedPrior)) throw new DefiniteAbort()
      } catch (error) {
        read?.abort(); await read?.ended.catch(() => {})
        if (error instanceof DefiniteAbort) hold()
      } finally { read?.stop() }
      await new Promise<void>(resolve => { retained.#retry = resolve })
      retained.#retry = undefined
    }
  }
  /** Fixed P→E transition only. The private factory obligation supplies
   * neither raw images, arbitrary transforms nor permission to bypass native
   * authentication. Returned enrollment is a custody fact, never a provider
   * or Session-adoption capability. */
  static async enrollMemberRenewal(obligation:OrdinaryRenewalObligation):Promise<OrdinaryRenewalEnrollmentOutcome>{
    const bridge=await import('./ordinary-renewal-obligation.js'),requestCodec=await import('./ordinary-renewal-request.js')
    const held=bridge.takeOrdinaryRenewalObligation(obligation),browser=held.binding.browser.owner,tab=held.binding.tab.owner,
      core=held.intent,purpose=tab.purpose as `tab:${string}`,names=ordinaryOperationNames(purpose)
    const check=()=>{browser.#check(held.binding.live);tab.#check(held.binding.live);bridge.checkOrdinaryRenewalObligation(obligation)}
    const equal=(a:OperationClassification,b:OperationClassification)=>JSON.stringify(a)===JSON.stringify(b)
    const operation=Promise.resolve().then(async()=>{
      check();if(browser.#retry||tab.#retry||!navigator.locks)hold()
      return navigator.locks.request(WRITE_LOCK,async()=>{
        let context:OperationTransaction|undefined,b:OrdinaryImage|undefined,t:OrdinaryImage|undefined
        let prior:OperationClassification|undefined,target:OperationClassification|undefined,prepared:PreparedRenewalTarget|undefined
        let sourceRows:readonly [Row,Row]|undefined,candidateRows:readonly [Row,Row]|undefined,control:unknown,rawRequest:string|undefined
        let attempted=false
        const cancel={stop:()=>context?.abort()};browser.#resources.add(cancel);tab.#resources.add(cancel)
        const binding=(image:OrdinaryImage)=>({purpose:image.purpose,keyId:image.keyId,generation:image.generation,expiresAt:image.expiresAt})
        const validate=(classified:OperationClassification)=>{
          check();if(!b||!t||!sourceRows)hold()
          if(b.purpose!=='browser'||t.purpose!==purpose||b.expiresAt!==0||t.expiresAt!==tab.expiresAt||
            b.generation!==browser.#generation||t.generation!==tab.#generation||b.migration?.phase!=='complete'||t.migration?.phase!=='complete')hold()
          browser.#scope(b,held.binding.browser.scope);tab.#scope(t,held.binding.tab.scope)
          const bv=view(new Map(b.records),false),tv=view(new Map(t.records),false),custody=Object.freeze({}) as OrdinaryPairCustody
          pairCustody.set(custody,{kind:'read',browser:b,tab:t,browserOwner:browser,tabOwner:tab,browserStore:bv.store,tabStore:tv.store,
            browserScope:held.binding.browser.scope,tabScope:held.binding.tab.scope,rows:sourceRows,
            operationMarkers:[new Map(classified.markers),new Map([...t.records].filter(([n])=>n.startsWith('kithmoot.operation-journal')))]})
          try{bridge.validateOrdinaryRenewalPredecessor(obligation,bv.store,tv.store,custody)}finally{pairCustody.delete(custody);bv.close();tv.close()}
          check()
        }
        try{
          check();context=operationTransaction(await browser.#database(held.binding.live),'readonly')
          prior=await browser.#classifyOperations(held.binding.live,context);check()
          const native=await Promise.all([context.read(()=>context!.store.get('browser')),context.read(()=>context!.store.get(purpose)),context.read(()=>context!.store.get(names.control))])
          const br=row(native[0]),tr=row(native[1]);if(!br?.frame||!tr?.frame||br.pending||tr.pending)hold()
          sourceRows=[br,tr]
          if(ordinaryFrameDigest(br.frame)!==core.sourceFrames[0]||ordinaryFrameDigest(tr.frame)!==core.sourceFrames[1]||
            (native[2]===undefined?null:ordinaryOperationControlDigest(native[2]))!==core.previousControlDigest)hold()
          b=await openOrdinaryFrame(br.frame,br.key);check();t=await openOrdinaryFrame(tr.frame,tr.key);check();validate(prior)
          const previous=native[2]===undefined?null:{digest:ordinaryOperationControlDigest(native[2]),header:await openOrdinaryOperationClassification(native[2],
            {browser:{binding:binding(b),key:br.key},tab:{binding:binding(t),key:tr.key}})}
          check();if(previous&&previous.header.phase!=='settled')hold()
          const sequence=previous?previous.header.sequence+1:1;if(!Number.isSafeInteger(sequence))hold()
          const scopes=[['browser',held.binding.browser.scope.name,b.generation,held.binding.browser.scope.fence],
            [purpose,held.binding.tab.scope.name,t.generation,held.binding.tab.scope.fence]] as const
          const fences=[b,t].map((image,i)=>{const name=scopes[i]![1],present=image.fences.has(name);return [image.purpose,name,present,present?image.fences.get(name)!:null,scopes[i]![3]] as const})
          rawRequest=requestCodec.encodeOrdinaryRenewalRequest({version:1,domain:'kithmoot/member-renewal/request/v1',credentialFormat:1,intent:core,
            sources:[{...binding(b),revision:b.revision},{...binding(t),revision:t.revision}],scopes,fences,previous})
          const digest=(raw:string)=>{const bytes=new TextEncoder().encode(raw);try{return bytesToHex(sha256(bytes))}finally{bytes.fill(0)}}
          const skeleton:OrdinaryOperationJournal={version:1,id:'f'.repeat(64),tab:purpose,sequence,phase:'prepared',source:core.sourceFrames,
            sourceRevisions:core.sourceRevisions,enrolled:[digest(core.sourceFrames[0]+' E'),digest(core.sourceFrames[1]+' E')],enrolledRevisions:[b.revision+1,t.revision+1],
            target:null,targetRevisions:null,requestDigest:digest(rawRequest),resultDigest:null,scopes,ceilings:[core.authority.tabExpiresAt,core.authority.admissionEndsAt??0,core.authority.foregroundExpiresAt??0],
            request:rawRequest,result:null,secrets:[],nonces:null}
          // Reserve every phase packet and its two AEAD tags/nonces before
          // operation-id, owner-nonce, seal or provider entropy can start.
          const result='x'.repeat(4096),secret=new Uint8Array(32),targetDigests=[digest(core.sourceFrames[0]+' C'),digest(core.sourceFrames[1]+' C')] as const
          try{for(const phase of ['prepared','provider-started','provider-returned','candidate-prepared','candidate-committed','settled'] as const){
            const returned=phase==='provider-returned'||phase==='candidate-prepared'||phase==='candidate-committed',done=phase==='settled',privateBody=phase==='provider-started'||phase==='provider-returned'||phase==='candidate-prepared',candidate=phase==='candidate-prepared'||phase==='candidate-committed'||done
            const packet=encodeOrdinaryOperationJournal({...skeleton,phase,target:candidate?targetDigests:null,targetRevisions:candidate?[b.revision+2,t.revision+2]:null,
              resultDigest:returned||done?digest(result):null,request:done?'':rawRequest,result:returned?result:null,secrets:privateBody?[secret]:[],nonces:privateBody?['0'.repeat(24),'1'.repeat(24)]:null})
            packet.fill(0)
          }}finally{secret.fill(0)}
          context.stop();await context.ended;context=undefined;check()
          const id=random(),marker=ordinaryOperationMarker({id,tab:purpose,sequence,commitment:null})
          for(const [i,image]of [b,t].entries()){
            image.records=new Map(image.records);(image.records as Map<string,string>).set(names.marker,marker)
            image.fences=new Map(image.fences);(image.fences as Map<string,number>).set(scopes[i]![1],scopes[i]![3]);image.revision++
            ordinaryImageByteLength(image)
          }
          check();const bf=await sealOrdinaryImage(b,br.key);check();const tf=await sealOrdinaryImage(t,tr.key);check()
          candidateRows=[{key:br.key,frame:bf},{key:tr.key,frame:tf}]
          const journal:OrdinaryOperationJournal={...skeleton,id,enrolled:[ordinaryFrameDigest(bf),ordinaryFrameDigest(tf)]}
          const packet=encodeOrdinaryOperationJournal(journal)
          let header:OrdinaryOperationClassification;try{header=decodeOrdinaryOperationClassification(packet)}finally{packet.fill(0)}
          control=await sealOrdinaryOperationControl(journal,{browser:{binding:binding(b),key:br.key},tab:{binding:binding(t),key:tr.key}});check()
          prepared={purpose,rows:[rowDigest(candidateRows[0]),rowDigest(candidateRows[1])],controlDigest:ordinaryOperationControlDigest(control),header}
          const replace=(pairs:readonly (readonly [string,string])[],name:string,value:string)=>Object.freeze(pairs.filter(([n])=>n!==name).concat([[name,value]])
            .sort(([a],[b])=>a<b?-1:a>b?1:0).map(pair=>Object.freeze(pair)))
          target=Object.freeze({owners:replace(replace(prior.owners,'browser',prepared.rows[0]),purpose,prepared.rows[1]),
            controls:replace(prior.controls,names.control,prepared.controlDigest),markers:replace(prior.markers,names.marker,marker)})
          clearImage(b);clearImage(t);b=t=undefined
          context=operationTransaction(await browser.#database(held.binding.live),'readwrite')
          const current=await browser.#classifyOperations(held.binding.live,context);check();if(!equal(current,prior))hold()
          const raw=await Promise.all([context.read(()=>context!.store.get('browser')),context.read(()=>context!.store.get(purpose)),context.read(()=>context!.store.get(names.control))])
          const rb=row(raw[0]),rt=row(raw[1]);if(!rb||!rt||!sameRow(rb,br)||!sameRow(rt,tr)||
            (raw[2]===undefined?null:ordinaryOperationControlDigest(raw[2]))!==core.previousControlDigest)hold()
          sourceRows=[rb,rt];b=await openOrdinaryFrame(rb.frame!,rb.key);check();t=await openOrdinaryFrame(rt.frame!,rt.key);check();validate(current)
          // Verify the exact inverse from both authenticated frozen candidates.
          let eb:OrdinaryImage|undefined,et:OrdinaryImage|undefined
          try{eb=await openOrdinaryFrame(candidateRows[0].frame!,rb.key);check();et=await openOrdinaryFrame(candidateRows[1].frame!,rt.key);
            check();requestCodec.restoreOrdinaryRenewalPredecessor(eb,et,rawRequest,{id,sequence})}finally{clearImage(eb);clearImage(et)}
          const authenticated=await openOrdinaryOperationClassification(control,{browser:{binding:binding(b),key:rb.key},tab:{binding:binding(t),key:rt.key}})
          check();if(JSON.stringify(authenticated)!==JSON.stringify(prepared.header))hold()
          candidateRows=[{key:rb.key,frame:candidateRows[0].frame},{key:rt.key,frame:candidateRows[1].frame}]
          await context.step(()=>{
            check();attempted=true
            context!.store.put(candidateRows![0],'browser')
            context!.store.put(candidateRows![1],purpose)
            context!.store.put(control,names.control)
          })
          context.stop();await context.ended.catch(()=>{})
        }catch{
          context?.abort();await context?.ended.catch(()=>{});if(!attempted)hold()
        }finally{context?.stop();browser.#resources.delete(cancel);tab.#resources.delete(cancel);clearImage(b);clearImage(t)}
        if(!attempted||!prior||!target||!prepared||!rawRequest)hold()
        // Reconciliation is custody-only, including after revocation. Never
        // regenerate the already frozen E frames, request, id or control.
        for(;;){
          browser.#db?.close();browser.#db=undefined
          let read:OperationTransaction|undefined
          try{
            read=operationTransaction(await browser.#database(()=>true,true),'readonly')
            const saved=await browser.#classifyOperations(()=>true,read,true,prepared);read.stop();await read.ended
            if(equal(saved,target)){
              const enrollment=Object.freeze({}) as OrdinaryRenewalEnrollment
              renewalEnrollments.set(enrollment,Object.freeze({obligation,request:rawRequest,target:prepared,classification:target,held}))
              return Object.freeze({status:'enrolled',enrollment}) as OrdinaryRenewalEnrollmentOutcome
            }
            if(equal(saved,prior))return Object.freeze({status:'definite-abort'}) as OrdinaryRenewalEnrollmentOutcome
          }catch{read?.abort();await read?.ended.catch(()=>{})}finally{read?.stop()}
          await new Promise<void>(resolve=>{browser.#retry=resolve;tab.#retry=resolve});browser.#retry=undefined;tab.#retry=undefined
        }
      })
    })
    browser.#track(operation);tab.#track(operation);return operation
  }
  /** Fixed signing producer. Its exact returned promise is retained by the
   * genuine root and both owners before any await, covering started custody,
   * one actual signing attempt, exact result persistence and reconciliation. */
  static signMemberRenewal(enrollment:OrdinaryRenewalEnrollment):Promise<OrdinaryRenewalProviderReturned>{
    const captured=renewalEnrollments.get(enrollment)
    if(!captured||consumedRenewalEnrollments.has(enrollment))hold()
    consumedRenewalEnrollments.add(enrollment)
    const {held,obligation}=captured,browser=held.binding.browser.owner,tab=held.binding.tab.owner,
      purpose=tab.purpose as `tab:${string}`,names=ordinaryOperationNames(purpose)
    let resolve!:(value:OrdinaryRenewalProviderReturned)=>void,reject!:(reason:unknown)=>void
    const pending=new Promise<OrdinaryRenewalProviderReturned>((yes,no)=>{resolve=yes;reject=no})
    browser.#track(pending);tab.#track(pending)
    let foregroundLifetime:OrdinaryRenewalSigningLifetime|undefined
    try{
      held.root.retain(pending)
      if(held.binding.account!==null){
        foregroundLifetime=registerOrdinaryRenewalSigningLifetime({obligation,pending,signer:held.binding.identity as OrdinaryForegroundSigner})
        OrdinaryForegroundSigner.retainMemberRenewal(held.binding.identity as OrdinaryForegroundSigner,foregroundLifetime)
      }
    }catch(error){releaseOrdinaryRenewalSigningLifetime(foregroundLifetime);reject(error);return pending}
    void Promise.resolve().then(async()=>{
      const bridge=await import('./ordinary-renewal-obligation.js'),codec=await import('./ordinary-renewal-request.js'),credential=await import('./ordinary-renewal-credential.js'),
        sealModule=await import('../../src/seal.js'),nostr=await import('nostr-tools/pure')
      const check=()=>{browser.#check(held.binding.live);tab.#check(held.binding.live);bridge.checkOrdinaryRenewalSigningObligation(obligation,pending)}
      check();if(browser.#retry||tab.#retry||!navigator.locks)hold()
      if(foregroundLifetime)await OrdinaryForegroundSigner.checkMemberRenewalClients(held.binding.identity as OrdinaryForegroundSigner,foregroundLifetime)
      return navigator.locks.request(WRITE_LOCK,async()=>{
        const equal=(a:OperationClassification,b:OperationClassification)=>JSON.stringify(a)===JSON.stringify(b)
        const binding=(i:OrdinaryImage)=>({purpose:i.purpose,keyId:i.keyId,generation:i.generation,expiresAt:i.expiresAt})
        const replaceControl=(c:OperationClassification,digest:string):OperationClassification=>Object.freeze({...c,controls:Object.freeze(c.controls.map(([n,v])=>Object.freeze([n,n===names.control?digest:v] as const)))})
        let expected=captured.classification,active=captured.target,seal:ReturnType<typeof sealModule.generateSealKey>|undefined,
          nonces:readonly [string,string]|undefined,context:OperationTransaction|undefined,providerNotStarted=true,providerCompleted=false,providerActive=true,custodyCompleting=false
        const providerRuns=new Set<Promise<unknown>>()
        const cancel={stop:()=>{if(!custodyCompleting)context?.abort()}};browser.#resources.add(cancel);tab.#resources.add(cancel)
        /** Reconstruct only owned P copies after authenticating exact E and
         * the exact active control. This temporary token is not a phase grant. */
        const withP=async<T>(work:(b:DeviceStore,t:DeviceStore,c:OrdinaryPairCustody,j:OrdinaryOperationJournal,rows:readonly [Row,Row],e:readonly [OrdinaryImage,OrdinaryImage])=>T):Promise<T>=>{
          let b:OrdinaryImage|undefined,t:OrdinaryImage|undefined,j:OrdinaryOperationJournal|undefined
          try{
            check();context=operationTransaction(await browser.#database(held.binding.live),'readonly')
            const classified=await browser.#classifyOperations(held.binding.live,context,false,active);check();if(!equal(classified,expected))hold()
            const raw=await Promise.all([context.read(()=>context!.store.get('browser')),context.read(()=>context!.store.get(purpose)),context.read(()=>context!.store.get(names.control))])
            const br=row(raw[0]),tr=row(raw[1]);if(!br?.frame||!tr?.frame||br.pending||tr.pending)hold()
            b=await openOrdinaryFrame(br.frame,br.key);check();t=await openOrdinaryFrame(tr.frame,tr.key);check()
            j=await openOrdinaryOperationControl(raw[2],{browser:{binding:binding(b),key:br.key},tab:{binding:binding(t),key:tr.key}});check()
            if(j.request!==captured.request||j.id!==captured.target.header.id||j.sequence!==captured.target.header.sequence)hold()
            const eb=copyImage(b),et=copyImage(t)
            try{
              codec.restoreOrdinaryRenewalPredecessor(b,t,captured.request,{id:j.id,sequence:j.sequence})
              const bv=view(new Map(b.records),false),tv=view(new Map(t.records),false),custody=Object.freeze({}) as OrdinaryPairCustody
              pairCustody.set(custody,{kind:'read',browser:b,tab:t,browserOwner:browser,tabOwner:tab,browserStore:bv.store,tabStore:tv.store,
                browserScope:held.binding.browser.scope,tabScope:held.binding.tab.scope,operationMarkers:[new Map([...b.records].filter(([n])=>n.startsWith('kithmoot.operation-journal'))),new Map([...t.records].filter(([n])=>n.startsWith('kithmoot.operation-journal')))]})
              try{
                bridge.validateOrdinaryRenewalReconstructedPredecessor(obligation,pending,bv.store,tv.store,custody);check()
                let value!:T
                await context.step(()=>{check();const result=work(bv.store,tv.store,custody,j!,[br,tr],[eb,et]);
                  if(result&&typeof(result as unknown as PromiseLike<unknown>).then==='function'){void Promise.resolve(result).catch(()=>{});hold()}
                  check();value=result})
                context.stop();await context.ended;return value
              }finally{pairCustody.delete(custody);bv.close();tv.close()}
            }finally{clearImage(eb);clearImage(et)}
          }finally{context?.stop();await context?.ended.catch(()=>{});context=undefined;clearImage(b);clearImage(t);j?.secrets.forEach(k=>k.fill(0))}
        }
        /** Freeze one control candidate and reconcile complete native facts.
         * Exact prior retries the same bytes; mixed/unavailable waits explicitly.
         * Revocation after a write never converts unknown custody into absence. */
        const persist=async(journal:OrdinaryOperationJournal):Promise<void>=>{
          const preparation=await withP((_b,_t,_c,_j,rows,e)=>({rows,bindings:[binding(e[0]),binding(e[1])] as const}))
          check();const control=await sealOrdinaryOperationControl(journal,{browser:{binding:preparation.bindings[0],key:preparation.rows[0].key},tab:{binding:preparation.bindings[1],key:preparation.rows[1].key}});check()
          const packet=encodeOrdinaryOperationJournal(journal)
          let header:OrdinaryOperationClassification;try{header=decodeOrdinaryOperationClassification(packet)}finally{packet.fill(0)}
          const next:PreparedRenewalTarget={...active,controlDigest:ordinaryOperationControlDigest(control),header},target=replaceControl(expected,next.controlDigest)
          for(;;){
            let attempted=false
            try{
              check();context=operationTransaction(await browser.#database(held.binding.live),'readwrite')
              const current=await browser.#classifyOperations(held.binding.live,context,false,active);check();if(!equal(current,expected))hold()
              await context.step(()=>{check();attempted=true;context!.store.put(control,names.control)})
              context.stop();await context.ended.catch(()=>{})
            }catch(error){context?.abort();await context?.ended.catch(()=>{});if(!attempted)throw error}
            finally{context?.stop();context=undefined}
            let retriedPrior=false
            for(;;){
              let read:OperationTransaction|undefined,prior=false
              browser.#db?.close();browser.#db=undefined
              try{
                read=operationTransaction(await browser.#database(()=>true,true),'readonly')
                const current=await browser.#classifyOperations(()=>true,read,true,[active,next]);read.stop();await read.ended
                if(equal(current,target)){expected=target;active=next;return}
                if(equal(current,expected)){prior=true}
              }catch{read?.abort();await read?.ended.catch(()=>{})}finally{read?.stop()}
              if(prior&&retriedPrior){check();break}
              await new Promise<void>(yes=>{browser.#retry=yes;tab.#retry=yes});browser.#retry=undefined;tab.#retry=undefined;retriedPrior=prior
            }
          }
        }
        try{
          const prepared=await withP((_b,_t,_c,j)=>({...j,secrets:[],nonces:null}))
          if(prepared.phase!=='prepared'||prepared.result!==null||prepared.target!==null)hold()
          // E preflight already reserved every phase and candidate image before
          // entropy. Repeat source/role checks immediately before allocation.
          check();seal=sealModule.generateSealKey();check()
          const nonce=()=>{const bytes=new Uint8Array(12);try{crypto.getRandomValues(bytes);return bytesToHex(bytes)}finally{bytes.fill(0)}}
          const firstNonce=nonce();check();const secondNonce=nonce();check();nonces=Object.freeze([firstNonce,secondNonce])
          // Result custody has its own preallocated AEAD nonces. A valid
          // already-started fulfilment can be saved after revocation without
          // allocating entropy, checking mutable selectors or constructing C.
          const resultNonceBrowser=nonce();check();const resultNonceTab=nonce();check()
          const started:OrdinaryOperationJournal={...prepared,phase:'provider-started',secrets:[seal.secretKey as Uint8Array<ArrayBuffer>],nonces}
          await persist(started);check()
          const statement=await credential.ordinaryRenewalStatement(captured.request,seal.secretKey);check()
          const completionPreparation=await withP((_b,_t,_c,j,rows,e)=>{
            if(j.phase!=='provider-started'||j.result!==null||j.target!==null)hold()
            return Object.freeze({rows,bindings:Object.freeze([binding(e[0]),binding(e[1])]) as readonly [ReturnType<typeof binding>,ReturnType<typeof binding>],
              started:active,expected,pending,browser,tab,scopes:started.scopes,requestDigest:started.requestDigest})
          })
          // This private one-use completion record is minted under current P
          // custody and armed only at the actual provider call. It supplies
          // permission for exactly one result-only journal candidate.
          let completionArmed=false,completionPromise:Promise<unknown>|undefined,completionResult:string|undefined,completionConsumed=false
          const captureCompletion=(input:import('signet-login').NostrEvent):void=>{
            if(!completionArmed||completionResult!==undefined)hold()
            completionResult=credential.ordinaryRenewalResultForStatement(captured.request,statement,input)
          }
          const finishCompletion=async():Promise<void>=>{
            if(!completionArmed||completionConsumed||completionResult===undefined||completionPreparation.pending!==pending||
              completionPreparation.browser!==browser||completionPreparation.tab!==tab||completionPreparation.started.header.phase!=='provider-started'||
              completionPreparation.requestDigest!==started.requestDigest)hold()
            completionConsumed=true;custodyCompleting=true
            const result=completionResult,resultBytes=new TextEncoder().encode(result),resultDigest=bytesToHex(sha256(resultBytes));resultBytes.fill(0)
            const returned:OrdinaryOperationJournal={...started,phase:'provider-returned',result,resultDigest,target:null,targetRevisions:null}
            const nonceBytes=[resultNonceBrowser,resultNonceTab].map(value=>Uint8Array.from(value.match(/../g)!.map(v=>parseInt(v,16))))
            let used=0
            const fixedCrypto={subtle:crypto.subtle,getRandomValues:<A extends ArrayBufferView>(value:A):A=>{
              if(used>=nonceBytes.length||!(value instanceof Uint8Array)||value.length!==12)hold();value.set(nonceBytes[used++]!);return value
            }} as unknown as Crypto
            let control:OrdinaryOperationControl|undefined
            try{
              while(!control){
                used=0
                try{control=await sealOrdinaryOperationControl(returned,{browser:{binding:completionPreparation.bindings[0],key:completionPreparation.rows[0].key},
                  tab:{binding:completionPreparation.bindings[1],key:completionPreparation.rows[1].key}},fixedCrypto)}
                catch{await new Promise<void>(yes=>{browser.#retry=yes;tab.#retry=yes});browser.#retry=undefined;tab.#retry=undefined}
              }
            }finally{nonceBytes.forEach(bytes=>bytes.fill(0))}
            const packet=encodeOrdinaryOperationJournal(returned);let header:OrdinaryOperationClassification
            try{header=decodeOrdinaryOperationClassification(packet)}finally{packet.fill(0)}
            const prior=completionPreparation.started,priorFacts=completionPreparation.expected,
              next:PreparedRenewalTarget={...prior,controlDigest:ordinaryOperationControlDigest(control),header},target=replaceControl(priorFacts,next.controlDigest)
            // Exact native facts alone govern this custody write. Revocation
            // cannot grant a retry, C projection, state adoption or new effect.
            for(;;){
              try{
                context=operationTransaction(await browser.#database(()=>true,true),'readwrite')
                const current=await browser.#classifyOperations(()=>true,context,true,[prior,next])
                if(equal(current,target)){context.stop();await context.ended;expected=target;active=next;return}
                if(!equal(current,priorFacts))hold()
                await context.step(()=>{context!.store.put(control,names.control)})
                context.stop();await context.ended.catch(()=>{})
              }catch{context?.abort();await context?.ended.catch(()=>{})}finally{context?.stop();context=undefined}
              let retriedPrior=false
              for(;;){
                let read:OperationTransaction|undefined,isPrior=false
                browser.#db?.close();browser.#db=undefined
                try{
                  read=operationTransaction(await browser.#database(()=>true,true),'readonly')
                  const current=await browser.#classifyOperations(()=>true,read,true,[prior,next]);read.stop();await read.ended
                  if(equal(current,target)){expected=target;active=next;return}
                  isPrior=equal(current,priorFacts)
                }catch{read?.abort();await read?.ended.catch(()=>{})}finally{read?.stop()}
                if(isPrior&&retriedPrior)break
                await new Promise<void>(yes=>{browser.#retry=yes;tab.#retry=yes});browser.#retry=undefined;tab.#retry=undefined;retriedPrior=isPrior
              }
            }
          }
          let signed:import('signet-login').NostrEvent
          if(held.binding.account===null){
            let result:import('signet-login').NostrEvent|undefined,nativeError:unknown
            try{await withP((b)=>{
              const raw=b.get('kithmoot.participant');if(raw===null)hold()
              const key=Uint8Array.from(raw.match(/../g)!.map(v=>parseInt(v,16)))
              try{if(nostr.getPublicKey(key)!==held.intent.participant)hold();providerNotStarted=false;completionArmed=true
                result=nostr.finalizeEvent({...statement,tags:statement.tags.map(t=>[...t])},key);captureCompletion(result);providerCompleted=true;return undefined
              }finally{key.fill(0)}
            })}catch(error){nativeError=error}
            if(!result||completionResult===undefined){if(nativeError)throw nativeError;hold()}
            try{await finishCompletion()}finally{custodyCompleting=false};if(nativeError)throw nativeError;signed=result
          }else{
            const boundary:import('signet-login').SignerEffectBoundary=Object.freeze({start:<V>(provider:()=>Promise<V>):Promise<V>=>{
              if(!providerActive||!providerNotStarted)return Promise.reject(new OrdinaryStateHold())
              providerNotStarted=false
              const run=(async()=>{
                let operation:Promise<V>|undefined,capturedResult:Promise<V>|undefined,nativeError:unknown
                try{
                  await OrdinaryForegroundSigner.checkMemberRenewalClients(held.binding.identity as OrdinaryForegroundSigner,foregroundLifetime!)
                  try{await withP(()=>{completionArmed=true
                    try{operation=Promise.resolve(provider())}catch(error){operation=Promise.reject(error)}
                    completionPromise=operation
                    capturedResult=operation.then(result=>{if(completionPromise!==operation)hold();captureCompletion(result as import('signet-login').NostrEvent);return result})
                    browser.#track(operation);tab.#track(operation);browser.#track(capturedResult);tab.#track(capturedResult);void capturedResult.catch(()=>{});void operation.catch(()=>{});return undefined
                  })}catch(error){nativeError=error}
                  if(!operation||!capturedResult)hold();const result=await capturedResult;providerCompleted=true
                  try{await finishCompletion()}finally{custodyCompleting=false};if(nativeError)throw nativeError;return result
                }finally{if(operation)await Promise.allSettled([operation])}
              })();providerRuns.add(run);browser.#track(run);tab.#track(run);return run
            }})
            const attempt=registerOrdinaryRenewalSigningAttempt(foregroundLifetime!,statement,boundary)
            try{signed=await OrdinaryForegroundSigner.signMemberRenewal(held.binding.identity as OrdinaryForegroundSigner,attempt)}finally{providerActive=false;await Promise.allSettled([...providerRuns])}
          }
          if(providerNotStarted||!providerCompleted)hold();check()
          const result=credential.ordinaryRenewalResultForStatement(captured.request,statement,signed);check()
          if(result!==completionResult||active.header.phase!=='provider-returned')hold()
          const resultBytes=new TextEncoder().encode(result),resultDigest=bytesToHex(sha256(resultBytes));resultBytes.fill(0)
          const providerReturned:OrdinaryOperationJournal={...started,phase:'provider-returned',result,resultDigest}
          // Fixed C composition uses only authenticated reconstructed P, exact
          // returned statement and the already persisted seal/C nonces.
          const candidateModule=await import('./ordinary-renewal-candidate.js')
          const candidate=await withP((b,t,c,_j,rows,e)=>({images:candidateModule.prepareOrdinaryRenewalCandidate(b,t,c,captured.request,result,seal!.secretKey,held.binding.identity,e),keys:[rows[0].key,rows[1].key] as const}))
          const freeze=async(image:OrdinaryImage,key:CryptoKey,encoded:string)=>{
            const nonceBytes=Uint8Array.from(encoded.match(/../g)!.map(v=>parseInt(v,16)));let used=false
            const fixedCrypto={subtle:crypto.subtle,getRandomValues:<A extends ArrayBufferView>(target:A):A=>{if(used||!(target instanceof Uint8Array)||target.length!==12)hold();used=true;target.set(nonceBytes);return target}} as unknown as Crypto
            try{return await sealOrdinaryImage(image,key,fixedCrypto)}finally{nonceBytes.fill(0);clearImage(image)}
          }
          let cf:OrdinaryFrame,ct:OrdinaryFrame
          try{cf=await freeze(candidate.images[0],candidate.keys[0],nonces[0]);check();ct=await freeze(candidate.images[1],candidate.keys[1],nonces[1]);check()}
          finally{clearImage(candidate.images[0]);clearImage(candidate.images[1])}
          await persist({...providerReturned,phase:'candidate-prepared',target:[ordinaryFrameDigest(cf),ordinaryFrameDigest(ct)],targetRevisions:[cf.revision,ct.revision]});check()
          const returned=Object.freeze({}) as OrdinaryRenewalProviderReturned
          renewalReturned.set(returned,Object.freeze({enrollment,target:active,classification:expected,candidate:Object.freeze([cf,ct]) as readonly [OrdinaryFrame,OrdinaryFrame]}))
          return returned
        }finally{providerActive=false;await Promise.allSettled([...providerRuns]);context?.abort();await context?.ended.catch(()=>{});context?.stop();browser.#resources.delete(cancel);tab.#resources.delete(cancel);seal?.secretKey.fill(0)}
      })
    }).then(resolve,reject).finally(()=>releaseOrdinaryRenewalSigningLifetime(foregroundLifetime)).catch(()=>{})
    return pending
  }
  /** Commit the exact fixed C prepared by this native producer. No caller
   * frames, journal, signer, writer callback or Session are accepted. */
  static commitMemberRenewalCandidate(returned:OrdinaryRenewalProviderReturned):Promise<OrdinaryRenewalCandidateCommitted>{
    const candidate=renewalReturned.get(returned),enrollment=candidate&&renewalEnrollments.get(candidate.enrollment)
    if(!candidate||!enrollment||consumedRenewalReturned.has(returned))hold()
    consumedRenewalReturned.add(returned)
    const {held,obligation}=enrollment,browser=held.binding.browser.owner,tab=held.binding.tab.owner,
      purpose=tab.purpose as `tab:${string}`,names=ordinaryOperationNames(purpose)
    let resolve!:(value:OrdinaryRenewalCandidateCommitted)=>void,reject!:(reason:unknown)=>void
    const pending=new Promise<OrdinaryRenewalCandidateCommitted>((yes,no)=>{resolve=yes;reject=no})
    browser.#track(pending);tab.#track(pending)
    let foregroundLifetime:OrdinaryRenewalSigningLifetime|undefined
    try{
      held.root.retain(pending)
      if(held.binding.account!==null){
        foregroundLifetime=registerOrdinaryRenewalSigningLifetime({obligation,pending,signer:held.binding.identity as OrdinaryForegroundSigner})
        OrdinaryForegroundSigner.retainMemberRenewal(held.binding.identity as OrdinaryForegroundSigner,foregroundLifetime)
      }
    }catch(error){releaseOrdinaryRenewalSigningLifetime(foregroundLifetime);reject(error);return pending}
    void Promise.resolve().then(async()=>{
      const bridge=await import('./ordinary-renewal-obligation.js'),codec=await import('./ordinary-renewal-request.js')
      const check=()=>{browser.#check(held.binding.live);tab.#check(held.binding.live);bridge.checkOrdinaryRenewalSigningObligation(obligation,pending)}
      check();if(browser.#retry||tab.#retry||!navigator.locks)hold()
      if(foregroundLifetime)await OrdinaryForegroundSigner.checkMemberRenewalClients(held.binding.identity as OrdinaryForegroundSigner,foregroundLifetime)
      return navigator.locks.request(WRITE_LOCK,async()=>{
        const equal=(a:OperationClassification,b:OperationClassification)=>JSON.stringify(a)===JSON.stringify(b)
        const binding=(image:OrdinaryImage)=>({purpose:image.purpose,keyId:image.keyId,generation:image.generation,expiresAt:image.expiresAt})
        let context:OperationTransaction|undefined,attempted=false
        const cancel={stop:()=>context?.abort()};browser.#resources.add(cancel);tab.#resources.add(cancel)
        /** All final role checks and the three queued puts use the same exact
         * E transaction. The temporary P read is private and synchronous. */
        const withE=async<T>(mode:IDBTransactionMode,work:(journal:OrdinaryOperationJournal,rows:readonly [Row,Row],bindings:readonly [ReturnType<typeof binding>,ReturnType<typeof binding>])=>T):Promise<T>=>{
          let b:OrdinaryImage|undefined,t:OrdinaryImage|undefined,j:OrdinaryOperationJournal|undefined,completed=false
          try{
            check();context=operationTransaction(await browser.#database(held.binding.live),mode)
            const current=await browser.#classifyOperations(held.binding.live,context,false,candidate.target);check();if(!equal(current,candidate.classification))hold()
            const raw=await Promise.all([context.read(()=>context!.store.get('browser')),context.read(()=>context!.store.get(purpose)),context.read(()=>context!.store.get(names.control))])
            const br=row(raw[0]),tr=row(raw[1]);if(!br?.frame||!tr?.frame||br.pending||tr.pending)hold()
            b=await openOrdinaryFrame(br.frame,br.key);check();t=await openOrdinaryFrame(tr.frame,tr.key);check()
            const bindings=[binding(b),binding(t)] as const
            j=await openOrdinaryOperationControl(raw[2],{browser:{binding:bindings[0],key:br.key},tab:{binding:bindings[1],key:tr.key}});check()
            if(j.phase!=='candidate-prepared'||j.request!==enrollment.request||j.id!==candidate.target.header.id||j.sequence!==candidate.target.header.sequence||
              !j.target||!j.targetRevisions||j.target.some((digest,i)=>ordinaryFrameDigest(candidate.candidate[i]!)!==digest)||
              j.targetRevisions.some((revision,i)=>candidate.candidate[i]!.revision!==revision))hold()
            codec.restoreOrdinaryRenewalPredecessor(b,t,enrollment.request,{id:j.id,sequence:j.sequence})
            const bv=view(new Map(b.records),false),tv=view(new Map(t.records),false),custody=Object.freeze({}) as OrdinaryPairCustody
            pairCustody.set(custody,{kind:'read',browser:b,tab:t,browserOwner:browser,tabOwner:tab,browserStore:bv.store,tabStore:tv.store,
              browserScope:held.binding.browser.scope,tabScope:held.binding.tab.scope,
              operationMarkers:[new Map([...b.records].filter(([n])=>n.startsWith('kithmoot.operation-journal'))),new Map([...t.records].filter(([n])=>n.startsWith('kithmoot.operation-journal')))]})
            try{
              bridge.validateOrdinaryRenewalReconstructedPredecessor(obligation,pending,bv.store,tv.store,custody);check()
              let value!:T
              await context.step(()=>{check();const result=work(j!,[br,tr],bindings)
                if(result&&typeof(result as unknown as PromiseLike<unknown>).then==='function'){void Promise.resolve(result).catch(()=>{});hold()}
                check();value=result})
              context.stop();await context.ended;completed=true;return value
            }finally{pairCustody.delete(custody);bv.close();tv.close()}
          }finally{if(!completed&&mode==='readwrite')context?.abort();context?.stop();await context?.ended.catch(()=>{});context=undefined;clearImage(b);clearImage(t);j?.secrets.forEach(key=>key.fill(0))}
        }
        try{
          const prepared=await withE('readonly',(journal,rows,bindings)=>({journal:{...journal,phase:'candidate-committed' as const,secrets:[],nonces:null},rows,bindings}))
          check()
          const guardedCrypto={subtle:crypto.subtle,getRandomValues:<A extends ArrayBufferView>(value:A):A=>{check();const result=crypto.getRandomValues(value);check();return result}} as unknown as Crypto
          const control=await sealOrdinaryOperationControl(prepared.journal,{browser:{binding:prepared.bindings[0],key:prepared.rows[0].key},
            tab:{binding:prepared.bindings[1],key:prepared.rows[1].key}},guardedCrypto);check()
          const bytes=encodeOrdinaryOperationJournal(prepared.journal);let header:OrdinaryOperationClassification
          try{header=decodeOrdinaryOperationClassification(bytes)}finally{bytes.fill(0)}
          const next:PreparedRenewalTarget={...candidate.target,header,controlDigest:ordinaryOperationControlDigest(control),
            rows:[rowDigest({frame:candidate.candidate[0]} as Row),rowDigest({frame:candidate.candidate[1]} as Row)]}
          const target:OperationClassification=Object.freeze({...candidate.classification,
            owners:Object.freeze(candidate.classification.owners.map(([name,digest])=>Object.freeze([name,name==='browser'?next.rows[0]:name===purpose?next.rows[1]:digest] as const))),
            controls:Object.freeze(candidate.classification.controls.map(([name,digest])=>Object.freeze([name,name===names.control?next.controlDigest:digest] as const)))})
          for(;;){
            if(foregroundLifetime)await OrdinaryForegroundSigner.checkMemberRenewalClients(held.binding.identity as OrdinaryForegroundSigner,foregroundLifetime)
            attempted=false
            try{await withE('readwrite',(_j,rows)=>{
              // Copy every mutable binary field for the public IDB argument;
              // retain the original frozen C/control bytes for reconciliation.
              const browserRow={key:rows[0].key,frame:validateOrdinaryFrame(candidate.candidate[0])},tabRow={key:rows[1].key,frame:validateOrdinaryFrame(candidate.candidate[1])},journal=validateOrdinaryOperationControl(control)
              check();attempted=true;context!.store.put(browserRow,'browser');check();context!.store.put(tabRow,purpose);check();context!.store.put(journal,names.control)
            })}catch(error){if(!attempted)throw error}
            let retriedPrior=false
            for(;;){
              let read:OperationTransaction|undefined,isPrior=false
              browser.#db?.close();browser.#db=undefined
              try{
                read=operationTransaction(await browser.#database(()=>true,true),'readonly')
                const current=await browser.#classifyOperations(()=>true,read,true,[candidate.target,next]);read.stop();await read.ended
                if(equal(current,target)){
                  const committed=Object.freeze({}) as OrdinaryRenewalCandidateCommitted
                  renewalCommitted.set(committed,Object.freeze({enrollment:candidate.enrollment,target:next,classification:target}));return committed
                }
                isPrior=equal(current,candidate.classification)
              }catch{read?.abort();await read?.ended.catch(()=>{})}finally{read?.stop()}
              if(isPrior){check();if(retriedPrior)break}
              await new Promise<void>(yes=>{browser.#retry=yes;tab.#retry=yes});browser.#retry=undefined;tab.#retry=undefined;retriedPrior=isPrior
            }
          }
        }finally{context?.abort();await context?.ended.catch(()=>{});context?.stop();browser.#resources.delete(cancel);tab.#resources.delete(cancel)}
      })
    }).then(resolve,reject).finally(()=>releaseOrdinaryRenewalSigningLifetime(foregroundLifetime)).catch(()=>{})
    return pending
  }
  /** Settle only the exact acknowledged C. S retains immutable history while
   * removing the private journal body. This grants no Session adoption. */
  static settleMemberRenewalCandidate(committed:OrdinaryRenewalCandidateCommitted):Promise<OrdinaryRenewalSettled>{
    const candidate=renewalCommitted.get(committed),enrollment=candidate&&renewalEnrollments.get(candidate.enrollment)
    if(!candidate||!enrollment||consumedRenewalCommitted.has(committed))hold()
    consumedRenewalCommitted.add(committed)
    const {held,obligation}=enrollment,browser=held.binding.browser.owner,tab=held.binding.tab.owner,
      purpose=tab.purpose as `tab:${string}`,names=ordinaryOperationNames(purpose)
    let resolve!:(value:OrdinaryRenewalSettled)=>void,reject!:(reason:unknown)=>void
    const pending=new Promise<OrdinaryRenewalSettled>((yes,no)=>{resolve=yes;reject=no})
    browser.#track(pending);tab.#track(pending)
    let foregroundLifetime:OrdinaryRenewalSigningLifetime|undefined
    try{
      held.root.retain(pending)
      if(held.binding.account!==null){
        foregroundLifetime=registerOrdinaryRenewalSigningLifetime({obligation,pending,signer:held.binding.identity as OrdinaryForegroundSigner})
        OrdinaryForegroundSigner.retainMemberRenewal(held.binding.identity as OrdinaryForegroundSigner,foregroundLifetime)
      }
    }catch(error){releaseOrdinaryRenewalSigningLifetime(foregroundLifetime);reject(error);return pending}
    void Promise.resolve().then(async()=>{
      const bridge=await import('./ordinary-renewal-obligation.js')
      const check=()=>{browser.#check(held.binding.live);tab.#check(held.binding.live);bridge.checkOrdinaryRenewalSigningObligation(obligation,pending)}
      check();if(browser.#retry||tab.#retry||!navigator.locks)hold()
      if(foregroundLifetime)await OrdinaryForegroundSigner.checkMemberRenewalClients(held.binding.identity as OrdinaryForegroundSigner,foregroundLifetime)
      return navigator.locks.request(WRITE_LOCK,async()=>{
        const equal=(a:OperationClassification,b:OperationClassification)=>JSON.stringify(a)===JSON.stringify(b)
        const binding=(image:OrdinaryImage)=>({purpose:image.purpose,keyId:image.keyId,generation:image.generation,expiresAt:image.expiresAt})
        let context:OperationTransaction|undefined,attempted=false
        const cancel={stop:()=>context?.abort()};browser.#resources.add(cancel);tab.#resources.add(cancel)
        /** All final role checks and the three queued puts use the same exact
         * C transaction. Its role/lease validation is private and synchronous. */
        const withC=async<T>(mode:IDBTransactionMode,work:(journal:OrdinaryOperationJournal,rows:readonly [Row,Row],bindings:readonly [ReturnType<typeof binding>,ReturnType<typeof binding>],images:readonly [OrdinaryImage,OrdinaryImage])=>T):Promise<T>=>{
          let b:OrdinaryImage|undefined,t:OrdinaryImage|undefined,j:OrdinaryOperationJournal|undefined,completed=false
          try{
            check();context=operationTransaction(await browser.#database(held.binding.live),mode)
            const current=await browser.#classifyOperations(held.binding.live,context,false,candidate.target);check();if(!equal(current,candidate.classification))hold()
            const raw=await Promise.all([context.read(()=>context!.store.get('browser')),context.read(()=>context!.store.get(purpose)),context.read(()=>context!.store.get(names.control))])
            const br=row(raw[0]),tr=row(raw[1]);if(!br?.frame||!tr?.frame||br.pending||tr.pending)hold()
            b=await openOrdinaryFrame(br.frame,br.key);check();t=await openOrdinaryFrame(tr.frame,tr.key);check()
            const bindings=[binding(b),binding(t)] as const
            j=await openOrdinaryOperationControl(raw[2],{browser:{binding:bindings[0],key:br.key},tab:{binding:bindings[1],key:tr.key}});check()
            if(j.phase!=='candidate-committed'||j.request!==enrollment.request||j.id!==candidate.target.header.id||j.sequence!==candidate.target.header.sequence||
              !j.result||!j.target||!j.targetRevisions||j.target.some((digest,i)=>ordinaryFrameDigest([br,tr][i]!.frame!)!==digest)||
              j.targetRevisions.some((revision,i)=>[br,tr][i]!.frame!.revision!==revision))hold()
            const bv=view(new Map(b.records),false),tv=view(new Map(t.records),false),custody=Object.freeze({}) as OrdinaryPairCustody
            pairCustody.set(custody,{kind:'read',browser:b,tab:t,browserOwner:browser,tabOwner:tab,browserStore:bv.store,tabStore:tv.store,
              browserScope:held.binding.browser.scope,tabScope:held.binding.tab.scope,rows:[br,tr],
              operationMarkers:[new Map([...b.records].filter(([n])=>n.startsWith('kithmoot.operation-journal'))),new Map([...t.records].filter(([n])=>n.startsWith('kithmoot.operation-journal')))]})
            try{
              bridge.validateOrdinaryRenewalCommittedCandidate(obligation,pending,bv.store,tv.store,custody,enrollment.request,j.result!);check()
              let value!:T
              await context.step(()=>{check();const result=work(j!,[br,tr],bindings,[b!,t!])
                if(result&&typeof(result as unknown as PromiseLike<unknown>).then==='function'){void Promise.resolve(result).catch(()=>{});hold()}
                check();value=result})
              context.stop();await context.ended;completed=true;return value
            }finally{pairCustody.delete(custody);bv.close();tv.close()}
          }finally{if(!completed&&mode==='readwrite')context?.abort();context?.stop();await context?.ended.catch(()=>{});context=undefined;clearImage(b);clearImage(t);j?.secrets.forEach(key=>key.fill(0))}
        }
        try{
          const prepared=await withC('readonly',(journal,rows,bindings,images)=>{
            const settled:OrdinaryOperationJournal={...journal,phase:'settled',request:'',result:null,secrets:[],nonces:null},bytes=encodeOrdinaryOperationJournal(settled)
            let header:OrdinaryOperationClassification;try{header=decodeOrdinaryOperationClassification(bytes)}finally{bytes.fill(0)}
            const marker=ordinaryOperationMarker({id:journal.id,tab:journal.tab,sequence:journal.sequence,commitment:ordinaryOperationCommitment(header)}),copies=[copyImage(images[0]),copyImage(images[1])] as const
            let success=false
            try{for(const image of copies){(image.records as Map<string,string>).set(names.marker,marker);image.revision++;ordinaryImageByteLength(image)}
              success=true;return {journal:settled,rows,bindings,header,marker,images:copies}
            }finally{if(!success)copies.forEach(clearImage)}
          })
          check()
          const guardedCrypto={subtle:crypto.subtle,getRandomValues:<A extends ArrayBufferView>(value:A):A=>{check();const result=crypto.getRandomValues(value);check();return result}} as unknown as Crypto
          let sf:OrdinaryFrame,st:OrdinaryFrame
          try{sf=await sealOrdinaryImage(prepared.images[0],prepared.rows[0].key,guardedCrypto);check();st=await sealOrdinaryImage(prepared.images[1],prepared.rows[1].key,guardedCrypto);check()}
          finally{prepared.images.forEach(clearImage)}
          const frames=Object.freeze([sf,st]) as readonly [OrdinaryFrame,OrdinaryFrame]
          const control=await sealOrdinaryOperationControl(prepared.journal,{browser:{binding:prepared.bindings[0],key:prepared.rows[0].key},
            tab:{binding:prepared.bindings[1],key:prepared.rows[1].key}},guardedCrypto);check()
          const header=prepared.header
          const next:PreparedRenewalTarget={...candidate.target,header,controlDigest:ordinaryOperationControlDigest(control),
            rows:[rowDigest({frame:frames[0]} as Row),rowDigest({frame:frames[1]} as Row)]}
          const target:OperationClassification=Object.freeze({...candidate.classification,
            owners:Object.freeze(candidate.classification.owners.map(([name,digest])=>Object.freeze([name,name==='browser'?next.rows[0]:name===purpose?next.rows[1]:digest] as const))),
            controls:Object.freeze(candidate.classification.controls.map(([name,digest])=>Object.freeze([name,name===names.control?next.controlDigest:digest] as const))),
            markers:Object.freeze(candidate.classification.markers.map(([name,marker])=>Object.freeze([name,name===names.marker?prepared.marker:marker] as const)))})
          for(;;){
            if(foregroundLifetime)await OrdinaryForegroundSigner.checkMemberRenewalClients(held.binding.identity as OrdinaryForegroundSigner,foregroundLifetime)
            attempted=false
            try{await withC('readwrite',(_j,rows)=>{
              // Copy every mutable binary field for the public IDB argument;
              // retain the original frozen S/control bytes for reconciliation.
              const browserRow={key:rows[0].key,frame:validateOrdinaryFrame(frames[0])},tabRow={key:rows[1].key,frame:validateOrdinaryFrame(frames[1])},journal=validateOrdinaryOperationControl(control)
              check();attempted=true;context!.store.put(browserRow,'browser');check();context!.store.put(tabRow,purpose);check();context!.store.put(journal,names.control)
            })}catch(error){if(!attempted)throw error}
            let retriedPrior=false
            for(;;){
              let read:OperationTransaction|undefined,isPrior=false
              browser.#db?.close();browser.#db=undefined
              try{
                read=operationTransaction(await browser.#database(()=>true,true),'readonly')
                const current=await browser.#classifyOperations(()=>true,read,true,[candidate.target,next]);read.stop();await read.ended
                if(equal(current,target)){
                  const settled=Object.freeze({}) as OrdinaryRenewalSettled
                  renewalSettled.set(settled,Object.freeze({enrollment:candidate.enrollment,target:next,classification:target}));return settled
                }
                isPrior=equal(current,candidate.classification)
              }catch{read?.abort();await read?.ended.catch(()=>{})}finally{read?.stop()}
              if(isPrior){check();if(retriedPrior)break}
              await new Promise<void>(yes=>{browser.#retry=yes;tab.#retry=yes});browser.#retry=undefined;tab.#retry=undefined;retriedPrior=isPrior
            }
          }
        }finally{context?.abort();await context?.ended.catch(()=>{});context?.stop();browser.#resources.delete(cancel);tab.#resources.delete(cancel)}
      })
    }).then(resolve,reject).finally(()=>releaseOrdinaryRenewalSigningLifetime(foregroundLifetime)).catch(()=>{})
    return pending
  }
  /** Validation only: a copied handle, cached image or mutation projection
   * cannot stand in for a fresh native read of this exact acknowledged S.
   * Current role and controller authority must still be checked by the factory.
   * No journal reader, phase exemption or writable image escapes here. */
  static validateSettledMemberRenewalReceipt(settled:OrdinaryRenewalSettled,custody:OrdinaryPairCustody):void{
    const receipt=renewalSettled.get(settled),enrollment=receipt&&renewalEnrollments.get(receipt.enrollment),captured=pairCustody.get(custody)
    if(!receipt||!enrollment||captured?.kind!=='read'||!captured.rows||!captured.operationMarkers||receipt.target.header.phase!=='settled')hold()
    const {binding}=enrollment.held
    OrdinaryStateOwner.#validatePairBinding(custody,binding)
    const names=ordinaryOperationNames(receipt.target.purpose)
    if(captured.rows.some((row,i)=>!row.frame||row.pending||rowDigest(row)!==receipt.target.rows[i])||
      captured.browserOwner.#operationControlDigests.get(names.control)!==receipt.target.controlDigest)hold()
    // The default paired reader authenticated every control in the same
    // coherent transaction as these rows. Match that complete control set.
    const controls=captured.browserOwner.#operationControlDigests
    if(controls.size!==receipt.classification.controls.length||receipt.classification.controls.some(([name,digest])=>controls.get(name)!==digest))hold()
    const markers=new Map(receipt.classification.markers)
    for(const current of captured.operationMarkers)for(const [name,raw]of current)if(markers.get(name)!==raw)hold()
    OrdinaryStateOwner.#validatePairBinding(custody,binding)
  }
  /** Expiry is not proof that an uncertain intent was absent. Authenticate
   * and promote its exact frame before removing expired custody. The caller
   * receives the current native owner so an unknown receipt can be retried. */
  static async expireTabs(live: () => boolean, retaining: (owner: OrdinaryStateOwner | undefined) => void): Promise<void> {
    // Fixed internal composer is loaded before WRITE_LOCK or any native read.
    // A chunk-load failure is a pre-operation HOLD, never a deletion fallback.
    const snapshot = await import('./ordinary-snapshot.js').catch(hold)
    const manager = new OrdinaryStateOwner()
    try {
      await manager.#locked(live, async () => {
        const names = await manager.#ownerNames(live)
        for (const purpose of names) {
          if (purpose === 'browser') continue
          const db = await manager.#database(live), tx = db.transaction(OWNER_STORE, 'readonly'), ended = settled(tx)
          void ended.catch(() => {})
          const saved = row(await request(tx.objectStore(OWNER_STORE).get(purpose)))
          await ended; manager.#check(live)
          const frame = saved?.pending ?? saved?.frame
          if (!saved || !frame || frame.purpose !== purpose) hold()
          const owner = new OrdinaryStateOwner(purpose as OrdinaryPurpose, frame.expiresAt)
          await owner.#verifyRow(saved); manager.#check(live)
          if (Date.now() < frame.expiresAt) continue
          retaining(owner)
          try {
            if (manager.#operationControls.has(purpose as string)) {
              const cleanup = manager.#cleanupSettledTab(purpose as OrdinaryPurpose, owner, live, snapshot)
              manager.#track(cleanup); owner.#track(cleanup)
              await cleanup
              await manager.#operationBarrier(live)
              continue
            }
            let active = saved
            if (saved.pending) {
              active = { key: saved.key, frame: saved.pending }
              await owner.#install(db, saved, active, live, true)
            }
            owner.#check(live, true)
            if (Date.now() < frame.expiresAt) hold()
            await owner.#install(await owner.#database(live, true), active, undefined, live, true)
          } finally { await owner.close(); retaining(undefined) }
        }
      })
    } finally { await manager.close() }
  }
  /** Open existing completed custody without initialising missing state. This
   * read-only startup step grants no role or callback custody; ordinary paired
   * consumers still authenticate their own fresh full composition. */
  openExisting(live: () => boolean): Promise<void> {
    const pending = Promise.resolve().then(async () => {
      this.#check(live)
      if (!navigator.locks) hold()
      return navigator.locks.request(WRITE_LOCK, async () => {
        this.#check(live)
        let db: IDBDatabase | undefined, context: OperationTransaction | undefined, image: OrdinaryImage | undefined
        const resource = { stop: () => context?.abort() }
        this.#resources.add(resource)
        try {
          db = await this.#existingStartupDatabase(live)
          this.#check(live); if (!db) hold()
          db.onversionchange = () => { this.#revoke(); db?.close() }
          context = operationTransaction(db, 'readonly')
          const classified = await this.#classifyOperations(live, context)
          const saved = row(await context.read(() => context!.store.get(this.purpose)))
          this.#check(live)
          if (!saved?.frame || saved.pending) hold()
          image = await openOrdinaryFrame(saved.frame, saved.key)
          this.#check(live)
          if (image.purpose !== this.purpose || image.expiresAt !== this.expiresAt || image.migration?.phase !== 'complete' ||
              this.#generation !== undefined && this.#generation !== image.generation) hold()
          context.stop(); await context.ended; this.#check(live)
          this.#generation = image.generation
          this.#operationControlDigests = new Map(classified.controls)
          this.#operationMarkerValues = new Map(classified.markers)
          this.#operationControls = new Set(classified.controls.map(([name]) => 'tab:' + name.slice(ORDINARY_OPERATION_CONTROL_PREFIX.length)))
        } finally {
          context?.abort(); await context?.ended.catch(() => {}); context?.stop()
          clearImage(image); db?.close(); this.#resources.delete(resource)
        }
      })
    })
    return this.#track(pending)
  }
  /** Initialisation is allowed only after the caller has verified the complete
   * legacy snapshot and old-client handshake. Key and image have one commit. */
  prepare(live: () => boolean, initial: ReadonlyMap<string, string>, migration?: OrdinaryMigration,
    validate?: (store: DeviceStore, migrated: boolean) => void): Promise<void> {
    // Capture all caller input before a lock/crypto await.
    const records = new Map(initial)
    const manifest = migration ? { ...migration, sources: new Map(migration.sources), names: [...migration.names] } : undefined
    return this.#track(this.#locked(live, async () => {
      const previous = await this.#snapshot(live)
      if (!previous.image) {
        if (this.#generation !== undefined) hold() // Deleted custody is not a fresh installation.
        // Raw marker import cannot create authenticated enrollment. Only the
        // dedicated atomic browser/tab/control transition may add markers.
        preserveOperationMarkers(new Map(), records)
        // Fixed-width placeholders check canonical encoding and capacity before
        // expensive validators, key creation or entropy. Never retain this image.
        const checked: OrdinaryImage = { purpose: this.purpose, keyId: '0'.repeat(64), generation: '0'.repeat(64), revision: 0,
          expiresAt: this.expiresAt, records, migration: manifest, fences: new Map() }
        ordinaryImageByteLength(checked)
        if (manifest?.phase === 'sealed') {
          // 'cleaning' adds two canonical bytes before any source is removed.
          // Reserve that control transition before committing initial custody.
          // Later source-pair removal outweighs revision digit growth.
          ordinaryImageByteLength({ ...checked, revision: 1, migration: { ...manifest, phase: 'cleaning' } })
        }
      }
      // The sealed full image, rather than the partially cleaned plaintext,
      // is the validation source on restart. New custody is validated before
      // any key/nonce creation. Helpers cannot edit or retain the private view.
      if (validate) {
        const privateView = view(new Map(previous.image?.records ?? records), false)
        try {
          const result: unknown = validate(privateView.store, previous.image?.migration?.phase === 'complete')
          if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
            void Promise.resolve(result).catch(() => {}); hold()
          }
          this.#check(live)
        } finally { privateView.close() }
      }
      if (previous.image) { this.#generation = previous.image.generation; return }
      if (this.purpose !== 'browser') {
        const names = await this.#ownerNames(live)
        if (names.filter(name => name !== 'browser').length >= MAX_ORDINARY_TAB_OWNERS) hold()
      }
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      this.#check(live)
      const image: OrdinaryImage = { purpose: this.purpose, keyId: random(), generation: random(), revision: 0,
        expiresAt: this.expiresAt, records, migration: manifest, fences: new Map() }
      const frame = await sealOrdinaryImage(image, key)
      this.#check(live)
      await this.#commit(previous, { key, frame }, live)
      this.#generation = image.generation
    }).finally(() => { records.clear(); manifest?.sources.clear() }))
  }
  capture(name: string, live: () => boolean): Promise<OrdinaryScope> { return this.#capture(name, live) }
  #capture(name: string, live: () => boolean): Promise<OrdinaryScope> {
    return this.#track(this.#locked(live, async () => {
      if (typeof name !== 'string' || !name.length || name.length > 512 || this.#generation === undefined) hold()
      const current = await this.#snapshot(live)
      if (!current.image) hold()
      return Object.freeze({ name, generation: current.image.generation, fence: current.image.fences.get(name) ?? 0 })
    }))
  }
  read<T>(scope: OrdinaryScope, live: () => boolean, work: (store: DeviceStore) => T): Promise<T> {
    return this.#reading(scope, live, work)
  }
  /** Production adapters cannot expose records from an incomplete migration. */
  readMigrated<T>(scope: OrdinaryScope, live: () => boolean, work: (store: DeviceStore) => T): Promise<T> {
    return this.#reading(scope, live, work, true)
  }
  #reading<T>(scope: OrdinaryScope, live: () => boolean, work: (store: DeviceStore) => T, requireCompleteMigration = false): Promise<T> {
    const captured = { ...scope }
    return this.#track(this.#locked(live, async () => {
      const current = await this.#snapshot(live)
      if (!current.image || this.#generation === undefined) hold()
      this.#scope(current.image, captured)
      if (requireCompleteMigration && current.image.migration?.phase !== 'complete') hold()
      const privateView = view(new Map(current.image.records), false)
      try {
        const value = work(privateView.store)
        if (value && typeof (value as unknown as PromiseLike<unknown>).then === 'function') hold()
        this.#check(live)
        return value
      } finally { privateView.close() }
    }))
  }
  mutate<T>(scope: OrdinaryScope, live: () => boolean, work: (store: DeviceStore) => T): Promise<T> {
    return this.#mutation(scope, live, work)
  }
  /** Legacy-name conversion must inspect completion in the same locked native
   * snapshot that supplies its records, rather than a prior separate read. */
  mutateMigrated<T>(scope: OrdinaryScope, live: () => boolean, work: (store: DeviceStore, migratedNames: readonly string[]) => T): Promise<T> {
    return this.#mutation(scope, live, (store, names) => { if (!names) hold(); return work(store, names) }, undefined, true)
  }
  /** Compare and replace in one authenticated snapshot. A definite mismatch
   * discards the private view without allocating a nonce or writing a frame. */
  compareAndMutateMigrated(scope: OrdinaryScope, live: () => boolean, work: (store: DeviceStore) => boolean): Promise<boolean> {
    return this.#mutation(scope, live, work, undefined, true, true)
  }
  /** Coherent authenticated browser/tab read. Final semantic bindings must be
   * checked inside the synchronous callback before any result can escape. */
  static readPairMigrated<T>(input: OrdinaryPairMutation<T>): Promise<T> {
    return OrdinaryStateOwner.#readPairMigrated(input)
  }
  static #readPairMigrated<T>(input: OrdinaryPairMutation<T>): Promise<T> {
    const browser = input.browser.owner, tab = input.tab.owner
    const browserScope = { ...input.browser.scope }, tabScope = { ...input.tab.scope }
    const live = input.live, work = input.work
    const check = () => {
      if (browser === tab || browser.purpose !== 'browser' || browser.expiresAt !== 0 || !TAB_PURPOSE.test(tab.purpose) ||
          !Number.isSafeInteger(tab.expiresAt) || tab.expiresAt <= 0 ||
          browser.#generation === undefined || tab.#generation === undefined) hold()
      browser.#check(live); tab.#check(live)
      if (browser.#closed || tab.#closed) hold()
      for (const scope of [browserScope, tabScope]) if (typeof scope.name !== 'string' || !scope.name.length ||
        scope.name.length > 512 || !Number.isSafeInteger(scope.fence) || scope.fence < 0) hold()
    }
    const guarded = () => { try { check(); return true } catch { return false } }
    const operation = Promise.resolve().then(async () => {
      check()
      if (browser.#retry || tab.#retry || !navigator.locks) hold()
      return navigator.locks.request(WRITE_LOCK, async () => {
        check()
        await browser.#operationBarrier(guarded); check()
        let first: OrdinaryImage | undefined, second: OrdinaryImage | undefined
        try {
          const priorBrowser = await browser.#snapshot(guarded)
          clearImage(priorBrowser.image); check()
          const priorTab = await tab.#snapshot(guarded, false, browser)
          clearImage(priorTab.image); check()
          const db = await browser.#database(guarded); check()
          const tx = db.transaction(OWNER_STORE, 'readonly'), ended = settled(tx)
          void ended.catch(() => {})
          let saved: (Row | undefined)[]
          try {
            const store = tx.objectStore(OWNER_STORE)
            const [firstRow, secondRow] = await Promise.all([request(store.get(browser.purpose)), request(store.get(tab.purpose)), browser.#operationControlSnapshot(store)])
            const raw = [firstRow, secondRow]
            await ended; check(); saved = raw.map(row)
          } catch (error) { try { tx.abort() } catch {}; await ended.catch(() => {}); throw error }
          if (!saved[0]?.frame || !saved[1]?.frame || saved[0].pending || saved[1].pending) hold()
          first = await openOrdinaryFrame(saved[0].frame, saved[0].key); check()
          second = await openOrdinaryFrame(saved[1].frame, saved[1].key); check()
          if (first.purpose !== browser.purpose || first.expiresAt !== browser.expiresAt || first.generation !== browser.#generation ||
              second.purpose !== tab.purpose || second.expiresAt !== tab.expiresAt || second.generation !== tab.#generation ||
              first.migration?.phase !== 'complete' || second.migration?.phase !== 'complete') hold()
          browser.#scope(first, browserScope); tab.#scope(second, tabScope)
          const browserView = view(new Map(first.records), false), tabView = view(new Map(second.records), false)
          const custody = Object.freeze({}) as OrdinaryPairCustody
          pairCustody.set(custody, { kind:'read', browser: first, tab: second, browserOwner: browser, tabOwner: tab, browserStore: browserView.store, tabStore: tabView.store, browserScope, tabScope, rows: [saved[0], saved[1]], operationMarkers: browser.#classifiedPairMarkers(first, second) })
          try {
            const result = work(browserView.store, tabView.store,
              Object.freeze([...first.migration.names]), Object.freeze([...second.migration.names]), custody)
            if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') {
              void Promise.resolve(result).catch(() => {}); hold()
            }
            check()
            return result
          } finally { pairCustody.delete(custody); browserView.close(); tabView.close() }
        } finally { clearImage(first); clearImage(second) }
      })
    })
    browser.#track(operation); tab.#track(operation)
    return operation
  }
  /** One origin-local native commit for completed browser and tab images.
   * The caller must retain matching semantic identities in both final records
   * and validate that binding on startup before effects. This primitive does
   * not supply membership authority or independent rollback resistance. */
  static mutatePairMigrated<T>(input: OrdinaryPairMutation<T>): Promise<T> {
    return this.#mutatePairMigrated(input, false) as Promise<T>
  }
  /** Additive producer path. Receipts exist only in memory; durable restart
   * adoption must independently validate the stored successor. No callback
   * result is released as
   * plaintext. A known commit survives later liveness loss as a custody fact;
   * effects require consumePairCommit's fresh native callback instead. */
  static commitPairMigrated(input: OrdinaryPairCommitInput): Promise<OrdinaryPairCommitOutcome> {
    const beforeWrite = input.beforeWrite
    if (typeof beforeWrite !== 'function') return Promise.reject(new OrdinaryStateHold())
    return this.#mutatePairMigrated(input, false, false, beforeWrite) as Promise<OrdinaryPairCommitOutcome>
  }
  /** One attempt only, bound to both exact owners, scopes and committed
   * frames. The callback may synchronously adopt a preallocated successor;
   * it still owes the application's complete semantic and authority checks. */
  static consumePairCommit<T>(input: OrdinaryPairMutation<T> & { readonly receipt: OrdinaryPairCommitReceipt }): Promise<T> {
    const token = input.receipt, receipt = pairCommits.get(token)
    if (!receipt || receipt.state !== 'available') return Promise.reject(new OrdinaryStateHold())
    receipt.state = 'consuming'
    let body: Promise<unknown> | undefined
    try {
      const browser = { owner: input.browser.owner, scope: { ...input.browser.scope } }
      const tab = { owner: input.tab.owner, scope: { ...input.tab.scope } }
      const sameScope = (a: OrdinaryScope, b: OrdinaryScope) => a.name === b.name && a.generation === b.generation && a.fence === b.fence
      if (browser.owner !== receipt.browser.owner || tab.owner !== receipt.tab.owner ||
          !sameScope(browser.scope, receipt.browser.scope) || !sameScope(tab.scope, receipt.tab.scope)) hold()
      const live = input.live, work = input.work
      const pending = this.readPairMigrated({ browser, tab, live, work: (b, t, bn, tn, custody) => {
        const captured = pairCustody.get(custody)
        if (receipt.state !== 'consuming' || captured?.kind !== 'read' || !captured.rows ||
            !sameOrdinaryFrame(captured.rows[0].frame, receipt.frames[0]) ||
            !sameOrdinaryFrame(captured.rows[1].frame, receipt.frames[1])) hold()
        OrdinaryStateOwner.#validatePairBinding(custody, { browser, tab, live })
        receipt.state = 'consumed' // before reentrant application code
        const result = work(b, t, bn, tn, custody)
        if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') {
          body = Promise.resolve(result)
          OrdinaryStateOwner.joinPairLifetime(browser.owner, tab.owner, body)
          void body.catch(() => {}); hold()
        }
        OrdinaryStateOwner.#validatePairBinding(custody, { browser, tab, live })
        return result
      } })
      const result = pending.catch(error => { receipt.state = 'refused'; throw error })
        .finally(async () => { pairCommits.delete(token); if (body) await Promise.allSettled([body]) })
      return OrdinaryStateOwner.joinPairLifetime(browser.owner, tab.owner, result)
    } catch (error) { receipt.state = 'refused'; pairCommits.delete(token); return Promise.reject(error) }
  }
  /** Reserve the two authenticated input scope names at their existing fence
   * values in the SAME candidate. First-use producers size this reservation
   * before entropy; later forget advances existing entries without needing new
   * fence slots. No prior fence is evicted and no scope is advanced here. */
  static retainPairScopesMigrated<T>(input: OrdinaryPairMutation<T>): Promise<T> {
    return this.#mutatePairMigrated(input, false, true) as Promise<T>
  }
  /** Deletion and both invitation fences share one native commit. Old captured
   * queries cannot recreate forgotten custody, even when no record existed. */
  static forgetPairMigrated<T>(input: OrdinaryPairMutation<T>): Promise<T> {
    return this.#mutatePairMigrated(input, true) as Promise<T>
  }
  static #mutatePairMigrated<T>(input: OrdinaryPairMutation<T>, fencing: boolean, reserveScopes = false,
    beforeWrite?: OrdinaryPairPrewrite): Promise<T | OrdinaryPairCommitOutcome> {
    const browser = input.browser.owner, tab = input.tab.owner
    const browserScope = { ...input.browser.scope }, tabScope = { ...input.tab.scope }
    const live = input.live, work = input.work
    const check = () => {
      if (browser === tab || browser.purpose !== 'browser' || browser.expiresAt !== 0 ||
          !TAB_PURPOSE.test(tab.purpose) || !Number.isSafeInteger(tab.expiresAt) || tab.expiresAt <= 0 ||
          browser.#generation === undefined || tab.#generation === undefined) hold()
      browser.#check(live); tab.#check(live)
      if (browser.#closed || tab.#closed) hold()
      for (const scope of [browserScope, tabScope]) if (typeof scope.name !== 'string' ||
        !scope.name.length || scope.name.length > 512 || !Number.isSafeInteger(scope.fence) || scope.fence < 0) hold()
    }
    // Defer even the first lock request until the identical promise is joined
    // by both lifetimes. Neither owner can close past unresolved custody.
    const operation = Promise.resolve().then(async () => {
      check()
      if (browser.#retry || tab.#retry || !navigator.locks) hold()
      return navigator.locks.request(WRITE_LOCK, async () => {
        check()
        let browserSnapshot: Snapshot | undefined, tabSnapshot: Snapshot | undefined
        let browserImage: OrdinaryImage | undefined, tabImage: OrdinaryImage | undefined
        let body: Promise<unknown> | undefined
        const current = () => {
          check()
          if (!browserSnapshot?.image || !tabSnapshot?.image) hold()
          browser.#scope(browserSnapshot.image, browserScope); tab.#scope(tabSnapshot.image, tabScope)
          if (browserSnapshot.image.generation !== browser.#generation || tabSnapshot.image.generation !== tab.#generation ||
              browserSnapshot.image.migration?.phase !== 'complete' || tabSnapshot.image.migration?.phase !== 'complete') hold()
        }
        const guarded = () => {
          try { check(); return true } catch { return false }
        }
        try {
          await browser.#operationBarrier(guarded); check()
          // Prior single-owner intents must finish before the callback or any
          // new frame. Both lifetime guards also cover that recovery work.
          browserSnapshot = await browser.#snapshot(guarded); check()
          tabSnapshot = await tab.#snapshot(guarded, false, browser); current()
          if (!browserSnapshot.row || !tabSnapshot.row) hold()
          browserImage = copyImage(browserSnapshot.image!)
          tabImage = copyImage(tabSnapshot.image!)
          const browserView = view(new Map(browserImage.records), true), tabView = view(new Map(tabImage.records), true)
          const custody = Object.freeze({}) as OrdinaryPairCustody
          pairCustody.set(custody, { kind:'mutation', browser: browserImage, tab: tabImage, browserOwner: browser, tabOwner: tab, browserStore: browserView.store, tabStore: tabView.store, browserScope, tabScope, operationMarkers: browser.#classifiedPairMarkers(browserSnapshot.image!, tabSnapshot.image!) })
          let result: T
          try {
            result = work(browserView.store, tabView.store,
              Object.freeze([...browserImage.migration!.names]), Object.freeze([...tabImage.migration!.names]), custody)
            if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') {
              if (beforeWrite) {
                body = Promise.resolve(result)
                OrdinaryStateOwner.joinPairLifetime(browser, tab, body)
              }
              void Promise.resolve(result).catch(() => {}); hold()
            }
            if (beforeWrite && result !== undefined) hold()
            current()
            ;(browserImage.records as Map<string, string>).clear()
            ;(tabImage.records as Map<string, string>).clear()
            browserImage.records = new Map(browserView.store.keys().map(name => [name, browserView.store.get(name)!]))
            tabImage.records = new Map(tabView.store.keys().map(name => [name, tabView.store.get(name)!]))
          } finally { pairCustody.delete(custody); browserView.close(); tabView.close() }
          preserveOperationMarkers(browserSnapshot.image!.records, browserImage.records)
          preserveOperationMarkers(tabSnapshot.image!.records, tabImage.records)
          browserImage.revision++; tabImage.revision++
          if (reserveScopes) {
            if (!browserImage.fences.has(browserScope.name)) (browserImage.fences as Map<string, number>).set(browserScope.name, browserScope.fence)
            if (!tabImage.fences.has(tabScope.name)) (tabImage.fences as Map<string, number>).set(tabScope.name, tabScope.fence)
          }
          if (fencing) {
            ;(browserImage.fences as Map<string, number>).set(browserScope.name, browserScope.fence + 1)
            ;(tabImage.fences as Map<string, number>).set(tabScope.name, tabScope.fence + 1)
          }
          // The second image can refuse capacity before the first nonce exists.
          ordinaryImageByteLength(browserImage); ordinaryImageByteLength(tabImage)
          const browserFrame = await sealOrdinaryImage(browserImage, browserSnapshot.row.key); current()
          const tabFrame = await sealOrdinaryImage(tabImage, tabSnapshot.row.key); current()
          const installed = await OrdinaryStateOwner.#installPair(browser, tab, browserSnapshot, tabSnapshot,
            { key: browserSnapshot.row.key, frame: beforeWrite ? validateOrdinaryFrame(browserFrame) : browserFrame },
            { key: tabSnapshot.row.key, frame: beforeWrite ? validateOrdinaryFrame(tabFrame) : tabFrame }, current,
            beforeWrite && { work: beforeWrite, browserScope, tabScope })
          if (beforeWrite) {
            if (installed === 'definite-abort') return Object.freeze({ status: 'definite-abort' as const })
            const receipt = Object.freeze({}) as OrdinaryPairCommitReceipt
            pairCommits.set(receipt, { browser: { owner: browser, scope: Object.freeze({ ...browserScope }) },
              tab: { owner: tab, scope: Object.freeze({ ...tabScope }) },
              frames: [validateOrdinaryFrame(browserFrame), validateOrdinaryFrame(tabFrame)], state: 'available' })
            return Object.freeze({ status: 'committed' as const, receipt })
          }
          current()
          return result!
        } finally {
          clearImage(browserImage); clearImage(tabImage)
          clearImage(browserSnapshot?.image); clearImage(tabSnapshot?.image)
          if (body) await Promise.allSettled([body])
        }
      })
    })
    browser.#track(operation); tab.#track(operation)
    return operation
  }
  static async #installPair(browser: OrdinaryStateOwner, tab: OrdinaryStateOwner,
    browserPrevious: Snapshot, tabPrevious: Snapshot, browserCandidate: Row, tabCandidate: Row,
    check: () => void, barrier?: { work: OrdinaryPairPrewrite; browserScope: OrdinaryScope; tabScope: OrdinaryScope }): Promise<'committed' | 'definite-abort'> {
    check()
    const tx = browserPrevious.db.transaction(OWNER_STORE, 'readwrite')
    const browserPurpose = browser.purpose, tabPurpose = tab.purpose
    let aborted = false
    const ended = settled(tx, () => { aborted = true })
    void ended.catch(() => {})
    let writesAttempted = false, authentication: Promise<void> | undefined
    let reconcile = !!barrier
    // Preserve exact expectations independently of the objects passed to
    // native put. Producer receipts are confirmed by a coherent readback even
    // after ordinary oncomplete, rather than inferred from request outcomes.
    const browserExpected = barrier ? { key: browserCandidate.key, frame: validateOrdinaryFrame(browserCandidate.frame) } : browserCandidate
    const tabExpected = barrier ? { key: tabCandidate.key, frame: validateOrdinaryFrame(tabCandidate.frame) } : tabCandidate
    let first: OrdinaryImage | undefined, second: OrdinaryImage | undefined, body: Promise<unknown> | undefined
    let barrierRefused = false, sourceRefused = false, authenticationRefused = false
    const sourceCheck = () => {
      try { check() } catch (error) { sourceRefused = true; throw error }
    }
    const equalImage = (a: OrdinaryImage, b: OrdinaryImage) => {
      const x = encodeOrdinaryImage(a), y = encodeOrdinaryImage(b)
      try { return x.length === y.length && x.every((byte, i) => byte === y[i]) }
      finally { x.fill(0); y.fill(0) }
    }
    try {
      try {
        const store = tx.objectStore(OWNER_STORE)
        const [firstRow, secondRow] = await Promise.all([request(store.get(browser.purpose)), request(store.get(tab.purpose)), browser.#operationControlSnapshot(store)])
            const raw = [firstRow, secondRow]
        const saved = raw.map(row)
        sourceCheck()
        if (!saved[0]?.frame || !saved[1]?.frame || !sameRow(saved[0], browserPrevious.row) ||
            !sameRow(saved[1], tabPrevious.row) || saved[0].pending || saved[1].pending) hold()
        let authenticated = false, refused = false, barrierStarted = false
        const barrierCheck = () => {
          try {
            sourceCheck()
            if (!barrier || !first || !second || !browserPrevious.image || !tabPrevious.image ||
                first.purpose !== browser.purpose || first.expiresAt !== browser.expiresAt || first.generation !== browser.#generation ||
                second.purpose !== tab.purpose || second.expiresAt !== tab.expiresAt || second.generation !== tab.#generation ||
                first.migration?.phase !== 'complete' || second.migration?.phase !== 'complete' ||
                !sameRow(saved[0], browserPrevious.row) || !sameRow(saved[1], tabPrevious.row) ||
                !equalImage(first, browserPrevious.image) || !equalImage(second, tabPrevious.image)) hold()
            browser.#scope(first, barrier.browserScope); tab.#scope(second, barrier.tabScope)
          } catch (error) { sourceRefused = true; throw error }
        }
        // CryptoKey clones have no comparable public identity. Authenticate
        // the freshly read keys while THIS writer transaction owns both rows.
        // The barrier and both puts run in its active request callback.
        const keepAlive = () => {
          const r = store.getKey(browser.purpose)
          r.onerror = () => { refused = true; try { tx.abort() } catch {} }
          r.onsuccess = () => {
            try {
              sourceCheck()
              if (refused) { tx.abort(); return }
              if (!authenticated) { keepAlive(); return }
              if (barrier) {
                if (barrierStarted) hold()
                barrierStarted = true
                barrierCheck()
                const browserView = view(new Map(first!.records), false), tabView = view(new Map(second!.records), false)
                const custody = Object.freeze({}) as OrdinaryPairCustody
                pairCustody.set(custody, { kind: 'read', browser: first!, tab: second!, browserOwner: browser, tabOwner: tab,
                  browserStore: browserView.store, tabStore: tabView.store, browserScope: barrier.browserScope, tabScope: barrier.tabScope,
                  rows: [saved[0]!, saved[1]!], operationMarkers: browser.#classifiedPairMarkers(first!, second!) })
                try {
                  const result: unknown = barrier.work(browserView.store, tabView.store,
                    Object.freeze([...first!.migration!.names]), Object.freeze([...second!.migration!.names]), custody)
                  if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
                    body = Promise.resolve(result)
                    OrdinaryStateOwner.joinPairLifetime(browser, tab, body)
                    void body.catch(() => {}); hold()
                  }
                  if (result !== undefined) hold()
                  barrierCheck()
                } catch (error) { barrierRefused = true; throw error }
                finally { pairCustody.delete(custody); browserView.close(); tabView.close() }
              }
              // No await, application callback, getter or entropy separates
              // the final barrier check from these two candidate puts. Mark
              // attempted before calling put: a throwing native wrapper may
              // already have queued it, so only both-row reconciliation can
              // prove absence after this point.
              writesAttempted = true
              store.put(browserCandidate, browserPurpose)
              store.put(tabCandidate, tabPurpose)
            } catch { refused = true; try { tx.abort() } catch {} }
          }
        }
        keepAlive()
        authentication = (async () => {
          try {
            first = await openOrdinaryFrame(saved[0]!.frame!, saved[0]!.key); sourceCheck()
            second = await openOrdinaryFrame(saved[1]!.frame!, saved[1]!.key); sourceCheck()
            if (first.purpose !== browser.purpose || first.expiresAt !== browser.expiresAt ||
                second.purpose !== tab.purpose || second.expiresAt !== tab.expiresAt) hold()
            authenticated = true
          } catch { refused = true; authenticationRefused = true }
          finally { if (!barrier) { clearImage(first); clearImage(second) } }
        })()
        await ended
      } catch {
        try { tx.abort() } catch {}
        await ended.catch(() => {})
        await authentication
        if (!writesAttempted) {
          // Native abort is proof that neither put was queued. Callback,
          // source or authentication refusal remains a refusal, not an
          // inferred safe-abort result for the producer.
          if (barrier && aborted && !barrierRefused && !sourceRefused && !authenticationRefused && first && second) {
            return 'definite-abort'
          }
          throw new OrdinaryStateHold()
        }
        reconcile = true
      }
      await authentication
      if (!writesAttempted && (barrierRefused || sourceRefused || authenticationRefused)) throw new OrdinaryStateHold()
      if (reconcile) {
        // Classify BOTH exact rows from ONE readonly transaction. Unknown,
        // mixed or unauthenticated results retain this lock and ciphertext.
        for (;;) {
          browser.#db?.close(); browser.#db = undefined
          tab.#db?.close(); tab.#db = undefined
          try {
            const db = await browser.#database(() => true, true)
            const read = db.transaction(OWNER_STORE, 'readonly'), finished = settled(read)
            void finished.catch(() => {})
            let saved: (Row | undefined)[]
            try {
              const store = read.objectStore(OWNER_STORE)
              const [firstRow, secondRow] = await Promise.all([request(store.get(browser.purpose)), request(store.get(tab.purpose)), browser.#operationControlSnapshot(store)])
            const raw = [firstRow, secondRow]
              await finished
              saved = raw.map(row)
            } catch (error) { try { read.abort() } catch {}; await finished.catch(() => {}); throw error }
            if (!saved[0]?.frame || !saved[1]?.frame || saved[0].pending || saved[1].pending) hold()
            let a: OrdinaryImage | undefined, b: OrdinaryImage | undefined
            try {
              a = await openOrdinaryFrame(saved[0].frame, saved[0].key)
              b = await openOrdinaryFrame(saved[1].frame, saved[1].key)
              if (a.purpose !== browser.purpose || a.expiresAt !== browser.expiresAt ||
                  b.purpose !== tab.purpose || b.expiresAt !== tab.expiresAt) hold()
              if (sameRow(saved[0], browserExpected) && sameRow(saved[1], tabExpected)) break
              if (sameRow(saved[0], browserPrevious.row) && sameRow(saved[1], tabPrevious.row)) throw new DefiniteAbort()
            } finally { clearImage(a); clearImage(b) }
          } catch (error) {
            if (error instanceof DefiniteAbort) {
              if (barrier) return 'definite-abort'
              throw new OrdinaryStateHold()
            }
          }
          await new Promise<void>(resolve => { browser.#retry = resolve; tab.#retry = resolve })
          browser.#retry = undefined; tab.#retry = undefined
        }
      }
      await authentication
      // Existing mutation callers still suppress results after liveness loss.
      // The producer receives only a committed custody fact and opaque receipt;
      // adoption must independently authenticate a fresh current pair later.
      if (!barrier) check()
      return 'committed'
    } finally {
      clearImage(first); clearImage(second)
      if (body) await Promise.allSettled([body])
    }
  }

  /** The fence is committed with deletion; a captured pre-forget scope can
   * never repopulate this room. Capacity is checked by the canonical codec. */
  forget(scope: OrdinaryScope, live: () => boolean, selected: (name: string, value: string) => boolean): Promise<void> {
    const captured = { ...scope }
    return this.#mutation(captured, live, store => {
      for (const name of store.keys()) if (selected(name, store.get(name)!)) store.remove(name)
    }, image => { (image.fences as Map<string, number>).set(captured.name, image.revision + 1) })
  }
  migration(scope: OrdinaryScope, live: () => boolean): Promise<OrdinaryMigration | undefined> {
    const captured = { ...scope }
    return this.#track(this.#locked(live, async () => {
      const snapshot = await this.#snapshot(live)
      if (!snapshot.image || this.#generation === undefined) hold()
      this.#scope(snapshot.image, captured)
      return snapshot.image.migration ? structuredClone(snapshot.image.migration) : undefined
    }))
  }
  /** Migration orchestration verifies legacy source bytes between these
   * encrypted manifest commits; this method never deletes Storage itself. */
  retainMigration(scope: OrdinaryScope, live: () => boolean, input: OrdinaryMigration): Promise<void> {
    const manifest = { ...input, sources: new Map(input.sources), names: [...input.names] }
    return this.#mutation(scope, live, () => {}, image => { image.migration = manifest })
      .finally(() => manifest.sources.clear())
  }
  #mutation<T>(scope: OrdinaryScope, live: () => boolean, work: (store: DeviceStore, migratedNames?: readonly string[]) => T,
    control?: (image: OrdinaryImage) => void, requireCompleteMigration = false, commitIfTrue = false): Promise<T> {
    const captured = { ...scope }
    return this.#track(this.#locked(live, async () => {
      const current = await this.#snapshot(live)
      if (!current.image || !current.row || this.#generation === undefined) hold()
      this.#scope(current.image, captured)
      if (requireCompleteMigration && current.image.migration?.phase !== 'complete') hold()
      const image = copyImage(current.image)
      const records = new Map(image.records), privateView = view(records, true)
      try {
        const result = work(privateView.store, requireCompleteMigration ? Object.freeze([...current.image.migration!.names]) : undefined)
        if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') hold()
        this.#check(live)
        if (commitIfTrue) {
          if (typeof result !== 'boolean') hold()
          if (!result) return result
        }
        // Copy before revoking the helper view; no escaped helper may edit the candidate.
        image.records = new Map(records)
        preserveOperationMarkers(current.image.records, image.records)
        privateView.close()
        control?.(image)
        image.revision++
        const frame = await sealOrdinaryImage(image, current.row.key)
        this.#check(live)
        await this.#commit(current, { key: current.row.key, frame }, live)
        this.#check(live)
        return result
      } finally { privateView.close(); (image.records as Map<string,string>).clear(); image.migration?.sources instanceof Map && image.migration.sources.clear() }
    }))
  }
  async #verifyRow(saved: Row): Promise<void> {
    if (!saved.frame && !saved.pending) hold()
    let current: OrdinaryImage | undefined, intended: OrdinaryImage | undefined
    try {
      current = saved.frame ? await openOrdinaryFrame(saved.frame, saved.key) : undefined
      intended = saved.pending ? await openOrdinaryFrame(saved.pending, saved.key) : undefined
      for (const image of [current, intended]) if (image && (image.purpose !== this.purpose || image.expiresAt !== this.expiresAt)) hold()
      if (intended && (current ? intended.generation !== current.generation || intended.keyId !== current.keyId ||
          intended.revision !== current.revision + 1 : intended.revision !== 0)) hold()
    } finally { clearImage(current); clearImage(intended) }
  }
  async #commit(previous: Snapshot, candidate: Row, live: () => boolean): Promise<void> {
    if (!candidate.frame || candidate.pending || previous.row?.pending) hold()
    // Native atomic intent first, then byte-exact promotion. Both rows use
    // the same non-extractable key. No dependent effect is acknowledged at
    // the staging boundary, and restart never re-encrypts the staged frame.
    const staged: Row = { key: candidate.key, pending: candidate.frame,
      ...(previous.row?.frame ? { frame: previous.row.frame } : {}) }
    await this.#install(previous.db, previous.row, staged, live)
    await this.#install(await this.#database(live), staged, candidate, live)
  }
  async #install(db: IDBDatabase, previous: Row | undefined, candidate: Row | undefined, live: () => boolean, expiredCleanup = false): Promise<void> {
    this.#check(live, expiredCleanup)
    const tx = db.transaction(OWNER_STORE, 'readwrite'), ended = settled(tx)
    void ended.catch(() => {})
    const abort = () => { try { tx.abort() } catch {} }
    try {
      const store = tx.objectStore(OWNER_STORE)
      const saved = row(await request(store.get(this.purpose)))
      this.#check(live, expiredCleanup)
      if (!sameRow(saved, previous)) hold()
      if (candidate) store.put(candidate, this.purpose)
      else store.delete(this.purpose)
      await ended
    } catch {
      abort(); await ended.catch(() => {})
      // An acknowledgement failure is reconciled under the SAME lock and
      // with the SAME nonce/frame. No later tab can advance past an unknown.
      for (;;) {
        this.#db?.close(); this.#db = undefined
        try {
          const reopened = await this.#snapshot(() => true, true)
          if (sameRow(reopened.row, candidate)) { if (reopened.row) await this.#verifyRow(reopened.row); break }
          if (sameRow(reopened.row, previous)) throw new DefiniteAbort()
        } catch (reconciliation) {
          if (reconciliation instanceof DefiniteAbort) throw new OrdinaryStateHold()
          // Missing/corrupt/unavailable custody is not absence or success.
        }
        await new Promise<void>(resolve => { this.#retry = resolve })
        this.#retry = undefined
      }
    }
    this.#check(live, expiredCleanup)
  }
  /** Stops local effects immediately, joins actual native work, then closes. */
  close(): Promise<void> { return this.#close() }
  async #close(): Promise<void> {
    this.#revoke()
    while (this.#work.size) await Promise.allSettled([...this.#work])
    this.#db?.close(); this.#db = undefined
  }
}
