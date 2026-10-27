import { afterEach, beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({ identity: undefined as any, stop: vi.fn(async () => {}), linksPause: vi.fn(async () => {}), roomsInvalidate: vi.fn(), vaultBump: vi.fn(), coordinatorInvalidate: vi.fn(), cancelConsent: vi.fn() }))
vi.mock('./mls-room-endpoint.js', () => ({ BrowserMlsRoomEndpoint: class {
  constructor(_foreground: unknown, identity: () => unknown) { state.identity = identity }
  stop = state.stop
  async pairedBoxes() { return state.identity().signEvent({ kind: 1, created_at: 1, tags: [], content: '' }) }
} }))
vi.mock('./mls-persona-store.js', () => ({ BrowserMlsPersonaStore: class {} }))
vi.mock('./mls-persona-link.js', () => ({ BrowserPersonaLinks: class { channels = {}; resume() {}; pause = state.linksPause } }))
vi.mock('./mls-persona-coordinator.js', async original => ({ ...await original<typeof import('./mls-persona-coordinator.js')>(), BrowserPersonaCoordinator: class { invalidate = state.coordinatorInvalidate } }))
vi.mock('./mls-room-coordinated-vault.js', () => ({ RoomCoordinatedMlsVault: class { bump = state.vaultBump } }))
vi.mock('./mls-room-operations.js', () => ({ BrowserMlsRoomOperations: class { invalidate = state.roomsInvalidate } }))
vi.mock('./mls-room-create-rendezvous.js', () => ({ BrowserMlsRoomCreateCustody: class {} }))
vi.mock('./mls-bark-rendezvous.js', () => ({ BrowserBarkRendezvous: class {} }))
vi.mock('./mls-room-consent.js', () => ({ BrowserMlsRoomConsent: class { cancel = state.cancelConsent } }))
import { BrowserMlsRoomDevelopmentOwner } from './mls-room-development-owner.js'
import { invalidateBrowserMlsOwners } from './mls-lifecycle.js'
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('DEV', false); vi.stubEnv('VITE_MLS_INVITATION_PROFILE', 'admin2'); vi.stubEnv('VITE_ACCOUNT_NETWORK_DEFAULT', 'private-invitations'); vi.stubGlobal('document', { visibilityState: 'visible' }) })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
test.each(['account change', 'lock', 'signout'])('production actual protected owner invalidation drains late signer on %s', async () => {
  const persona = '11'.repeat(32)
  let answer!: (value: any) => void, started!: () => void
  const signing = new Promise(resolve => { answer = resolve }), entered = new Promise<void>(resolve => { started = resolve })
  const signer = { signEvent: vi.fn(() => { started(); return signing }) }
  let account: any = { persona, identity: { pubkey: persona }, authority: { owner: signer, signEvent: signer.signEvent }, generation: '1', mode: 'normal' }
  const owner = new BrowserMlsRoomDevelopmentOwner(() => account, document)
  const operation = owner.routes()
  await entered
  account = undefined
  const witness = { invalidate: vi.fn(async () => {}) }, grants = { invalidate: vi.fn(async () => {}) }
  let settled = false
  const stopping = invalidateBrowserMlsOwners([grants, witness, { invalidate: () => owner.pause() }]).then(() => { settled = true })
  expect(state.roomsInvalidate).toHaveBeenCalledOnce(); expect(state.vaultBump).toHaveBeenCalledOnce(); expect(state.coordinatorInvalidate).toHaveBeenCalledOnce()
  expect(state.cancelConsent).toHaveBeenCalled(); expect(witness.invalidate).toHaveBeenCalledOnce(); expect(grants.invalidate).toHaveBeenCalledOnce()
  await Promise.resolve(); expect(settled).toBe(false)
  const late = new Uint8Array([1, 2, 3]); answer(late)
  expect(await operation).toEqual({ state: 'interrupted' })
  await stopping
  expect(late).toEqual(new Uint8Array(3)); expect(state.stop).toHaveBeenCalled(); expect(state.linksPause).toHaveBeenCalled()
})
test('one failed owner cannot leave later owners or pending cleanup untouched', async () => {
  let finish!: () => void
  const tail = new Promise<void>(resolve => { finish = resolve })
  const next = vi.fn(() => tail), last = vi.fn()
  const stopping = invalidateBrowserMlsOwners([{ invalidate: () => { throw new Error('owner cleanup failed') } }, { invalidate: next }, { invalidate: last }])
  expect(next).toHaveBeenCalledOnce(); expect(last).toHaveBeenCalledOnce()
  finish(); await expect(stopping).rejects.toThrow('owner cleanup failed')
})
