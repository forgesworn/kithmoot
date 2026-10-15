import { OrdinaryForegroundSigner } from './ordinary-foreground-signer.js'
import { OrdinaryPersistentBootstrap, type OrdinaryMemberSessionOptions, type OrdinaryOwnedMemberSession,
  wipeOrdinaryPersistentBootstrapResult } from './ordinary-persistent-bootstrap.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { OrdinaryStateOwner } from './ordinary-state-owner.js'
import { deriveInvitationId } from '../../src/invitation.js'

type BootstrapOptions = Parameters<typeof OrdinaryPersistentBootstrap.open>[0]
type ForegroundOptions = Omit<Parameters<typeof OrdinaryForegroundSigner.open>[0], 'browser' | 'tab' | 'live'>
export interface OrdinaryMemberStartupOptions extends BootstrapOptions {
  readonly foreground?: ForegroundOptions
}
function hold(): never { throw new OrdinaryStateHold() }

/** Own one selected member across historical recovery and a fresh ordinary
 * role check. The raw SDK remains borrowed from its caller; no raw library
 * Session, protocol executor, storage image or historical authority escapes.
 * The application must still mount its other consumers behind native custody. */
export class OrdinaryMemberStartup {
  readonly #options: OrdinaryMemberStartupOptions
  readonly #participant: string
  readonly #sign: BootstrapOptions['identity']['signEvent']
  readonly #invitationId: string
  readonly #work = new Set<Promise<unknown>>()
  #foreground: OrdinaryForegroundSigner | undefined
  #bootstrap: OrdinaryPersistentBootstrap | undefined
  #memberCalled = false
  #held = false
  #closed = false
  #closing: Promise<void> | undefined

  private constructor(options: OrdinaryMemberStartupOptions) {
    this.#options = options; this.#participant = options.identity.pubkey
    this.#sign = options.identity.signEvent; this.#invitationId = deriveInvitationId(options.invitation)
  }
  #live = (): boolean => {
    if (this.#held || this.#closed) return false
    try {
      const selected = this.#options.current()
      const live = this.#options.live() === true && this.#options.identity.pubkey === this.#participant &&
        this.#options.identity.signEvent === this.#sign && selected?.identity === this.#options.identity &&
        selected.account === this.#options.account && selected.participant === this.#participant &&
        selected.invitationId === this.#invitationId && selected.link === this.#options.link &&
        selected.keep === this.#options.keep && selected.credentialExpiresAt === this.#options.credentialExpiresAt
      return live && !this.#held && !this.#closed
    } catch { return false }
  }
  #check(): void { if (!this.#live()) hold() }
  #stop(): void {
    if (this.#held) return
    this.#held = true; this.#bootstrap?.revoke(); this.#foreground?.revoke()
    this.#options.browser.retryRetention(); this.#options.tab.retryRetention()
    // Never join the operation from its own refusal continuation.
    queueMicrotask(() => { void this.close().catch(() => {}) })
    try { this.#options.foreground?.stop() } catch { /* already held */ }
  }
  #track<T>(body: () => Promise<T>): Promise<T> {
    // Install the actual outer promise in both owner lifetimes before body
    // starts. Close joins it outside its own body, including on refusal.
    const pending = Promise.resolve().then(body)
    OrdinaryStateOwner.joinPairLifetime(this.#options.browser, this.#options.tab, pending)
    this.#work.add(pending)
    void pending.finally(() => this.#work.delete(pending)).catch(() => {})
    return pending
  }
  static async open(input: OrdinaryMemberStartupOptions): Promise<OrdinaryMemberStartup> {
    const options = { ...input, ...(input.foreground ? { foreground: { ...input.foreground } } : {}) }
    const state = new OrdinaryMemberStartup(options)
    try {
      if (options.account !== null && (!options.foreground || options.account !== state.#participant ||
          options.foreground.session.signer !== options.identity) || options.account === null && options.foreground !== undefined) hold()
      await state.#track(() => state.#open())
      state.#check(); return state
    } catch (error) { state.#stop(); await state.close(); throw error }
  }
  async #open(): Promise<void> {
    this.#check()
    const options = this.#options
    let disposition = await options.browser.inspectRenewalStartup(this.#live)
    this.#check()
    // Refuse the whole origin before recovery writes if any signer attempt
    // cannot be resumed by this exact selection. Started without a result is
    // permanently non-retriable. Diagnostic classification grants no role.
    if (disposition.operations.some(operation => operation.phase === 'provider-started' ||
        operation.phase === 'prepared' && operation.tab !== options.tab.purpose)) hold()
    for (const operation of disposition.operations) {
      this.#check()
      if (operation.phase === 'prepared') {
        await OrdinaryPersistentBootstrap.recoverPreparedAtStartup({ ...options, live: this.#live })
      } else if (operation.phase === 'provider-returned' || operation.phase === 'candidate-prepared') {
        await options.browser.recoverRetainedRenewalAtStartup(operation.tab, this.#live)
        this.#check()
        await options.browser.recoverCommittedRenewalAtStartup(operation.tab, this.#live)
      } else if (operation.phase === 'candidate-committed') {
        await options.browser.recoverCommittedRenewalAtStartup(operation.tab, this.#live)
      }
      this.#check()
    }
    disposition = await options.browser.inspectRenewalStartup(this.#live)
    this.#check()
    if (disposition.status !== 'ordinary') hold()
    await options.browser.openExisting(this.#live)
    this.#check()
    await options.tab.openExisting(this.#live)
    this.#check()
    if (options.foreground) {
      this.#foreground = await OrdinaryForegroundSigner.open({ ...options.foreground,
        browser: options.browser, tab: options.tab, live: this.#live, stop: () => this.#stop() })
      this.#check()
    }
    const identity = this.#foreground ?? options.identity
    this.#bootstrap = await OrdinaryPersistentBootstrap.open({ ...options, identity, live: this.#live,
      current: () => {
        if (!this.#live()) return undefined
        const selected = options.current()
        return selected && this.#live() ? { ...selected, identity } : undefined
      } })
    this.#check()
    // Load performs the fresh selected proof, immutable admission, current
    // credential/deadline and native signer checks. S itself is never enough.
    const material = await this.#bootstrap.load()
    try { this.#check() } finally { wipeOrdinaryPersistentBootstrapResult(material) }
  }
  openMemberSession(input: OrdinaryMemberSessionOptions): Promise<OrdinaryOwnedMemberSession> {
    if (this.#memberCalled || !this.#bootstrap) return Promise.reject(new OrdinaryStateHold())
    this.#memberCalled = true
    return this.#track(async () => {
      this.#check()
      try {
        const member = await this.#bootstrap!.openMemberSession(input)
        this.#check(); return member
      } catch (error) { this.#stop(); throw error }
    })
  }
  revoke(): void { this.#stop() }
  close(): Promise<void> {
    if (this.#closing) return this.#closing
    this.#closed = true; this.#stop()
    this.#closing = (async () => {
      while (this.#work.size) await Promise.allSettled([...this.#work])
      await this.#bootstrap?.close(); await this.#foreground?.close()
      this.#bootstrap = undefined; this.#foreground = undefined
    })()
    return this.#closing
  }
}
