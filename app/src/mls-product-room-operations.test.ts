import { afterEach, beforeEach, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ room: {} as any, admin: vi.fn(), legacy: vi.fn(), full: vi.fn(), openAdmin: vi.fn(), openLegacy: vi.fn(), openFull: vi.fn() }))
vi.mock('./mls-engine.js', () => ({ loadMlsEngine: async () => ({ Platform: class { free() {} }, Session: {
  prepareCreateAdminInvitationProfile: mocks.admin, prepareCreateInvitationProfile: mocks.legacy, prepareCreate: mocks.full,
  openAdminInvitationSession: mocks.openAdmin, openInvitationSession: mocks.openLegacy, open: mocks.openFull,
} }) }))
vi.mock('./mls-room-store.js', async original => ({ ...await original<typeof import('./mls-room-store.js')>(), readMlsRoom: async () => mocks.room }))
vi.mock('./mls-admin-storage-evidence-gate.js', () => ({ withAdminStorageEvidenceGate: (_p: string, _s: string, work: () => unknown) => work() }))
vi.mock('./mls-invitation-continuity.js', () => ({ invitationRestart: () => 'TrustedLocalRestart', invitationAnchor: () => 'anchor' }))
vi.mock('./mls-session-host.js', async original => {
  const actual = await original<typeof import('./mls-session-host.js')>()
  return { ...actual, BrowserMlsSessionHost: class {
    constructor(_coordinator: unknown, private open: (...args: any[]) => unknown) {}
    invalidate() {}
    async step() { await this.open(new Uint8Array(32), new Uint8Array(), 1n, {}); return { state: 'active', value: null } }
  } }
})
import { BrowserMlsRoomOperations } from './mls-room-operations.js'
const h = '11'.repeat(32)
const context = { vault: { persona: h, principal: 'https://candidate.test', generation: 0 }, rendezvousKey: h, current: () => true } as any
const credential = { device: { device: h, credentialId: h, credentialExpiresAt: 999 }, credential: { pubkey: h, created_at: 1, tags: [], content: '', sig: h + h } }
let operations: BrowserMlsRoomOperations
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('DEV', false); vi.stubEnv('VITE_MLS_INVITATION_PROFILE', 'admin2'); vi.stubEnv('VITE_ACCOUNT_NETWORK_DEFAULT', 'private-invitations')
  for (const flag of ['VITE_BROWSER_MLS_PREVIEW', 'VITE_BROWSER_MLS_INVITATION_PREVIEW', 'VITE_BROWSER_MLS_ADMIN_INVITATION_PREVIEW', 'VITE_MIXED_INVITATION_LAB']) vi.stubEnv(flag, '')
  operations = new BrowserMlsRoomOperations({} as any, { current: () => true, credential: async () => ({ ok: true, value: credential }) } as any, () => 1)
  mocks.admin.mockImplementation(() => { throw new Error('selected Admin2 native preparation') })
})
afterEach(() => vi.unstubAllEnvs())
test('actual creation dispatch forces Admin2 with both caller flags absent', async () => {
  await expect(operations.create(context, { name: 'Candidate', homeBox: h, installation: h, expiresAt: 99 }, async () => 'deny')).rejects.toThrow('selected Admin2')
  expect(mocks.admin).toHaveBeenCalledOnce(); expect(mocks.legacy).not.toHaveBeenCalled(); expect(mocks.full).not.toHaveBeenCalled()
})
test('legacy creation and Full join refuse before native preparation', async () => {
  expect(await operations.create(context, { name: 'Candidate', homeBox: h, installation: h, expiresAt: 99, experimentalInvitation: true }, async () => 'deny')).toEqual({ state: 'refused', reason: 'experimental-disabled' })
  expect(await operations.join(context, {} as any, {} as any, async () => 'deny')).toEqual({ state: 'refused', reason: 'wrong-profile' })
  expect(mocks.admin).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled(); expect(mocks.full).not.toHaveBeenCalled()
})
test.each([{}, { profile: 'FullVmls1' }, { profile: 'Invitation1', invitation: {} }])('actual restore refuses before every native opener: %j', async room => {
  mocks.room = room
  expect(await operations.read(context, h)).toEqual({ state: 'refused', reason: 'experimental-disabled' })
  expect(mocks.openAdmin).not.toHaveBeenCalled(); expect(mocks.openLegacy).not.toHaveBeenCalled(); expect(mocks.openFull).not.toHaveBeenCalled()
})
test('selected restore dispatches only exact Admin2 trusted restart', async () => {
  mocks.room = { profile: 'InvitationAdmins2', invitation: {} }
  await operations.read(context, h)
  expect(mocks.openAdmin).toHaveBeenCalledWith(expect.anything(), expect.any(Uint8Array), expect.any(Uint8Array), 1n, 'TrustedLocalRestart')
  expect(mocks.openLegacy).not.toHaveBeenCalled(); expect(mocks.openFull).not.toHaveBeenCalled()
})
