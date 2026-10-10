import { BrowserMlsMembershipPanel } from '../app/src/mls-membership-panel.js'
import type { MlsRemovalStatus } from '../app/src/mls-room-operations.js'

const person = '11'.repeat(32), device = '22'.repeat(32), leaf = '33'.repeat(32), node = new Uint8Array(32).fill(44), reference = new Uint8Array(32).fill(55)
let removal: MlsRemovalStatus | undefined, calls: string[] = [], failPlan = false
let failRequest = false, identityAvailable = true
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
  requestRevocation: async (operation: string, options: any) => {
    calls.push(`request:${operation}`)
    if (options.identity !== identity || options.transport !== transport) throw new Error('wrong sender dependencies')
    if (failRequest) throw new Error('keeper relay refused the request')
    removal = { ...removal!, grants: removal!.grants.map(grant => ({ ...grant, state: { type: 'NotAuthorised', requested: true } })) }
    return removal
  },
}
const identity = { pubkey: person }, transport = {}
let panel: BrowserMlsMembershipPanel
export async function init() {
  document.body.innerHTML = '<main id="membership"></main>'
  calls = []; removal = undefined; failPlan = false; failRequest = false; identityAvailable = true
  panel = new BrowserMlsMembershipPanel(controller as any, document.getElementById('membership')!, { person: () => 'Ada', device: () => 'Tablet' },
    { identity: () => identityAvailable ? identity as any : undefined, transport: transport as any })
  await panel.open()
}
export function history() { return calls }
export function rejectPlans() { failPlan = true }
export async function seedRequest(requested = false, committed = true) {
  removal = { operation: 'aa'.repeat(32), session: '77'.repeat(32), kind: 'device', target: leaf, compromised: true, createdAt: 1000,
    attempts: 0, failure: null, leaves: [leaf], mls: committed ? 'Committed' : 'Pending', credential: 'Unchanged',
    grants: [{ grant: { node, grant: reference, keeper: false }, state: { type: 'NotAuthorised', requested } }],
    claim: 'ComponentsOnly', claimCopy: 'Revocation requested from a keeper; not performed.', next: { type: 'Done' },
    request: { keeper: '99'.repeat(32), device, sessions: ['77'.repeat(32)], boxes: ['2c'.repeat(32)] } }
  await panel.open()
}
export function rejectRequest() { failRequest = true }
export function signOut() { identityAvailable = false }
