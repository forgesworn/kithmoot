import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { BrowserMlsAccount, type MlsAccountContext } from './mls-persona-account.js'
import { BrowserMlsPanel } from './mls-persona-panel.js'
import { CoordinatedMlsVault } from './mls-coordinated-vault.js'
import type { BrowserPersonaCoordinator, PersonaTransaction } from './mls-persona-coordinator.js'
import { invalidateBrowserMlsOwners } from './mls-lifecycle.js'

// Only presentation affordances are replaced. The account, panel, enrolment
// signer flow and coordinated vault are the production implementations.
vi.mock('./reveal.js', () => ({ addReveal() {} }))
vi.mock('./confirm-action.js', () => ({ confirmAction: async (options: { isCurrent(): boolean }) => options.isCurrent() }))
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
class MemoryTransaction implements PersonaTransaction {
  installation = '66'.repeat(32)
  vault = new Map<string, Uint8Array>()
  async readVault(id: string) { return this.vault.get(id)?.slice() }
  async putVault(id: string, bytes: Uint8Array) { this.vault.set(id, bytes.slice()) }
  async dropVault(id: string) { this.vault.delete(id) }
  async readSession() { return undefined }
  async putSession() {}
  async dropSession() {}
}
/** Minimal event/element surface for the actual panel; no browser or storage
 * polyfill. IDs are taken from its real template, and visibility dispatches
 * through the real listener installed by its constructor. */
class ElementFixture extends EventTarget {
  open = false; hidden = false; disabled = false; checked = false
  value = ''; textContent = ''; className = ''; scrollTop = 0
  dataset: Record<string, string> = {}
  onclick?: () => void
  #id = ''
  constructor(readonly root: DocumentFixture) { super() }
  set id(value: string) { this.#id = value; this.root.elements.set(value, this) }
  get id() { return this.#id }
  set innerHTML(html: string) {
    for (const match of html.matchAll(/<[a-z][\w-]*\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
      const element = new ElementFixture(this.root); element.id = match[1]!
    }
  }
  setAttribute() {}
  append() {}
  replaceChildren() {}
  showModal() { this.open = true }
  close() { this.open = false }
  querySelector(selector: string): ElementFixture | null {
    if (selector.startsWith('#') && !selector.includes(' ')) return this.root.getElementById(selector.slice(1))
    return new ElementFixture(this.root)
  }
  click() { this.onclick?.() }
}
class DocumentFixture extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible'
  elements = new Map<string, ElementFixture>()
  body = new ElementFixture(this)
  createElement() { return new ElementFixture(this) }
  getElementById(id: string) { return this.elements.get(id) ?? null }
  element(id: string) { const element = this.getElementById(id); if (!element) throw new Error(`Missing actual panel template ID: ${id}`); return element }
  hide() { this.visibilityState = 'hidden'; this.dispatchEvent(new Event('visibilitychange')) }
}
async function until(check: () => boolean) {
  for (let turn = 0; turn < 300; turn++) { if (check()) return; await Promise.resolve() }
  throw new Error('Actual panel operation did not reach the expected fixture state')
}
let root: DocumentFixture
beforeEach(() => {
  root = new DocumentFixture()
  vi.stubEnv('DEV', false); vi.stubEnv('VITE_MLS_INVITATION_PROFILE', 'admin2'); vi.stubEnv('VITE_ACCOUNT_NETWORK_DEFAULT', 'private-invitations')
  for (const flag of ['VITE_BROWSER_MLS_PREVIEW', 'VITE_BROWSER_MLS_INVITATION_PREVIEW', 'VITE_BROWSER_MLS_ADMIN_INVITATION_PREVIEW', 'VITE_MIXED_INVITATION_LAB']) vi.stubEnv(flag, '')
  vi.stubGlobal('document', root); vi.stubGlobal('location', { origin: 'https://private-groups.test' }); vi.stubGlobal('BroadcastChannel', undefined)
  vi.stubGlobal('MutationObserver', class { observe() {}; disconnect() {} })
  const entries = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value) } })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
