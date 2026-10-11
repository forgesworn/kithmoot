import type { BrowserMlsKeeperDecisions, MlsKeeperDecisionPlan, MlsKeeperExecutionPlan } from './mls-keeper-decisions.js'
import type { BrowserMlsGrantLedger } from './mls-grant-ledger.js'
import type { BrowserMlsRoomOperations, MlsRemovalEffect, MlsRoomContext } from './mls-room-operations.js'
import type { MlsRevocationInboxContext } from './mls-revocation-inbox.js'

export interface MlsKeeperRequestProgress {
  operation: string
  state: 'approved' | 'done'
  rooms: { session: string; operation: string; state: 'pending' | 'committed' | 'ledger-only' | 'absent'; failure?: string; effect?: MlsRemovalEffect }[]
  grants: { node: string; reference: string; state: 'pending' | 'revoked' | 'unavailable' | 'no-live'; access?: 'unconfirmed'; failure?: string }[]
  completion?: 'awaiting-grant-install-hold' | 'awaiting-pending-add-readback' | 'awaiting-legacy-add-proof'
}
type Operations = Pick<BrowserMlsRoomOperations, 'removeRequestedDevice' | 'driveRemoval' | 'membership' | 'retryRemoval' | 'setRemovalGrants'>
const failure = (error: unknown): string => error instanceof Error ? error.message : 'The operation could not be confirmed.'

/** Explicit acceptance and retry only. Room commits and exact box withdrawals
 * advance independently; neither component can manufacture the other's claim.
 * The room driver still delivers and acknowledges the persisted MLS outbox. */
export class BrowserMlsKeeperRequestController {
  readonly #running = new Map<string, Promise<MlsKeeperRequestProgress>>()
  constructor(private decisions: BrowserMlsKeeperDecisions, private operations: Operations,
    private grants: Pick<BrowserMlsGrantLedger, 'withdrawRequestedDevice'>, private context: () => MlsRevocationInboxContext | undefined) {}

