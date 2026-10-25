import { confirmAction } from './confirm-action.js'
import type { StorageGrantReview } from './mls-storage-grants.js'
import { startBoxLabTrace, readBoxLabTrace } from './mls-box-lab-trace.js'
import type { BrowserMlsAccount } from './mls-persona-account.js'
import type { BrowserMlsRoomDevelopmentOwner } from './mls-room-development-owner.js'
import type { BrowserMlsGrantDevelopmentOwner } from './mls-grant-development-owner.js'
import { base64Encode, base64Decode } from './mls-vault.js'
import { bytesToHex } from '@noble/hashes/utils.js'

// Explicit disposable controller. References come only from the actual app
// panels; there is no constructor/context/service/signer/key injection surface.
const enabled = () => import.meta.env.DEV && import.meta.env.VITE_MIXED_INVITATION_LAB === 'true'
type LabProfile = 'Invitation1' | 'InvitationAdmins2'
function labProfile(): LabProfile {
  const legacy = import.meta.env.VITE_BROWSER_MLS_INVITATION_PREVIEW === 'true'
  const admin = import.meta.env.VITE_BROWSER_MLS_ADMIN_INVITATION_PREVIEW === 'true'
  if (import.meta.env.VITE_BROWSER_MLS_PREVIEW !== 'true' || legacy === admin) throw new Error('Choose exactly one explicit invitation lab profile with the outer MLS preview.')
  return admin ? 'InvitationAdmins2' : 'Invitation1'
}
const reviewedRoles = new Map<string, string>()
const reviewedStorage = new Map<string, StorageGrantReview>()
let account: BrowserMlsAccount | undefined, rooms: BrowserMlsRoomDevelopmentOwner | undefined, grants: BrowserMlsGrantDevelopmentOwner | undefined
type OrdinaryPublicContext = Readonly<{ sessionAssigned: boolean; roomId: string | null; participant: string | null; device: string | null;
  arrivalRoomId: string | null; accountPubkey: string | null; accountMethod: string | null; signerMethod: string | null;
  canSignEvents: boolean; roomGeneration: number; identityGeneration: number; joining: boolean;
  sessionMatchesArrivalRoom: boolean; accountMatchesParticipant: boolean }>
