import { HEADLESS_PROVIDER_EFFECT_BOUNDARY, HEADLESS_NIP07_DISCOVERY_BOUNDARY, type SignetSession } from 'signet-login'
import { bytesToHex } from '@noble/hashes/utils'
import { roomInvitation, deriveInvitationId, type RoomInvitation } from '../../src/invitation.js'
import { parseRoomLink } from '../../src/link.js'
import { MAX_ORDINARY_TAB_OWNERS, OrdinaryStateOwner } from './ordinary-state-owner.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { OrdinaryProtocolWork } from './ordinary-protocol-work.js'
import { registerOrdinaryColdExtensionFactory } from './ordinary-cold-extension-factory.js'
import { registerOrdinaryPreparedExtensionFactory } from './ordinary-prepared-extension-factory.js'
import { OrdinaryMemberStartup } from './ordinary-member-startup.js'
import type { OrdinaryMemberSessionOptions, OrdinaryOwnedMemberSession } from './ordinary-persistent-bootstrap.js'

export interface OrdinaryExtensionMemberSelection {
  readonly account: string
  readonly participant: string
  readonly invitationId: string
  readonly link: string
  readonly keep: boolean
  readonly credentialExpiresAt: number
}
export interface OrdinaryMemberExtensionStartupOptions {
  readonly browser: OrdinaryStateOwner
  readonly tab: OrdinaryStateOwner
  readonly invitation: RoomInvitation
  readonly account: string
  readonly link: string
  readonly keep: boolean
  readonly credentialExpiresAt: number
  readonly current: () => OrdinaryExtensionMemberSelection | undefined
  readonly live: () => boolean
  readonly generation: number
  readonly currentGeneration: () => number
  readonly checkClients: () => Promise<void>
  readonly stop: () => void
}
const INPUT = ['browser', 'tab', 'invitation', 'account', 'link', 'keep', 'credentialExpiresAt', 'current', 'live', 'generation', 'currentGeneration', 'checkClients', 'stop'] as const
const SELECTION = ['account', 'participant', 'invitationId', 'link', 'keep', 'credentialExpiresAt'] as const
// One controller per native tab in this application realm. Keep the reservation
// through close/join so an unabortable discovery cannot be started twice.
const activeTabs = new Set<string>()
function hold(): never { throw new OrdinaryStateHold() }
function data(input: unknown, names: readonly string[]): Record<string, unknown> {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== names.length) hold()
  const result: Record<string, unknown> = {}
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) hold()
    result[name] = descriptor.value
  }
  return result
}

/** Restores one account's actual NIP-07 SDK after neutral recovery under P
 * or E, then hands it privately to the fresh guarded member factory. No SDK session or raw signer
 * escapes; the original SDK is closed after all borrowed member work joins. */
