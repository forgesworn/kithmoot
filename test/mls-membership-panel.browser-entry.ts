import { BrowserMlsMembershipPanel } from '../app/src/mls-membership-panel.js'
import type { MlsRemovalStatus } from '../app/src/mls-room-operations.js'

const person = '11'.repeat(32), device = '22'.repeat(32), leaf = '33'.repeat(32), node = new Uint8Array(32).fill(44), reference = new Uint8Array(32).fill(55)
let removal: MlsRemovalStatus | undefined, calls: string[] = [], failPlan = false
const member = { leafId: leaf, identity: person, device, homeBox: '2c'.repeat(32), bindingExpiresAt: 5000, own: false, pending: false }
const controller = {
  view: async () => ({ members: [member], removals: removal ? [removal] : [] }),
  plan: async (kind: 'device' | 'person', target: string, compromised: boolean) => {
    if (failPlan) throw new Error('membership changed during review')
    return { operation: '66'.repeat(32), kind, target, compromised,
      room: { session: '77'.repeat(32), principal: 'https://test', persona: person, generation: 1, revision: 'one', rendezvousKey: '88'.repeat(32), account: '99'.repeat(32) },
      members: [member], grants: [{ node: '2c'.repeat(32), reference: '37'.repeat(32), device,
        rooms: [{ session: '77'.repeat(32), name: 'Planning room', leaf }, { session: '88'.repeat(32), name: 'Finance room', leaf: '44'.repeat(32) }], action: compromised ? 'revoke' : 'retain' }] }
  },
  begin: async (plan: any) => {
    calls.push(`begin:${plan.kind}:${plan.compromised}`)
    return removal = { operation: '66'.repeat(32), session: '77'.repeat(32), kind: plan.kind, target: plan.target, compromised: plan.compromised, leaves: [leaf],
      createdAt: 1000, attempts: 0, failure: null, mls: 'Pending', credential: 'Unchanged', grants: [{ grant: { node, grant: reference, keeper: true }, state: { type: 'Pending' } }],
      claim: 'ComponentsOnly', claimCopy: 'Only the component states below are known.', next: { type: 'Propose', leafIds: [new Uint8Array(32).fill(33)] } }
  },
  advance: async (operation: string) => {
    calls.push(`advance:${operation}`)
    removal = { ...removal!, mls: 'Committed', grants: [{ ...removal!.grants[0], state: { type: 'Revoked' } }], claim: 'BothComplete', claimCopy: 'Removed from future room epochs and its listed box grants are revoked.', next: { type: 'Done' } }
    return removal
  },
}
export async function init() {
  document.body.innerHTML = '<main id="membership"></main>'
  calls = []; removal = undefined; failPlan = false
  const panel = new BrowserMlsMembershipPanel(controller as any, document.getElementById('membership')!, { person: () => 'Ada', device: () => 'Tablet' })
  await panel.open()
}
export function history() { return calls }
export function rejectPlans() { failPlan = true }
