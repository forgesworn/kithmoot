import { RendezvousVault, BrowserRendezvousVaultStorage, type RendezvousReceipt } from './rendezvous-vault.js'
import { MlsRoomRefused } from './mls-room-store.js'
import { BrowserMlsRoomForeground, type MlsRoomForegroundScope } from './mls-room-foreground.js'
import { withMlsRendezvous, type MlsRendezvousCustody } from './mls-rendezvous-custody.js'
import { publicRendezvousDeviceCurrent, type PublicRendezvousDevice } from './mls-bark-rendezvous.js'
import { getPublicKey } from 'nostr-tools/pure'

/** Raw references from the actual application's retained bunker ceremony.
 * This is internal composition data, never a UI or provision-reply input. */
export interface MlsRoomCreateDevice {
  readonly owner: object
  readonly deviceKey: Uint8Array
  readonly provisionOwner: object
  readonly provision: (index: number, nonce: Uint8Array, expiresAt: number) => Promise<string>
}

/** Application-owned fixed namespace. Construction performs no storage I/O;
 * no caller can inject a vault/storage implementation or a claimed receipt. */
export class BrowserMlsRoomCreateCustody {
  readonly #source = new RendezvousVault(new BrowserRendezvousVaultStorage())
  constructor(private readonly foreground: BrowserMlsRoomForeground,
    private readonly device: () => MlsRoomCreateDevice | undefined,
    private readonly protectedDevice?: () => Promise<PublicRendezvousDevice | undefined>) {
    if (!(foreground instanceof BrowserMlsRoomForeground)) throw new Error('Room creation requires its concrete foreground.')
  }
  async withInvitation<T>(scope: MlsRoomForegroundScope, work: (custody: MlsRoomCreateRendezvous & MlsRendezvousCustody) => Promise<T>): Promise<T> {
    const protectedDevice = await this.protectedDevice?.()
    if (protectedDevice) {
      if (!this.foreground.active(scope) || !publicRendezvousDeviceCurrent(protectedDevice, scope.account)) throw stale()
      const child = await this.#source.active(scope.account, protectedDevice.device)
      if (!child) throw stale()
      const receipt = Object.freeze({ ...child.receipt }); child.wipe()
      const current = () => this.foreground.active(scope) && publicRendezvousDeviceCurrent(protectedDevice, scope.account)
      return withMlsRendezvous(this.#source, receipt, () => Math.floor(Date.now() / 1000), current, async held => {
        try { return await work(Object.freeze({ ...held, receipt })) } finally { await this.foreground.drain(scope) }
      })
    }
    const raw = this.device()
    if (!raw || !raw.owner || typeof raw.owner !== 'object' || !raw.provisionOwner || typeof raw.provisionOwner !== 'object' || typeof raw.provision !== 'function' ||
        !(raw.deviceKey instanceof Uint8Array) || raw.deviceKey.length !== 32 || !this.foreground.active(scope)) throw stale()
    const before = Object.freeze({ ...raw })
    const device = getPublicKey(before.deviceKey)
    const child = await this.#source.active(scope.account, device)
    if (!child) throw stale()
    const receipt = Object.freeze({ ...child.receipt }); child.wipe()
    const current = () => {
      const next = this.device()
      return this.foreground.active(scope) && !!next && next.owner === before.owner && next.provisionOwner === before.provisionOwner &&
        next.provision === before.provision && next.deviceKey === before.deviceKey && getPublicKey(next.deviceKey) === device
    }
    return withMlsRendezvous(this.#source, receipt, () => Math.floor(Date.now() / 1000), current, async held => {
      try { return await work(Object.freeze({ ...held, receipt })) }
      finally { await this.foreground.drain(scope) }
    })
  }
  async withCurrent<T>(scope: MlsRoomForegroundScope, work: (custody: MlsRoomCreateRendezvous) => Promise<T>): Promise<T> {
    const protectedDevice = await this.protectedDevice?.()
    if (protectedDevice) {
      if (!this.foreground.active(scope) || !publicRendezvousDeviceCurrent(protectedDevice, scope.account)) throw stale()
      return withMlsRoomCreateRendezvous(this.#source, this.foreground, scope, protectedDevice.device, () => Math.floor(Date.now() / 1000), held => {
        const current = () => this.foreground.active(scope) && publicRendezvousDeviceCurrent(protectedDevice, scope.account)
        const custody = Object.freeze({ receipt: held.receipt, current: () => current() && held.current(), releaseCurrent: () => current() && held.releaseCurrent() })
        if (!custody.current()) throw stale()
        return work(custody)
      })
    }
    const value = this.device()
    if (!value || !value.owner || typeof value.owner !== 'object' || !value.provisionOwner || typeof value.provisionOwner !== 'object' || typeof value.provision !== 'function' ||
        !(value.deviceKey instanceof Uint8Array) || value.deviceKey.length !== 32) return Promise.reject(stale())
    const before = Object.freeze({ ...value })
    let device: string
    try { device = getPublicKey(before.deviceKey) } catch { return Promise.reject(stale()) }
    const current = () => {
      try {
        const next = this.device()
        return this.foreground.active(scope) && !!next && next.owner === before.owner && next.provisionOwner === before.provisionOwner &&
          next.provision === before.provision && next.deviceKey === before.deviceKey && getPublicKey(next.deviceKey) === device
      } catch { return false }
    }
    return withMlsRoomCreateRendezvous(this.#source, this.foreground, scope, device, () => Math.floor(Date.now() / 1000), async held => {
      const custody = Object.freeze({ receipt: held.receipt, current: () => current() && held.current(),
        releaseCurrent: () => current() && held.releaseCurrent() })
      if (!custody.current()) throw stale()
      return work(custody)
    })
  }
}