export class OrdinaryMemberExtensionStartup {
  readonly #input: OrdinaryMemberExtensionStartupOptions
  readonly #captured: Record<string, unknown>
  readonly #options: OrdinaryMemberExtensionStartupOptions
  readonly #selected: OrdinaryExtensionMemberSelection
  readonly #selectionPointer: OrdinaryExtensionMemberSelection
  #provider: NonNullable<Window['nostr']> | undefined
  #providerFields: readonly unknown[] | undefined
  readonly #work = new Set<Promise<unknown>>()
  #root: ReturnType<typeof OrdinaryProtocolWork.registerPreparedStartup> | undefined
  #source: Readonly<SignetSession> | undefined
  #member: OrdinaryMemberStartup | undefined
  #memberCalled = false
  #expiry: ReturnType<typeof setTimeout> | undefined
  #deadline: number | undefined
  #held = false
  #closed = false
  #closing: Promise<void> | undefined
  private constructor(input: OrdinaryMemberExtensionStartupOptions, captured: Record<string, unknown>) {
    this.#input = input; this.#captured = Object.freeze(captured)
    const raw = this.#captured as unknown as OrdinaryMemberExtensionStartupOptions
    if (!/^[0-9a-f]{64}$/.test(raw.account) || typeof raw.link !== 'string' || typeof raw.keep !== 'boolean' ||
        !Number.isSafeInteger(raw.credentialExpiresAt) || raw.credentialExpiresAt <= 0 || !Number.isSafeInteger(raw.generation) || raw.generation < 0 ||
        [raw.current, raw.live, raw.currentGeneration, raw.checkClients, raw.stop].some(fn => typeof fn !== 'function') || HEADLESS_PROVIDER_EFFECT_BOUNDARY !== 1 || HEADLESS_NIP07_DISCOVERY_BOUNDARY !== 1) hold()
    const invitationFields = data(raw.invitation, ['bearer', 'inviter', 'persistent'])
    if (!(invitationFields.bearer instanceof Uint8Array) || invitationFields.bearer.length !== 32 ||
        typeof invitationFields.inviter !== 'string' || invitationFields.persistent !== true) hold()
    const invitation = roomInvitation(new Uint8Array(invitationFields.bearer), invitationFields.inviter, true)
    this.#options = { ...raw, invitation }
    try {
      const linked = parseRoomLink(raw.link)
      try {
        if (linked.secret || linked.pairingCode || !linked.invitation?.persistent ||
            linked.invitation.inviter !== invitation.inviter || bytesToHex(linked.invitation.bearer) !== bytesToHex(invitation.bearer)) hold()
      } finally { linked.secret?.fill(0); linked.invitation?.bearer.fill(0); linked.pairingCode?.fill(0) }
      const selected = raw.current()
      const captured = data(selected, SELECTION) as unknown as OrdinaryExtensionMemberSelection
      if (captured.account !== raw.account || captured.participant !== raw.account || captured.invitationId !== deriveInvitationId(invitation) ||
          captured.link !== raw.link || captured.keep !== raw.keep || captured.credentialExpiresAt !== raw.credentialExpiresAt) hold()
      this.#selectionPointer = selected!; this.#selected = Object.freeze(captured)
    } catch (error) { invitation.bearer.fill(0); throw error }
  }
  #providerValues(): unknown[] {
    const p = this.#provider
    if (!p) hold()
    const read = <T>(body: () => T): T => { const value = body(); this.#nativeCheck(); return value }
    const n04 = read(() => p.nip04), n44 = read(() => p.nip44)
    return [read(() => p.getPublicKey), read(() => p.signEvent), n04, n44, read(() => n04?.encrypt),
      read(() => n04?.decrypt), read(() => n44?.encrypt), read(() => n44?.decrypt)]
  }
  #inputUnchanged(): boolean {
    const current = data(this.#input, INPUT)
    return INPUT.every(name => current[name] === this.#captured[name])
  }
  #currentSelection(): OrdinaryExtensionMemberSelection {
    const source = this.#options.current(), selected = data(source, SELECTION)
    if (source !== this.#selectionPointer || !SELECTION.every(name => selected[name] === this.#selected[name]) || this.#held || this.#closed) hold()
    return selected as unknown as OrdinaryExtensionMemberSelection
  }
  #nativeLive = (): boolean => {
    if (this.#held || this.#closed) return false
    try {
      if (!this.#inputUnchanged()) return false
      const live = this.#options.live() === true && this.#options.currentGeneration() === this.#options.generation
      if (!live || !this.#inputUnchanged()) return false
      const now = Date.now()
      if (!Number.isSafeInteger(now) || now < 0 || now >= this.#options.tab.expiresAt || this.#deadline !== undefined && now >= this.#deadline) return false
      // Every preceding external callback/getter may have changed selection.
      // Strictly recapture last; no caller callback follows this decision.
      this.#currentSelection()
      return !this.#held && !this.#closed
    } catch { return false }
  }
  #nativeCheck(): void { if (!this.#nativeLive()) hold() }
  #live = (): boolean => {
    if (!this.#nativeLive() || !this.#provider || !this.#providerFields) return false
    try {
      if (window.nostr !== this.#provider || !this.#providerValues().every((value, index) => value === this.#providerFields![index])) return false
      this.#currentSelection()
      return !this.#held && !this.#closed
    } catch { return false }
  }
  #check(): void { if (!this.#live()) hold() }
  #scheduleExpiry(): void {
    if (this.#expiry !== undefined) clearTimeout(this.#expiry)
    const until = this.#deadline ?? this.#options.tab.expiresAt
    const expire = () => {
      if (this.#held || this.#closed) return
      if (Date.now() >= until) this.#stop()
      else this.#expiry = setTimeout(expire, Math.min(2_147_483_647, Math.max(1, until - Date.now())))
    }
    this.#expiry = setTimeout(expire, Math.min(2_147_483_647, Math.max(1, until - Date.now())))
  }
  #stop(): void {
    if (this.#held) return
    this.#held = true; this.#root?.close(); this.#member?.revoke()
    this.#options.browser.retryRetention(); this.#options.tab.retryRetention()
    queueMicrotask(() => { void this.close().catch(() => {}) })
    try { this.#options.stop() } catch { /* held already */ }
  }
  #track<T>(body: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(body)
    OrdinaryStateOwner.joinPairLifetime(this.#options.browser, this.#options.tab, pending, () => this.#stop())
    this.#work.add(pending); void pending.finally(() => this.#work.delete(pending)).catch(() => {})
    return pending
  }
  static async open(input: OrdinaryMemberExtensionStartupOptions): Promise<OrdinaryMemberExtensionStartup> {
    const captured = data(input, INPUT), tab = captured.tab as OrdinaryStateOwner, browser = captured.browser as OrdinaryStateOwner
    if (!(browser instanceof OrdinaryStateOwner) || !(tab instanceof OrdinaryStateOwner) || browser.purpose !== 'browser' ||
        !/^tab:[0-9a-f]{64}$/.test(tab.purpose) || activeTabs.has(tab.purpose)) hold()
    activeTabs.add(tab.purpose)
    let state: OrdinaryMemberExtensionStartup | undefined
    try {
      state = new OrdinaryMemberExtensionStartup(input, captured)
      await state.#track(() => state!.#open()); state.#check(); return state
    } catch (error) {
      if (state) { state.#stop(); await state.close() } else activeTabs.delete(tab.purpose)
      throw error
    }
  }
  async #open(): Promise<void> {
    this.#nativeCheck(); const o = this.#options; this.#scheduleExpiry()
    let disposition = await o.browser.inspectRenewalStartup(this.#nativeLive)
    for (let transitions = 0; ; transitions++) {
      this.#nativeCheck()
      if (disposition.status === 'empty' || disposition.operations.some(operation => operation.phase === 'provider-started' ||
          operation.phase === 'prepared' && operation.tab !== o.tab.purpose)) hold()
      const operation = disposition.operations.find(operation => operation.phase !== 'prepared' && operation.phase !== 'settled')
      if (!operation) break
      if (transitions >= 3 * MAX_ORDINARY_TAB_OWNERS) hold()
      if (operation.phase === 'provider-returned' || operation.phase === 'candidate-prepared') {
        await o.browser.recoverRetainedRenewalAtStartup(operation.tab, this.#nativeLive)
      } else if (operation.phase === 'candidate-committed') {
        await o.browser.recoverCommittedRenewalAtStartup(operation.tab, this.#nativeLive)
      } else hold()
      this.#nativeCheck()
      const next = await o.browser.inspectRenewalStartup(this.#nativeLive)
      this.#nativeCheck()
      if (JSON.stringify(next) === JSON.stringify(disposition)) hold()
      disposition = next
    }
    const prepared = disposition.operations.some(operation => operation.phase === 'prepared')
    if (!prepared && disposition.status !== 'ordinary') hold()
    // Provider accessors are untrusted. None run during classification or
    // neutral C/S recovery, and selection is repeated after every access.
    this.#nativeCheck(); const provider = window.nostr; this.#nativeCheck()
    if (!provider) hold()
    this.#provider = provider; this.#providerFields = Object.freeze(this.#providerValues()); this.#check()
    this.#root = OrdinaryProtocolWork.registerPreparedStartup(this, async root => {
      const binding = { browser: o.browser, tab: o.tab,
        account: o.account, invitationId: this.#selected.invitationId, link: o.link, keep: o.keep,
        bootstrapCredentialExpiresAt: o.credentialExpiresAt, live: this.#live, checkClients: o.checkClients }
      this.#source = prepared
        ? await OrdinaryStateOwner.restorePreparedExtensionAtStartup(registerOrdinaryPreparedExtensionFactory(this, binding), root)
        : await OrdinaryStateOwner.restoreOrdinaryExtensionAtStartup(registerOrdinaryColdExtensionFactory(this, binding), root)
      this.#deadline = Math.min(o.tab.expiresAt, this.#source.expiresAt ?? o.tab.expiresAt)
      this.#scheduleExpiry()
      this.#check()
    })
    await this.#root.start(); this.#root.close(); await this.#root.join(); this.#check()
    const source = this.#source!, identity = source.signer
    this.#member = await OrdinaryMemberStartup.open({ browser: o.browser, tab: o.tab, invitation: o.invitation,
      account: o.account, identity, link: o.link, keep: o.keep, credentialExpiresAt: o.credentialExpiresAt, live: this.#live,
      current: () => {
        if (!this.#live()) return undefined
        const selected = this.#currentSelection()
        return { ...selected, identity }
      }, foreground: { session: source, currentSession: () => this.#source, generation: o.generation,
        currentGeneration: o.currentGeneration, checkClients: o.checkClients, stop: () => this.#stop() } })
    this.#check()
  }
  openMemberSession(input: OrdinaryMemberSessionOptions): Promise<OrdinaryOwnedMemberSession> {
    if (this.#memberCalled || !this.#member) return Promise.reject(new OrdinaryStateHold())
    this.#memberCalled = true
    return this.#track(async () => {
      this.#check()
      try { const member = await this.#member!.openMemberSession(input); this.#check(); return member }
      catch (error) { this.#stop(); throw error }
    })
  }
  revoke(): void { this.#stop() }
  close(): Promise<void> {
    if (this.#closing) return this.#closing
    this.#closed = true; this.#stop()
    if (this.#expiry !== undefined) clearTimeout(this.#expiry)
    this.#closing = (async () => {
      while (this.#work.size) await Promise.allSettled([...this.#work])
      await this.#root?.join(); await this.#member?.close(); await this.#source?.signer.close()
      this.#source = undefined; this.#member = undefined; this.#options.invitation.bearer.fill(0)
      activeTabs.delete(this.#options.tab.purpose)
    })()
    return this.#closing
  }
}
