import type { BrowserMlsAccount } from './mls-persona-account.js'
import type { BrowserMlsRoomDevelopmentOwner } from './mls-room-development-owner.js'
import type { BrowserMlsGrantDevelopmentOwner } from './mls-grant-development-owner.js'
import { base64Encode, base64Decode } from './mls-vault.js'
import { bytesToHex } from '@noble/hashes/utils.js'

// Explicit disposable controller. References come only from the actual app
// panels; there is no constructor/context/service/signer/key injection surface.
const enabled = () => import.meta.env.DEV && import.meta.env.VITE_MIXED_INVITATION_LAB === 'true'
let account: BrowserMlsAccount | undefined, rooms: BrowserMlsRoomDevelopmentOwner | undefined, grants: BrowserMlsGrantDevelopmentOwner | undefined
function need<T>(value: T | undefined): T { if (!enabled() || !value) throw new Error('Open the actual app panel first.'); return value }
function bytes(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length > 1450000) throw new Error('Bounded private bytes required.')
  const decoded = base64Decode(value); if (!decoded) throw new Error('Private base64 invalid.'); return decoded
}
function wire(value: any): any {
  if (value instanceof Uint8Array) return base64Encode(value)
  if (typeof value === 'bigint') return String(value)
  if (Array.isArray(value)) return value.map(wire)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wire(item)]))
  return value
}
export function captureAccountOwner(owner: BrowserMlsAccount) { if (enabled()) { account = owner; install() } }
export function captureRoomOwner(owner: BrowserMlsRoomDevelopmentOwner) { if (enabled()) { rooms = owner; install() } }
export function captureGrantOwner(owner: BrowserMlsGrantDevelopmentOwner) { if (enabled()) { grants = owner; install() } }
function install() {
  if (!enabled()) return
  Object.defineProperty(window, '__mixedInvitationLab', { configurable: true, value: Object.freeze({
    ready: () => ({ account: !!account, rooms: !!rooms, grants: !!grants }),
    async step(step: string, a: Record<string, any> = {}) {
      let result: any
      switch (step) {
        case 'account-state': result = await need(account).state(); break
        case 'prepare': result = await need(account).prepare(); break
        case 'pair-witness': result = await need(account).pair(a.code, a.relays); break
        case 'genesis': result = await need(account).genesis(); break
        case 'check-witness': result = await need(account).check(); break
        case 'device': result = await need(account).vaultState(); break
        case 'pair-room': result = await need(rooms).pair(a.code, a.relays); break
        case 'routes': result = await need(rooms).routes(); break
        case 'provision': result = await need(rooms).provisionBark(a.index); break
        case 'pair-grant': result = await need(grants).pair(a.code, a.relays); break
        case 'grant-routes': result = await need(grants).routes(); break
        case 'authorise-device': result = await need(grants).authoriseEnrolledDevice(a.routeId, a.persona, a.device); break
        case 'create': result = await need(rooms).create(a.routeId, a.name, a.lifetime, true); break
        case 'rooms': result = await need(rooms).roomChoices(); break
        case 'drive': result = await need(rooms).manualRound(a.routeId, a.session); break
        case 'issue': result = await need(rooms).invitation(a.routeId, { type: 'issue', session: a.session, target: a.target }); break
        case 'export': result = await need(rooms).invitation(a.routeId, { type: 'export', session: a.session }); break
        case 'accept': result = await need(rooms).invitation(a.routeId, { type: 'accept', name: a.name, expectedInviterPersona: a.inviter, authorization: bytes(a.authorization) }); break
        case 'response': result = await need(rooms).invitation(a.routeId, { type: 'response', session: a.session }); break
        case 'import-response': result = await need(rooms).invitation(a.routeId, { type: 'record', session: a.session, authorization: bytes(a.authorization), envelope: bytes(a.response) }); break
        case 'registration-request': result = await need(rooms).invitation(a.routeId, { type: 'registration-request', session: a.session, authorization: bytes(a.authorization), envelope: bytes(a.response) }); break
        case 'register': result = await need(rooms).invitation(a.routeId, { type: 'register-package', request: bytes(a.request) }); break
        case 'receipt-add': result = await need(rooms).invitation(a.routeId, { type: 'add', session: a.session, authorization: bytes(a.authorization), envelope: bytes(a.response), receipt: bytes(a.receipt) }); break
        case 'update': result = await need(rooms).invitation(a.routeId, { type: 'update', session: a.session }); break
        case 'remove': result = await need(rooms).invitation(a.routeId, { type: 'remove', session: a.session, leafId: a.leafId }); break
        case 'send': result = await need(rooms).invitation(a.routeId, { type: 'send', session: a.session, text: a.body }); break
        case 'snapshot': {
          result = await need(rooms).invitation(a.routeId, { type: 'read', session: a.session })
          if (result?.state === 'done' && result.value?.state === 'active') {
            const v = result.value.value
            const history = await Promise.all(v.history.map(async (m: any) => ({ id: m.id, direction: m.direction, leaf: m.leaf, epoch: m.epoch,
              sha256: bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', m.body))) })))
            v.history.forEach((m: any) => m.body.fill(0))
            result = { state: 'done', value: { state: 'active', value: { session: v.session, generation: v.generation, phase: v.phase, updateRequired: v.updateRequired,
              members: v.members, history, outboxCount: v.outbox.length, watchCount: v.watch.length } } }
          }
          break
        }
        default: throw new Error('Unknown named mixed lab operation.')
      }
      return wire(result)
    },
  }) })
}
