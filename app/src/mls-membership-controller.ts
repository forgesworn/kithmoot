import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import type { Event } from 'nostr-tools/pure'
import type { VmlsGrantState } from '../public/vmls-wasm/vmls_wasm.js'
import { sendVmlsRevocationRequest, vmlsMemberGrantReference, VMLS_REVOCATION_REQUEST_SECONDS,
  type VmlsRevocationIdentity, type VmlsRevocationPublication } from '../../src/vmls-revocation-request.js'
import { BrowserMlsGrantLedger, grantRecordByReference, mlsGrantReference, removalGrantRefs } from './mls-grant-ledger.js'
import type { BrowserMlsRoomOperations, MlsMemberStatus, MlsRemovalStatus, MlsRoomContext } from './mls-room-operations.js'

export interface MlsRemovalPlan {
  operation: string
  kind: 'device' | 'person'
  target: string
  room: { session: string; principal: string; persona: string; generation: number; revision: string; rendezvousKey: string; account: string }
  members: MlsMemberStatus[]
  grants: { node: string; reference: string; device: string; rooms: { session: string; name: string; leaf: string }[]; action: 'retain' | 'grace' | 'revoke' | 'request' }[]
  compromised: boolean
  request?: { keeper: string; device: string; sessions: string[]; boxes: string[] }
}
export interface MlsMembershipView { members: MlsMemberStatus[]; removals: MlsRemovalStatus[] }

type Operations = Pick<BrowserMlsRoomOperations, 'members' | 'membership' | 'removeDevice' | 'removePerson' | 'driveRemoval' | 'retryRemoval' |
  'setRemovalGrant' | 'setRemovalGrants' | 'roomRevocationAuthority'>
type RoomSnapshot = { context: MlsRoomContext; session: string; account: string; binding: MlsRemovalPlan['room'] }
const unavailable = (result: { state: string; reason?: string }): string => result.reason ?? result.state

/** Composes the engine-owned journal with the browser's durable grant ledger.
 * The engine remains the only source of permitted claim text and component
 * state. A failed box write never changes a grant to Revoked. */