  async approve(plan: MlsKeeperDecisionPlan): Promise<MlsKeeperRequestProgress> {
    const copy = structuredClone(plan), accepted = await this.decisions.decide(copy, true)
    if (accepted.state !== 'active') throw new Error('The keeper approval is awaiting its witness.')
    return this.advance(copy.prompt.operation)
  }
  advance(operation: string): Promise<MlsKeeperRequestProgress> {
    const running = this.#running.get(operation)
    if (running) return running
    const work = this.#advance(operation).finally(() => { if (this.#running.get(operation) === work) this.#running.delete(operation) })
    this.#running.set(operation, work)
    return work
  }
  async #advance(operation: string): Promise<MlsKeeperRequestProgress> {
    const scope = this.context()
    if (!scope || !scope.current() || !scope.foreground()) throw new Error('Open the keeper account in the foreground before continuing.')
    const binding = { ...scope.vault }
    const current = () => {
      const next = this.context()
      return !!next && scope.current() && scope.foreground() && next.current() && next.foreground() && JSON.stringify(next.vault) === JSON.stringify(binding)
    }
    const check = () => { if (!current()) throw new Error('The keeper account or foreground session changed.') }
    const execution = async (): Promise<MlsKeeperExecutionPlan> => {
      check()
      const result = await this.decisions.execution(operation)
      check()
      if (result.state !== 'active' || JSON.stringify(result.value.binding) !== JSON.stringify(binding)) throw new Error('The approved scope is awaiting its witness.')
      return result.value
    }
    let plan = await execution()
    const progress: MlsKeeperRequestProgress = { operation, state: plan.prompt.state === 'done' ? 'done' : 'approved', rooms: [], grants: [] }
    const roomContext = (rendezvousKey: string): MlsRoomContext => ({ vault: { ...binding }, rendezvousKey, current })
    // Record each exact Remove intent before attempting proposals. Approval
    // itself already holds Send/Add if a journal cannot yet be written.
    for (const frozen of plan.prompt.approval!.rooms) {
      const intent = plan.rooms.find(room => room.operation === frozen.operation) ?? frozen
      const row: MlsKeeperRequestProgress['rooms'][number] = { session: intent.session, operation: intent.operation, state: intent.action === 'pending-add' ? 'pending' : intent.action === 'ledger-only' ? 'ledger-only' : 'absent' }
      progress.rooms.push(row)
      if (intent.action === 'pending-add') { progress.completion = 'awaiting-pending-add-readback'; continue }
      if (intent.action === 'ledger-only' || progress.state === 'done') continue
      try {
        plan = await execution()
        const context = roomContext(intent.rendezvousKey), statuses = await this.operations.membership(context, intent.session)
        check()
        if (statuses.state !== 'active') throw new Error(`The removal journal is ${statuses.state}.`)
        let status = statuses.value.find(item => item.operation === intent.operation)
        const target = plan.rooms.find(room => room.operation === intent.operation)
        if (!status && target) {
          const begun = await this.operations.removeRequestedDevice(context, intent.session, operation, intent.member.leafId)
          check()
          if (begun.state !== 'active') throw new Error(`The removal intent is ${begun.state}.`)
          status = begun.value
        }
        if (!status) continue
        row.state = 'pending'
        if (status.mls === 'Failed') {
          const retried = await this.operations.retryRemoval(context, intent.session, intent.operation)
          check()
          if (retried.state !== 'active') throw new Error(`The removal retry is ${retried.state}.`)
        }
        const driven = await this.operations.driveRemoval(context, intent.session, intent.operation)
        check()
        if (driven.state !== 'active') throw new Error(`The MLS removal is ${driven.state}.`)
        row.effect = driven.value
        row.state = driven.value.membership.mls === 'Committed' ? 'committed' : 'pending'
        if (driven.value.membership.failure) row.failure = driven.value.membership.failure
      } catch (error) { check(); row.state = 'pending'; row.failure = failure(error) }
    }
    // A failed/stopped room must not delay urgent node-wide withdrawals.
    for (const authority of plan.prompt.approval!.grants) {
      const row: MlsKeeperRequestProgress['grants'][number] = { node: authority.node, reference: authority.reference, state: 'pending' }
      progress.grants.push(row)
      try {
        plan = await execution()
        if (plan.lapsed.includes(authority.reference)) { row.state = 'no-live'; continue }
        if (plan.unavailable.includes(authority.reference)) { row.state = 'unavailable'; row.access = 'unconfirmed'; continue }
        if (!plan.revoked.includes(authority.reference)) await this.grants.withdrawRequestedDevice(authority, plan.prompt.request.sender, plan.prompt.request.device, current)
        check()
        plan = await execution()
        if (!plan.revoked.includes(authority.reference)) throw new Error('The exact grant withdrawal is not confirmed in the keeper ledger.')
        row.state = 'revoked'
        for (const intent of plan.prompt.approval!.rooms.filter(item => (item.action === 'remove' || item.pendingAdd) && item.member.homeBox === authority.node)) {
          const context = roomContext(intent.rendezvousKey), statuses = await this.operations.membership(context, intent.session)
          check()
          if (statuses.state !== 'active') continue
          const status = statuses.value.find(item => item.operation === intent.operation)
          if (!status?.grants.some(item => item.grant.keeper)) continue
          const changed = await this.operations.setRemovalGrants(context, intent.session, intent.operation, [{ grant: authority.reference, state: { type: 'Revoked' } }])
          check()
          if (changed.state !== 'active') throw new Error('The box withdrawal is confirmed; its room journal update is still pending.')
        }
      } catch (error) { check(); row.failure = failure(error) }
    }
    plan = await execution()
    if (progress.grants.every(grant => grant.state !== 'pending') && progress.rooms.every(room => room.state !== 'pending')) {
      if (plan.unresolvedLegacyAddRooms?.length || plan.prompt.approval!.unresolvedLegacyAddRooms?.length) progress.completion = 'awaiting-legacy-add-proof'
      else if (plan.lapsed.length) progress.completion = 'awaiting-grant-install-hold'
      else {
        const done = await this.decisions.complete(operation)
        check()
        if (done.state === 'active') progress.state = 'done'
      }
    }
    return progress
  }
}
