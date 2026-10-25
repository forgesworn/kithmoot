import { BrowserMlsGrantDevelopmentPanel } from '../app/src/mls-grant-development-panel.js'
import { BrowserMlsGrantDevelopmentOwner } from '../app/src/mls-grant-development-owner.js'
const v = (globalThis as any).permissionVector
const active = (value: any) => ({ state: 'active', value })
const sender = 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
let persona = sender, generation = 'one', unknownNext = false
export const calls: any[] = []
const sign = async () => { throw new Error('UI fixture never uses a real signer') }, authority = { owner: {}, signEvent: sign }
const context = () => ({ persona, generation, mode: 'normal' as const, identity: { pubkey: persona, signEvent: sign }, authority })
let requests = [{ operation: '12'.repeat(32), sender, keeper: v.keeper, device: '44'.repeat(32), sessions: ['55'.repeat(32)], boxes: [v.node],
  createdAt: v.now, sentAt: null, requestRevision: 0, requestState: 'none', publicAttempted: false }]
let permissions: any[] = []
Object.assign(BrowserMlsGrantDevelopmentOwner.prototype, {
  routes: async () => { calls.push(['routes']); return active([{ routeId: 'saved', eventUrl: v.server }, { routeId: 'other', eventUrl: v.server }]) },
  revocationRecords: async () => { calls.push(['outbox']); return active(active(structuredClone(requests))) },
  currentMlsDevice: async () => active({ ok: true, value: { device: v.device } }),
  pause: async () => { calls.push(['pause']) },
  sendRevocationPrivately: async (operation: string, input: any, revision?: number) => {
    calls.push(['private-reserve', operation, input.routeId, input.permission.id, revision ?? null]); requests[0].requestState = 'unconfirmed'; requests[0].requestRevision++
    const decision = await input.consent({ purpose: 'keeper-inbox-deposit-auth', principal: location.origin, persona, device: v.device, box: v.node,
      keeper: v.keeper, grant: '24'.repeat(16), destination: v.server, permissionId: v.active.id, deadline: v.now + 120, current: input.current })
    if (decision !== 'approve' || !input.current()) throw new Error('Private operation withdrawn')
    calls.push(['private-send', operation]); requests[0].requestState = 'sent'; requests[0].sentAt = v.now
    return active(active(structuredClone(requests[0])))
  },
  sendRevocationPublic: async (operation: string, relays: string[], revision?: number) => { calls.push(['public-send', operation, relays, revision ?? null]); requests[0].publicAttempted = true; requests[0].requestState = 'sent'; requests[0].requestRevision++; return active(active(structuredClone(requests[0]))) },
  keeperPermissions: async () => active(active(structuredClone(permissions))),
  prepareKeeperPermission: async (routeId: string, device: string, seconds: number, current: () => boolean) => {
    if (!current()) throw new Error('Prepare withdrawn')
    calls.push(['prepare', persona, routeId, device, seconds])
    const row = { grant: '24'.repeat(16), keeper: persona, device, node: v.node, box: { routeId, eventUrl: v.server }, expiration: 1792994400,
      active: JSON.stringify(v.active), revocation: JSON.stringify(v.revoked), state: 'prepared', revision: 0 }
    permissions = [row]; return active(active(structuredClone(row)))
  },
  publishKeeperPermission: async (grant: string, revision: number, revoke: boolean, current: () => boolean) => {
    const row = permissions[0]
    if (!current() || !row || row.revision !== revision || !revoke && ['revoking','revoked'].includes(row.state)) throw new Error('Terminal or changed permission')
    row.revision++; row.state = revoke ? 'revoking' : 'installing'; calls.push(['publish-permission', grant, revision, revoke, revoke ? row.revocation : row.active])
    if (unknownNext) { unknownNext = false; throw new Error('No node ACK') }
    row.state = revoke ? 'revoked' : 'installed'; return active(active(structuredClone(row)))
  },
  exportKeeperPermission: async (grant: string, revision: number) => { const row = permissions[0]; if (!row || row.state !== 'installed' || row.revision !== revision) throw new Error('Not installed'); calls.push(['export',grant,revision]); return active(active(row.active)) },
})
export const panel = new BrowserMlsGrantDevelopmentPanel(context)
export function open() { panel.open() }
export function changeAccount() { generation = 'changed' }
export function keeperAccount() { persona = v.keeper; generation = 'keeper'; panel.close(); panel.open() }
export function unknownPublish() { unknownNext = true }
export const vector = v