export class BrowserMlsMembershipController {
  constructor(private operations: Operations, private grants: BrowserMlsGrantLedger,
    private context: () => MlsRoomContext | undefined, private session: () => string | undefined,
    private persona: () => string | undefined, private now: () => number = () => Math.floor(Date.now() / 1000)) {}
  #room(): RoomSnapshot {
    const context = this.context(), session = this.session(), account = this.persona()
    if (!context || !session || !account || !context.current()) throw new Error('Open a current MLS room before changing membership.')
    const vault = context.vault
    return { context, session, account, binding: { session, principal: vault.principal, persona: vault.persona, generation: vault.generation,
      revision: vault.revision, rendezvousKey: context.rendezvousKey, account } }
  }
  #assertRoom(room: RoomSnapshot): void {
    const current = this.context(), session = this.session(), account = this.persona(), vault = current?.vault
    if (!current || current !== room.context || !room.context.current() || !current.current() || session !== room.session || account !== room.account || !vault ||
      JSON.stringify({ session, principal: vault.principal, persona: vault.persona, generation: vault.generation, revision: vault.revision,
        rendezvousKey: current.rendezvousKey, account }) !== JSON.stringify(room.binding)) throw new Error('The MLS room or account changed. Review the removal again.')
  }
  async view(): Promise<MlsMembershipView> {
    const room = this.#room()
    return this.#view(room)
  }
  async #view(room: RoomSnapshot): Promise<MlsMembershipView> {
    const [members, removals] = await Promise.all([this.operations.members(room.context, room.session), this.operations.membership(room.context, room.session)])
    this.#assertRoom(room)
    if (members.state !== 'active') throw new Error(`MLS roster unavailable: ${unavailable(members)}`)
    if (removals.state !== 'active') throw new Error(`MLS membership journal unavailable: ${unavailable(removals)}`)
    return { members: members.value, removals: removals.value }
  }
  async plan(kind: 'device' | 'person', target: string, compromised: boolean): Promise<MlsRemovalPlan> {
    const room = this.#room()
    return this.#plan(room, kind, target, compromised, bytesToHex(crypto.getRandomValues(new Uint8Array(32))))
  }
  async #plan(room: RoomSnapshot, kind: 'device' | 'person', target: string, compromised: boolean, operation: string): Promise<MlsRemovalPlan> {
    const view = await this.#view(room)
    const members = (kind === 'person' ? view.members.filter(member => member.identity === target) : view.members.filter(member => member.leafId === target))
      .sort((a, b) => a.leafId.localeCompare(b.leafId))
    if (!members.length) throw new Error('That member is no longer in this MLS room.')
    if (members.some(member => member.own)) throw new Error(kind === 'person' ? 'Remove another device separately before removing your whole identity.' : 'This device cannot remove its own active leaf.')
    if (kind === 'device' && members.every(member => member.identity === room.account)) {
      const authority = await this.operations.roomRevocationAuthority(room.context, room.session)
      this.#assertRoom(room)
      if (authority.state !== 'active') throw new Error(`The room keeper is unavailable: ${unavailable(authority)}`)
      const keeper = authority.value.keeper
      if (!keeper || keeper === room.account) throw new Error('This room has no separate authenticated keeper to ask.')
      const devices = [...new Set(members.map(member => member.device))], boxes = [...new Set(members.map(member => member.homeBox))].sort()
      if (devices.length !== 1) throw new Error('The reviewed MLS leaf does not identify one device.')
      const request = { keeper, device: devices[0]!, sessions: [room.session], boxes }
      return { operation, kind, target, room: room.binding, members, compromised, request,
        grants: boxes.map(node => ({ node, reference: vmlsMemberGrantReference(node, request.device), device: request.device,
          rooms: [{ session: room.session, name: authority.value.name, leaf: target }], action: 'request' })) }
    }
    const records = await this.grants.records(), refs = removalGrantRefs(room.account, members.map(member => member.device), records)
    this.#assertRoom(room)
    return { operation, kind, target, room: room.binding, members, compromised, grants: refs.map(ref => {
      const node = bytesToHex(ref.node), reference = bytesToHex(ref.grant)
      const record = grantRecordByReference(node, reference, records)
      if (!record) throw new Error('The VMLS grant ledger changed while planning this removal.')
      const leaves = new Set(members.filter(member => member.device === record.device).map(member => member.leafId))
      if (!record.rooms.some(use => use.session === room.session && leaves.has(use.leaf))) throw new Error('The VMLS grant has no saved use for the reviewed member in this room.')
      return { node, reference, device: record.device, rooms: structuredClone(record.rooms),
        action: compromised ? 'revoke' : record.rooms.some(use => use.session !== room.session) ? 'retain' : 'grace' }
    }) }
  }
  async begin(plan: MlsRemovalPlan): Promise<MlsRemovalStatus> {
    const room = this.#room()
    if (JSON.stringify(room.binding) !== JSON.stringify(plan.room)) throw new Error('The MLS room or account changed. Review the removal again.')
    const fresh = await this.#plan(room, plan.kind, plan.target, plan.compromised, plan.operation)
    if (JSON.stringify(fresh) !== JSON.stringify(plan)) throw new Error('Membership or grant authority changed. Review the removal again.')
    const refs = fresh.grants.map(grant => ({ node: hexToBytes(grant.node), grant: hexToBytes(grant.reference), keeper: grant.action !== 'request' }))
    this.#assertRoom(room)
    const result = plan.kind === 'person'
      ? await this.operations.removePerson(room.context, room.session, { operation: plan.operation, identity: plan.target, members: fresh.members, grants: refs, compromised: plan.compromised })
      : await this.operations.removeDevice(room.context, room.session, { operation: plan.operation, leafId: plan.target, members: fresh.members, grants: refs,
        compromised: plan.compromised, ...(fresh.request ? { request: fresh.request } : {}) })
    if (result.state !== 'active') throw new Error(`The removal was not recorded: ${unavailable(result)}`)
    return result.value
  }
  async advance(operation: string): Promise<MlsRemovalStatus> {
    const room = this.#room()
    let before = await this.#status(operation)
    if (before.mls === 'Failed') {
      const retried = await this.operations.retryRemoval(room.context, room.session, operation)
      if (retried.state !== 'active') throw new Error(`The MLS Remove retry is pending: ${unavailable(retried)}`)
      before = retried.value
    }
    const grants = (status: MlsRemovalStatus) => status.grants.filter(item => item.grant.keeper && item.state.type !== 'Revoked')
      .map(item => this.#revoke(room, operation, status.leaves, status.compromised, item.grant.node, item.grant.grant))
    if (before.compromised) {
      const [mls] = await Promise.allSettled([this.operations.driveRemoval(room.context, room.session, operation), ...grants(before)])
      if (mls.status === 'rejected') throw mls.reason
      if (mls.value.state !== 'active') throw new Error(`The MLS Remove is pending: ${unavailable(mls.value)}`)
    } else {
      const driven = await this.operations.driveRemoval(room.context, room.session, operation)
      if (driven.state !== 'active') throw new Error(`The MLS Remove is pending: ${unavailable(driven)}`)
      const applied = await this.#status(operation)
      if (applied.mls !== 'Committed') return applied
      await Promise.allSettled(grants(applied))
    }
    return await this.#status(operation)
  }
  async requestRevocation(operation: string, options: {
    identity: VmlsRevocationIdentity
    directoryEvents: readonly Event[]
    publish: (publication: VmlsRevocationPublication) => Promise<void>
    random?: () => number
  }): Promise<MlsRemovalStatus> {
    const room = this.#room(), before = await this.#status(operation), request = before.request
    if (!request) throw new Error('That removal has no member revocation request.')
    const expected = request.boxes.map(node => ({ node, reference: vmlsMemberGrantReference(node, request.device) }))
    const actual = before.grants.filter(item => !item.grant.keeper)
      .map(item => ({ node: bytesToHex(item.grant.node), reference: bytesToHex(item.grant.grant) }))
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('The member revocation request no longer matches its journal.')
    const createdAt = this.now()
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error('A trusted request time is unavailable.')
    const current = () => { try { this.#assertRoom(room); return true } catch { return false } }
    await sendVmlsRevocationRequest({ identity: options.identity, request: { sender: room.account, keeper: request.keeper,
      device: request.device, sessions: request.sessions, boxes: request.boxes, createdAt, expiration: createdAt + VMLS_REVOCATION_REQUEST_SECONDS },
    directoryEvents: options.directoryEvents, publish: options.publish, current, random: options.random })
    this.#assertRoom(room)
    const changed = await this.operations.setRemovalGrants(room.context, room.session, operation,
      expected.map(item => ({ grant: item.reference, state: { type: 'NotAuthorised' as const, requested: true } })))
    if (changed.state !== 'active') throw new Error(`The sent revocation request was not recorded: ${unavailable(changed)}`)
    return changed.value
  }
  async #revoke(room: { context: MlsRoomContext; session: string }, operation: string, leaves: readonly string[], compromised: boolean, nodeBytes: Uint8Array, refBytes: Uint8Array): Promise<void> {
    const node = bytesToHex(nodeBytes), reference = bytesToHex(refBytes), records = await this.grants.records()
    const record = grantRecordByReference(node, reference, records)
    if (!record) return
    try {
      const withdrawal = await this.grants.withdraw(node, record.device, reference, room.session, leaves, compromised)
      if (withdrawal.result !== 'revoked') return
      if (mlsGrantReference(withdrawal.record.node, withdrawal.record.grantId) !== reference || withdrawal.record.state !== 'revoked') throw new Error('The box confirmed a different VMLS grant withdrawal.')
      await this.operations.setRemovalGrant(room.context, room.session, operation, reference, { type: 'Revoked' })
    } catch (error) {
      await this.operations.setRemovalGrant(room.context, room.session, operation, reference, { type: 'Failed' }).catch(() => undefined)
      throw error
    }
  }
  async #status(operation: string): Promise<MlsRemovalStatus> {
    const room = this.#room(), result = await this.operations.membership(room.context, room.session)
    if (result.state !== 'active') throw new Error(`MLS membership journal unavailable: ${unavailable(result)}`)
    const found = result.value.find(item => item.operation === operation)
    if (!found) throw new Error('That removal is no longer in the membership journal.')
    return found
  }
}