let ordinaryPublicContext: (() => OrdinaryPublicContext) | undefined
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
export function captureOrdinaryPublicContext(read: () => OrdinaryPublicContext) { if (enabled()) { ordinaryPublicContext = read; install() } }
function install() {
  if (!enabled()) return
  Object.defineProperty(window, '__mixedInvitationLab', { configurable: true, value: Object.freeze({
    profile: () => labProfile(),
    ready: () => ({ account: !!account, rooms: !!rooms, grants: !!grants, ordinary: !!ordinaryPublicContext }),
    async step(step: string, a: Record<string, any> = {}) {
      let result: any
      // Every invitation operation selects one explicit engine; the ordinary
      // public-room observation branch remains independently available.
      if (['create', 'drive', 'issue', 'export', 'accept', 'response', 'import-response', 'registration-request', 'register', 'receipt-add', 'update', 'remove', 'send', 'role', 'roles', 'snapshot', 'protected-snapshot'].includes(step)) labProfile()
      switch (step) {
        case 'ordinary-public-context': if (!ordinaryPublicContext) throw new Error('Actual ordinary context unavailable.'); result = ordinaryPublicContext(); break
        case 'account-state': result = await need(account).state(); break
        case 'prepare': result = await need(account).prepare(); break
        case 'pair-witness': result = await need(account).pair(a.code, a.relays); break
        case 'genesis': result = await need(account).genesis(); break
        case 'check-witness': result = await need(account).check(); break
        case 'device': result = await need(account).vaultState(); break
        case 'pair-room': result = await need(rooms).pair(a.code, a.relays); break
        case 'box-trace-start': result = startBoxLabTrace(); break
        case 'box-trace-read': result = readBoxLabTrace(); break
        case 'node-health': labProfile(); result = await need(rooms).nodeHealth(a.routeId, a.session); break
        case 'room-device-readiness': labProfile(); result = await need(rooms).deviceReadiness(); break
        case 'routes': result = await need(rooms).routes(); break
        case 'provision': result = await need(rooms).provisionBark(a.index); break
        case 'pair-grant': result = await need(grants).pair(a.code, a.relays); break
        case 'grant-routes': result = await need(grants).routes(); break
        case 'storage-records': result = await need(grants).storageRecords(); break
        case 'storage-publish': result = await need(grants).publishStorageGrant(a.grant, a.revision, a.revoke, () => true); break
        case 'storage-binding': result = await need(grants).adminStorageBinding(a.operation); break
        case 'storage-request': result = await need(grants).prepareAdminStorageRequest({ session: a.session, rendezvousKey: a.rendezvousKey }, { routeId: a.routeId, leaf: a.leafId, expectedStorageKeeper: a.expectedStorageKeeper, permission: a.permission, ...(a.rebind ? { rebind: a.rebind } : {}) }); break
        case 'storage-outbox': result = await need(grants).revocationRecords(); break
        case 'storage-private-send': result = await need(grants).sendRevocationPrivately(a.operation, { routeId: a.routeId, permission: a.permission, current: () => true,
          consent: async scope => await confirmAction({ title: 'Send this storage request privately?', message: `Identify transmitting device ${scope.device} to keeper ${scope.keeper} at node ${scope.box}. This requests storage withdrawal only; MLS membership remains unchanged.`, confirmLabel: 'Identify and send privately', isCurrent: scope.current }) ? 'approve' : 'deny' }, a.revision); break
        case 'storage-private-check': result = await need(grants).storageKeeperCheckPrivate({ routeId: a.routeId, authenticate: a.authenticate === true, current: () => true }); break
        case 'storage-inbox': result = await need(grants).storageKeeperView(); break
        case 'storage-review':
          reviewedStorage.delete(a.operation)
          result = await need(grants).storageKeeperReview(a.operation)
          if (result?.state === 'active' && result.value?.state === 'active') reviewedStorage.set(a.operation, structuredClone(result.value.value))
          break
        case 'storage-approve': {
          const review = reviewedStorage.get(a.operation)
          if (!review) throw new Error('Review the exact current storage request first.')
          if (!await confirmAction({ title: 'Approve storage withdrawal only?', message: `Person ${review.request.sender}; device ${review.request.device}; ${review.records.length} exact retained storage grant(s). MLS membership remains unchanged.`, confirmLabel: 'Approve storage only' })) throw new Error('Storage approval denied.')
          result = await need(grants).storageKeeperApprove(review, () => true); reviewedStorage.delete(a.operation); break
        }
        case 'storage-advance': result = await need(grants).storageKeeperAdvance(a.operation, () => true); break
        case 'authorise-device': result = await need(grants).authoriseEnrolledDevice(a.routeId, a.persona, a.device); break
        case 'create': {
          const admin = labProfile() === 'InvitationAdmins2'
          result = await need(rooms).create(a.routeId, a.name, a.lifetime, !admin, admin); break
        }
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
        case 'role': {
          if (labProfile() !== 'InvitationAdmins2' || typeof a.session !== 'string' || !/^[0-9a-f]{64}$/.test(a.session) ||
              typeof a.leafId !== 'string' || !/^[0-9a-f]{64}$/.test(a.leafId) || typeof a.makeAdmin !== 'boolean' ||
              typeof a.expectedCommitment !== 'string' || !/^[0-9a-f]{64}$/.test(a.expectedCommitment) ||
              reviewedRoles.get(a.session) !== a.expectedCommitment) throw new Error('Review the exact current Admin2 role view and select one device leaf and policy commitment.')
          result = await need(rooms).invitation(a.routeId, { type: 'role', session: a.session, leafId: a.leafId, makeAdmin: a.makeAdmin, expectedCommitment: a.expectedCommitment })
          reviewedRoles.delete(a.session)
          break
        }
        case 'remove': result = await need(rooms).invitation(a.routeId, { type: 'remove', session: a.session, leafId: a.leafId }); break
        case 'send': result = await need(rooms).invitation(a.routeId, { type: 'send', session: a.session, text: a.body }); break
        case 'roles':
        case 'protected-snapshot':
        case 'snapshot': {
          reviewedRoles.delete(a.session)
          result = step === 'protected-snapshot' ? await need(rooms).protectedSnapshot(a.session) : await need(rooms).invitation(a.routeId, { type: 'read', session: a.session })
          if (result?.state === 'done' && result.value?.state === 'active') {
            const v = result.value.value
            if (v.profile !== labProfile()) throw new Error('Saved room differs from the selected invitation lab profile.')
            reviewedRoles.delete(a.session)
            if (v.adminRoles) reviewedRoles.set(a.session, v.adminRoles.adminSetCommitment)
            const history = await Promise.all(v.history.map(async (m: any) => ({ id: m.id, direction: m.direction, leaf: m.leaf, epoch: m.epoch,
              sha256: bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', m.body))) })))
            v.history.forEach((m: any) => m.body.fill(0))
            result = { state: 'done', value: { state: 'active', value: { session: v.session, generation: v.generation, phase: v.phase, updateRequired: v.updateRequired,
              profile: v.profile, ...(v.adminRoles ? { adminRoles: v.adminRoles } : {}), members: v.members, ...(step !== 'roles' ? { history } : {}), outboxCount: v.outbox.length, watchCount: v.watch.length } } }
          }
          break
        }
        default: throw new Error('Unknown named mixed lab operation.')
      }
      return wire(result)
    },
  }) })
}
