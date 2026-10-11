import { readMlsMembership } from './mls-membership-store.js'
import { InvalidPersonaRecord, type BrowserPersonaCoordinator } from './mls-persona-coordinator.js'
import type { MlsRevocationInboxContext } from './mls-revocation-inbox.js'

const hex32 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

/** Fresh witnessed admission only. Approved and terminal requests retain the
 * device hold; request expiry and deferral never retire it. This does not
 * validate a prospective MLS Add or replace an old-client barrier. */
export class BrowserMlsKeeperAdmission {
  constructor(private coordinator: Pick<BrowserPersonaCoordinator, 'transact'>,
    private context: () => MlsRevocationInboxContext | undefined) {}

  async admit(keeper: string, sender: string, device: string, current: () => boolean): Promise<() => boolean> {
    const initial = this.context()
    if (![keeper, sender, device].every(hex32) || !initial || initial.vault.persona !== keeper || !initial.current() || !initial.foreground() || !current()) {
      throw new Error('Open this keeper account in the foreground before installing a grant.')
    }
    const scope = { ...initial, vault: { ...initial.vault } }
    const live = () => {
      const next = this.context()
      return !!next && current() && scope.current() && scope.foreground() && next.current() && next.foreground() &&
        JSON.stringify(next.vault) === JSON.stringify(scope.vault)
    }
    const checked = await this.coordinator.transact(keeper, async tx => {
      const journal = await readMlsMembership(tx)
      if (journal.inbox && journal.inbox.keeper !== keeper) throw new InvalidPersonaRecord('Keeper admission belongs to another persona')
      const hold = journal.inbox?.prompts.find(prompt => ['approved', 'done'].includes(prompt.state) && prompt.request.device === device)
      if (hold) {
        if (hold.request.sender !== sender) throw new Error('This device has a retained keeper hold for another person.')
        throw new Error('This device has a retained keeper revocation hold. Recover with a new device key.')
      }
    }, live)
    if (checked.state !== 'active' || !live()) throw new Error('A fresh witnessed keeper admission check is required.')
    return live
  }
}