async function fixture(replace = false) {
  // Deterministic synthetic fixture identity; no installed signer or real key.
  const secret = new Uint8Array(32).fill(91), persona = getPublicKey(secret)
  let wait: Promise<void> | undefined, began: (() => void) | undefined
  const identity = { pubkey: persona, signEvent: vi.fn(async (template: Parameters<typeof finalizeEvent>[0]) => {
    began?.(); await wait; return finalizeEvent(template, secret)
  }) }
  let context: MlsAccountContext | undefined = { persona, identity, generation: 'fixture-account', mode: 'normal' }
  const tx = new MemoryTransaction(), genesis = { state: 'genesis', installation: tx.installation, command: 'synthetic keeper enrolment', subject: '77'.repeat(32) }
  const coordinate = async (_persona: string, work: (view: PersonaTransaction) => Promise<unknown>, current: () => boolean) => {
    if (!current()) return { state: 'pending', reason: 'stale', refused: false }
    const value = await work(tx)
    return current() ? { state: 'active', value, marks: new Map() } : { state: 'pending', reason: 'stale', refused: false }
  }
  const coordinator = { transact: vi.fn(coordinate), readConfirmed: vi.fn(coordinate), invalidate: vi.fn() } as unknown as BrowserPersonaCoordinator
  const links = { pause: vi.fn(async () => {}), resume: vi.fn() }
  const enrolment = { status: vi.fn(async (_persona: string, current: () => boolean) => current() ? genesis : { state: 'stale' }) }
  const account = new BrowserMlsAccount(() => context, () => ({ store: {}, links, enrolment, coordinator }) as any)
  if (replace) expect((await account.enrolDevice(Math.floor(Date.now() / 1000) + 86400)).ok).toBe(true)
  const before = [...tx.vault].map(([id, bytes]) => [id, bytes.slice()])
  const scalars: Uint8Array[] = [], random = secp256k1.utils.randomSecretKey
  vi.spyOn(secp256k1.utils, 'randomSecretKey').mockImplementation(() => { const scalar = random(); scalars.push(scalar); return scalar })
  const enrol = vi.spyOn(CoordinatedMlsVault.prototype, 'enrol')
  const panel = new BrowserMlsPanel(() => context, account, root as unknown as Document)
  const hold = () => { const gate = deferred(), entered = deferred(); wait = gate.promise; began = () => entered.resolve(); return { entered: entered.promise, release: () => gate.resolve() } }
  const expectUnchanged = () => expect([...tx.vault]).toEqual(before)
  return { account, panel, tx, identity, links, enrol, scalars, hold, expectUnchanged, signout: () => { context = undefined } }
}

test.each([false, true])('actual production panel hides during %s replacement enrolment: late signer cannot persist or release', async replace => {
  const f = await fixture(replace)
  await f.panel.open()
  root.element('mlsWitnessVaultRead').click()
  const action = replace ? 'mlsWitnessDeviceReplace' : 'mlsWitnessDeviceNew'
  await until(() => !root.element(action).disabled)
  const hold = f.hold(), invalidation = vi.spyOn(f.panel, 'invalidate')
  root.element(action).click(); await hold.entered
  expect(f.enrol).toHaveBeenCalledOnce(); expect(f.scalars).toHaveLength(1); expect(f.scalars[0]!.some(byte => byte !== 0)).toBe(true)
  root.hide()
  expect(invalidation).toHaveBeenCalledOnce(); expect(f.panel.dialog.open).toBe(false)
  expect(root.element('mlsWitnessAccount').textContent).toBe('')
  let stopped = false
  const stopping = invalidation.mock.results[0]!.value.then(() => { stopped = true })
  await Promise.resolve(); expect(stopped).toBe(false); f.expectUnchanged()
  // Returning to foreground cannot revive the cancelled generation.
  root.visibilityState = 'visible'
  hold.release(); await stopping
  const result = await f.enrol.mock.results[0]!.value
  expect(result).toEqual({ ok: false, refusal: 'stale' }); f.expectUnchanged()
  expect(f.scalars[0]!.every(byte => byte === 0)).toBe(true)
  expect(root.element('mlsWitnessDevice').textContent).toBe('')
  expect(root.element('mlsWitnessNetworkStatus').textContent).toBe('')
})

test.each([false, true])('actual account pause joins credential tail and scalar cleanup for replace=%s', async replace => {
  const f = await fixture(replace), hold = f.hold()
  const operation = f.account.enrolDevice(Math.floor(Date.now() / 1000) + 86400, replace)
  await hold.entered
  const pauses = [f.account.pause(), f.account.pause()]
  let stopped = false
  const stopping = Promise.all(pauses).then(() => { stopped = true })
  await Promise.resolve(); expect(stopped).toBe(false); f.expectUnchanged()
  expect(f.scalars[0]!.some(byte => byte !== 0)).toBe(true)
  hold.release()
  expect(await operation).toEqual({ ok: false, refusal: 'stale' })
  await stopping; expect(f.scalars[0]!.every(byte => byte === 0)).toBe(true); f.expectUnchanged()
  expect((await f.account.vaultState()).vault).toMatchObject(replace ? { ok: true, value: { device: expect.any(Object) } } : { ok: true, value: null })
})

test('actual signout invalidation cannot claim quiescence while the witness credential signer remains pending', async () => {
  const f = await fixture(), hold = f.hold()
  const operation = f.account.enrolDevice(Math.floor(Date.now() / 1000) + 86400)
  await hold.entered
  f.signout()
  let signedOut = false
  const stopping = invalidateBrowserMlsOwners([f.panel]).then(() => { signedOut = true })
  await Promise.resolve(); expect(signedOut).toBe(false)
  hold.release(); await stopping
  expect(await operation).toEqual({ ok: false, refusal: 'stale' }); f.expectUnchanged()
  expect(f.scalars[0]!.every(byte => byte === 0)).toBe(true)
})

test('account visibility fence prevents persistence even before a visibility event is dispatched', async () => {
  const f = await fixture(), hold = f.hold()
  const operation = f.account.enrolDevice(Math.floor(Date.now() / 1000) + 86400)
  await hold.entered; root.visibilityState = 'hidden'; hold.release()
  expect(await operation).toEqual({ ok: false, refusal: 'stale' }); f.expectUnchanged()
  expect(f.scalars[0]!.every(byte => byte === 0)).toBe(true)
})