/** Public creation binding only. This confers no scalar, ECDH or invitation
 * authority. current() ends with child custody; releaseCurrent() checks the
 * captured storage revision again after subsequent client/endpoint cleanup. */
export interface MlsRoomCreateRendezvous {
  readonly receipt: Readonly<RendezvousReceipt>
  current(): boolean
  releaseCurrent(): boolean
}
const hex = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}(?![\s\S])/.test(value)
const stale = () => new MlsRoomRefused('stale-rendezvous')

/** Reads the actual encrypted child, rather than accepting a caller receipt
 * or copying active(). The application must obtain device from its retained
 * NIP-46 client key or protected app target, not an MLS device or text field. Lock
 * order is child then persona. The concrete foreground joins every registered
 * actual signing/consent tail before unlock, including when lower create
 * cancellation wins. Never invoke this helper from a tracked nested task. */
export async function withMlsRoomCreateRendezvous<T>(source: RendezvousVault,
  foreground: BrowserMlsRoomForeground, scope: MlsRoomForegroundScope, device: string, now: () => number,
  work: (custody: MlsRoomCreateRendezvous) => Promise<T>): Promise<T> {
  if (!(source instanceof RendezvousVault) || !(foreground instanceof BrowserMlsRoomForeground) || !foreground.active(scope) ||
      !hex(scope.account) || !hex(device) || typeof now !== 'function' || typeof work !== 'function') throw stale()
  const account = scope.account
  return source.withCurrentChild(account, device, async (child, sourceCurrent, sourceReleaseCurrent) => {
    if (!child) throw stale()
    const receipt = Object.freeze({ ...child.receipt })
    if (receipt.identity !== account || receipt.device !== device || !hex(receipt.rendezvousPubkey) ||
        !Number.isSafeInteger(receipt.index) || receipt.index < 0 || receipt.index > 0xffffffff ||
        !Number.isSafeInteger(receipt.expiresAt) || receipt.expiresAt < 0) throw stale()
    const live = (revision: () => boolean) => {
      try {
        const time = now()
        return foreground.active(scope) && revision() === true && Number.isSafeInteger(time) && time >= 0
      } catch { return false }
    }
    let alive = true
    const custody: MlsRoomCreateRendezvous = Object.freeze({ receipt,
      current: () => alive && live(sourceCurrent), releaseCurrent: () => live(sourceReleaseCurrent) })
    try {
      if (!custody.current()) throw stale()
      return await work(custody)
    } finally {
      try { await foreground.drain(scope) }
      finally { alive = false }
    }
  })
}