export function grantStateCopy(state: VmlsGrantState): string {
  if (state.type === 'Pending') return 'not yet revoked at the box.'
  if (state.type === 'Revoked') return 'revoked at the box.'
  if (state.type === 'Failed') return 'revocation failed; retry is available.'
  const requested = (state as { type: 'NotAuthorised'; requested: boolean }).requested
  return requested ? 'revocation requested from its keeper; not performed.' : 'not yours to revoke.'
}

export function removalComponentCopy(removal: MlsRemovalStatus): { mls: string; credential?: string; grants: string[]; hold?: string; claim: string } {
  const mls = removal.mls === 'Pending' ? 'MLS Remove: not yet applied and witnessed.'
    : removal.mls === 'Committed' ? 'MLS Remove: applied at this browser and witnessed.'
      : 'MLS Remove: refused by the engine and stopped. Retry it or close the room.'
  const credential = removal.kind === 'person' ? removal.credential === 'Unchanged' ? 'Credential: not revoked.'
    : removal.credential === 'Pending' ? 'Credential: revocation asked, not yet seen.'
      : removal.credential === 'Revoked' ? 'Credential: a tombstone is seen.' : 'Credential: revocation failed.' : undefined
  const grants = removal.grants.map(grant => `Grant at box ${bytesToHex(grant.grant.node).slice(0, 12)}…: ${grantStateCopy(grant.state)}`)
  const hold = removal.compromised ? removal.mls === 'Committed'
    ? 'Taken as compromised: this browser’s sends resumed in the epoch after the Remove.'
    : 'Taken as compromised: this browser’s new sends and Adds here are held until the Remove is applied and witnessed.' : undefined
  return { mls, credential, grants, hold, claim: removal.claimCopy ?? '' }
}
