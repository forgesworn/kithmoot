import { OrdinaryLegacyStartupLifetime } from './ordinary-legacy-startup.js'
import { OrdinaryProtectedWorkerLifetime } from './ordinary-protected-worker.js'
import type { OrdinaryPrivateExistingCaptureResource, OrdinaryPrivateMemberActionKind, OrdinaryPrivateSelectionPreview, OrdinaryPrivateSelectionPreviewReceipt } from './ordinary-state-owner.js'

const privateRootFreeze = Object.freeze
const privateRootCreate = Object.create
const privateRootAssign = Object.assign
declare const privateMemberIntentBrand: unique symbol
export interface OrdinaryPrivateMemberIntent {readonly [privateMemberIntentBrand]: true}
interface PrivateMemberAction {
  readonly root: object
  readonly kind: OrdinaryPrivateMemberActionKind
  readonly receipt: OrdinaryPrivateSelectionPreviewReceipt
  readonly command: Promise<void>
  readonly current: () => boolean
  readonly wallet: () => OrdinaryPrivateWalletTicket
  readonly walletEnd: (ticket: OrdinaryPrivateWalletTicket) => Promise<void>
  readonly walletDiscard: (ticket: OrdinaryPrivateWalletTicket) => void
  walletStarted: boolean
  claimed: boolean
}
const memberIntents = new WeakMap<object, PrivateMemberAction>()
const memberCommands = new WeakMap<object, PrivateMemberAction>()
/** Fixed owner consumer. Spend a genuine intent before checking its purpose,
 * root or command. Neither caller data nor Event structure can mint it. */
export function claimOrdinaryPrivateMemberIntent(root: OrdinaryPrivateExistingRoot, intent: OrdinaryPrivateMemberIntent,
  receipt: OrdinaryPrivateSelectionPreviewReceipt, kind: OrdinaryPrivateMemberActionKind, command: Promise<void>): void {
  const value = memberIntents.get(intent)
  memberIntents.delete(intent)
  if (!value) hold()
  if (value.claimed || value.root !== root || value.kind !== kind || value.receipt !== receipt || value.command !== command ||
      memberCommands.get(command) !== value || !value.current()) {
    memberCommands.delete(value.command); hold()
  }
  value.claimed = true
}
export function assertOrdinaryPrivateMemberCommand(root: OrdinaryPrivateExistingRoot, command: Promise<void>, kind: OrdinaryPrivateMemberActionKind): void {
  const value = memberCommands.get(command)
  if (!value || !value.claimed || value.root !== root || value.kind !== kind || !value.current()) hold()
}
declare const privateWalletTicketBrand: unique symbol
export interface OrdinaryPrivateWalletTicket {readonly [privateWalletTicketBrand]: true}
interface PrivateWalletWork {
  readonly action: PrivateMemberAction
  readonly view: PrivateMemberView
  readonly ticket: OrdinaryPrivateWalletTicket
  readonly focus: Promise<void>
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
  phase: 'pending' | 'ending' | 'ended' | 'revoked'
  blurred: boolean
  focusReturnedAfterBlur: boolean
  removeFocus: (() => void) | undefined
  cancelTimer: (() => void) | undefined
}
const walletTickets = new WeakMap<object, PrivateWalletWork>()
/** The root spends one explicit action's wallet opportunity before returning
 * this ticket. The owner invokes the exact provider immediately in that turn. */
export function beginOrdinaryPrivateWalletEffect(root: OrdinaryPrivateExistingRoot, command: Promise<void>,
  kind: 'unlock-private-member' | 'verify-private-member'): OrdinaryPrivateWalletTicket {
  assertOrdinaryPrivateMemberCommand(root, command, kind)
  return memberCommands.get(command)!.wallet()
}
/** Result acceptance is ordered after real provider settlement and native
 * focus return. Neither a caller boolean nor a forged focus event can end it. */
export function endOrdinaryPrivateWalletEffect(root: OrdinaryPrivateExistingRoot, command: Promise<void>,
  ticket: OrdinaryPrivateWalletTicket): Promise<void> {
  const value = walletTickets.get(ticket)
  if (!value || value.action.root !== root || value.action.command !== command || memberCommands.get(command) !== value.action) return Promise.reject(new Error('Protected startup held'))
  return value.action.walletEnd(ticket)
}
export function discardOrdinaryPrivateWalletEffect(root: OrdinaryPrivateExistingRoot, command: Promise<void>, ticket: OrdinaryPrivateWalletTicket): void {
  const value = walletTickets.get(ticket)
  if (value && value.action.root === root && value.action.command === command) value.action.walletDiscard(ticket)
}

interface PrivateMemberView {
  readonly identity: object
  readonly kind: OrdinaryPrivateMemberActionKind
  readonly preview: OrdinaryPrivateSelectionPreview
  readonly node: HTMLElement
  readonly button: HTMLButtonElement
  readonly facts: readonly Readonly<{node: Node; text: string}>[]
  removeListener: (() => void) | undefined
  removeWatch: (() => void) | undefined
  intent: OrdinaryPrivateMemberIntent | undefined
  command: Promise<void> | undefined
  walletTicket: OrdinaryPrivateWalletTicket | undefined
  phase: 'ready' | 'pending' | 'retired'
}

const MARKER = 'kithmoot.ordinary-tab.v1'
const HEX = /^[0-9a-f]{64}$/
declare const privateRoot: unique symbol
export interface OrdinaryPrivateExistingRoot { readonly [privateRoot]: true }
export interface OrdinaryPrivateExistingRootBinding {
  readonly href: string
  readonly origin: string
  readonly marker: string
  readonly controller: ServiceWorker
  readonly generation: number
  readonly websocketImplementation: typeof WebSocket
  live(): boolean
  assertClientsCurrent(): Promise<void>
  revoke(): void
}
const roots = new WeakMap<object, { root: ExistingRoot; claimed: boolean }>()
const providerCommands = new WeakMap<object, {root: object; current: () => boolean}>()
/** Native owner consumer only. Spend the exact root-registered command before
 * capture consumption. A foreign, substituted or settled promise cannot mint
 * construction timing or consent. No root binding or owner is returned. */
export function claimOrdinaryPrivateExistingProviderCommand(root: OrdinaryPrivateExistingRoot, command: Promise<void>): void {
  const value = providerCommands.get(command)
  if (!value) hold()
  providerCommands.delete(command)
  if (value.root !== root || !value.current()) hold()
}
function hold(): never { throw new Error('Protected startup held') }
/** Invoke each fixed close synchronously, but represent even a synchronous
 * failure as a joined result so another resource's cleanup cannot be skipped. */
function joinClose(close: () => void | Promise<void>): Promise<void> {
  try { return Promise.resolve(close()) } catch (error) { return Promise.reject(error) }
}

/** Package-private native capture boundary. The actual root never escapes the
 * zero-argument entry below. Presence, a caller URL and a caller owner cannot
 * mint this binding. A proxy or repeated claim is refused. */
export function claimOrdinaryPrivateExistingRoot(root: OrdinaryPrivateExistingRoot): OrdinaryPrivateExistingRootBinding {
  const value = roots.get(root)
  if (!value || value.claimed) hold()
  const binding = value.root.claim()
  value.claimed = true
  return binding
}

/** Draft mechanics for the root-owned view. This does not mint an intent or
 * authorise an owner/provider operation. The root still owns phase, preview,
 * command identity and the synchronously consumed purpose-specific claim. */
function captureOrdinaryPrivateTrustedInput() {
  const apply = Reflect.apply
  const get = (prototype: object, name: string): (() => unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
    if (typeof descriptor?.get !== 'function') throw new Error('Protected startup held')
    return descriptor.get
  }
  const set = (prototype: object, name: string): ((value: unknown) => void) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
    if (typeof descriptor?.set !== 'function') throw new Error('Protected startup held')
    return descriptor.set
  }
  const held = (): never => { throw new Error('Protected startup held') }
  const read = (accessor: () => unknown, receiver: unknown) => apply(accessor, receiver, [])
  // Capture before publishing any element or direct listener. The sample
  // Event supplies the realm's unforgeable instance isTrusted getter.
  const doc = document, nav = navigator
  const createElement = Document.prototype.createElement, appendChild = Node.prototype.appendChild,
    removeChild = Node.prototype.removeChild, setAttribute = Element.prototype.setAttribute,
    body = get(Document.prototype, 'body'), parent = get(Node.prototype, 'parentNode')
  const type = get(Event.prototype, 'type'), currentTarget = get(Event.prototype, 'currentTarget'),
    target = get(Event.prototype, 'target'), trusted = get(new Event('click'), 'isTrusted'),
    connected = get(Node.prototype, 'isConnected'), ownerDocument = get(Node.prototype, 'ownerDocument'),
    disabled = get(HTMLButtonElement.prototype, 'disabled'), setDisabled = set(HTMLButtonElement.prototype, 'disabled'),
    visibility = get(Document.prototype, 'visibilityState'), text = get(Node.prototype, 'textContent'),
    setText = set(Node.prototype, 'textContent'), activation = get(Navigator.prototype, 'userActivation')
  const userActivation = read(activation, nav)
  if (!userActivation) held()
  const active = get(Object.getPrototypeOf(userActivation), 'isActive')
  const hasFocus = Document.prototype.hasFocus, setTimer = window.setTimeout, clearTimer = window.clearTimeout
  const rectangles = Element.prototype.getClientRects
  const sampleRects = apply(rectangles, doc.createElement('button'), [])
  const rectangleCount = get(Object.getPrototypeOf(sampleRects), 'length')
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener
  const spent = new WeakSet<object>(), has = WeakSet.prototype.has, spend = WeakSet.prototype.add
  const disable = (button: HTMLButtonElement) => { apply(setDisabled, button, [true]) }
  return privateRootFreeze(privateRootAssign(privateRootCreate(null), {
    /** Only native click dispatch on this exact private button may pass. Plain
     * objects and Proxies fail the Event brand check before structural reads.
     * No Event or element is retained in an intent record by this helper. */
    take(event: unknown, button: HTMLButtonElement): void {
      if (read(type, event) !== 'click' || read(trusted, event) !== true ||
          read(currentTarget, event) !== button || read(target, event) !== button ||
          apply(has, spent, [event]) || read(connected, button) !== true ||
          read(ownerDocument, button) !== doc || read(visibility, doc) !== 'visible' ||
          read(disabled, button) !== false || read(activation, nav) !== userActivation ||
          read(active, userActivation) !== true) held()
      const count = read(rectangleCount, apply(rectangles, button, []))
      if (typeof count !== 'number' || count < 1) held()
      apply(spend, spent, [event])
      // Disable synchronously before returning to the root's token mint. All
      // pointer/Enter/Space paths use the same native click, with no key shim.
      disable(button)
    },
    // Availability only; the root must also consume/bind its exact private
    // action token. Call after all awaits and immediately before each effect.
    assertActive(): void {
      if (read(activation, nav) !== userActivation || read(active, userActivation) !== true ||
          read(visibility, doc) !== 'visible') held()
    },
    // Fixed root-private lifetime helper. The production root supplies only
    // its own synchronous revoke closure and retains the remover itself.
    // Register after the original click's capture phase; every later trusted
    // activation input revokes the old pending action, including key clicks.
    watchLaterActivation(revoke: () => void, windowBlur: () => void): () => void {
      let watching = true
      const changed = (event: Event) => {
        if (watching && read(trusted, event) === true) revoke()
      }
      const ended = () => { if (watching) revoke() }
      // Capturing blur also sees a focused button lose focus when disabled.
      // Only the window's own blur retires the document action; later native
      // activation inputs remain a separate unconditional retirement edge.
      const blurred = (event: Event) => { if (watching && read(target, event) === window) windowBlur() }
      const inputs = ['pointerdown', 'mousedown', 'touchend', 'keydown', 'click'] as const
      for (let i = 0; i < inputs.length; i++) apply(add, window, [inputs[i], changed, true])
      apply(add, window, ['blur', blurred, true]); apply(add, window, ['pagehide', ended, true])
      apply(add, doc, ['visibilitychange', ended, true])
      return () => {
        if (!watching) return
        watching = false
        let failed: {error: unknown} | undefined
        const removeOne = (receiver: EventTarget, type: string, listener: EventListener) => {
          try { apply(remove, receiver, [type, listener, true]) }
          catch (error) { failed ??= {error} }
        }
        for (let i = 0; i < inputs.length; i++) removeOne(window, inputs[i]!, changed)
        removeOne(window, 'blur', blurred); removeOne(window, 'pagehide', ended)
        removeOne(doc, 'visibilitychange', ended)
        if (failed) throw failed.error
      }
    },
    focused(): boolean { return apply(hasFocus, doc, []) === true && read(visibility, doc) === 'visible' },
    listenFocus(listener: () => void): () => void {
      const changed = (event: Event) => {if (read(target, event) === window && read(trusted, event) === true && apply(hasFocus, doc, []) === true) listener()}
      apply(add, window, ['focus', changed, true])
      return () => {apply(remove, window, ['focus', changed, true])}
    },
    after(delay: number, callback: () => void): () => void {
      const handle = apply(setTimer, window, [callback, delay])
      return () => {apply(clearTimer, window, [handle])}
    },
    make(name: string): HTMLElement { return apply(createElement, doc, [name]) },
    append(parent: Node, child: Node): void { apply(appendChild, parent, [child]) },
    mount(node: Node): void { apply(appendChild, read(body, doc), [node]) },
    removeNode(node: Node): void { const current = read(parent, node); if (current) apply(removeChild, current, [node]) },
    attr(node: Element, name: string, value: string): void { apply(setAttribute, node, [name, value]) },
    connected(node: Node): boolean { return read(connected, node) === true && read(ownerDocument, node) === doc },
    enable(button: HTMLButtonElement): void { apply(setDisabled, button, [false]) },
    disable,
    listen(button: HTMLButtonElement, listener: (event: Event) => void): () => void {
      apply(add, button, ['click', listener, false])
      return () => { apply(remove, button, ['click', listener, false]) }
    },
    setText(node: Node, value: string): void { apply(setText, node, [value]) },
    hasText(node: Node, expected: string): boolean { return read(text, node) === expected },
  })) as Readonly<{
    take(event: unknown, button: HTMLButtonElement): void
    assertActive(): void
    watchLaterActivation(revoke: () => void, windowBlur: () => void): () => void
    focused(): boolean
    listenFocus(listener: () => void): () => void
    after(delay: number, callback: () => void): () => void
    make(name: string): HTMLElement
    append(parent: Node, child: Node): void
    mount(node: Node): void
    removeNode(node: Node): void
    attr(node: Element, name: string, value: string): void
    connected(node: Node): boolean
    enable(button: HTMLButtonElement): void
    disable(button: HTMLButtonElement): void
    listen(button: HTMLButtonElement, listener: (event: Event) => void): () => void
    setText(node: Node, value: string): void
    hasText(node: Node, expected: string): boolean
  }>
}

class ExistingRoot {
  readonly #input = captureOrdinaryPrivateTrustedInput()
  readonly #memberTails = new Set<Promise<unknown>>()
  #trustedMemberMode = false
  #memberOpening?: Promise<void>
  #memberView?: PrivateMemberView
  #nativeMember?: typeof import('./ordinary-state-owner.js')
  // Actual entry metadata is captured synchronously before the first await.
  readonly #href = location.href
  readonly #origin = location.origin
  readonly #controller = navigator.serviceWorker?.controller ?? null
  readonly #storage = sessionStorage
  readonly #marker = this.#storage.getItem(MARKER)
  readonly #generation = 1
  readonly #websocketImplementation = WebSocket
  readonly #startup = new OrdinaryLegacyStartupLifetime()
  #worker?: OrdinaryProtectedWorkerLifetime
  #capture?: OrdinaryPrivateExistingCaptureResource
  #provider?: OrdinaryPrivateExistingCaptureResource
  #beginProvider?: (root: OrdinaryPrivateExistingRoot, command: Promise<void>) => OrdinaryPrivateExistingCaptureResource
  #providerWork?: Promise<void>
  #providerOpening?: Promise<void>
  #work?: Promise<void>
  #opening?: Promise<void>
  #closing?: Promise<void>
  #lockWork?: Promise<void>
  #releaseTab?: () => void
  #workerClose?: Promise<void>
  #startupClose?: Promise<void>
  #stopFailure?: { readonly error: unknown }
  #closed = false
  #claimable = false
  #captureReady = false
  #startupAcquired = false
  #pagehide = () => { void this.close().catch(() => {}) }
  #changed = () => { void this.close().catch(() => {}) }

  constructor() {
    roots.set(this, { root: this, claimed: false })
    window.addEventListener('pagehide', this.#pagehide, { once: true })
    navigator.serviceWorker?.addEventListener('controllerchange', this.#changed)
  }
  #live(): boolean {
    try {
      return !this.#closed && !this.#stopFailure && this.#controller !== null &&
        navigator.serviceWorker.controller === this.#controller &&
        location.href === this.#href && location.origin === this.#origin &&
        this.#marker !== null && HEX.test(this.#marker) &&
        this.#storage.getItem(MARKER) === this.#marker && !!this.#worker?.live
    } catch { return false }
  }
  #check(): void { if (!this.#live()) hold() }
  claim(): OrdinaryPrivateExistingRootBinding {
    if (!this.#claimable || !this.#releaseTab || !this.#marker || !this.#controller) hold()
    this.#check()
    this.#claimable = false
    return Object.freeze({ href: this.#href, origin: this.#origin, marker: this.#marker,
      controller: this.#controller, generation: this.#generation, websocketImplementation: this.#websocketImplementation,
      live: () => this.#live(),
      assertClientsCurrent: async () => { this.#check(); await this.#worker!.assertCurrent(); this.#check() },
      revoke: () => { void this.close().catch(() => {}) } })
  }
  start(): Promise<void> {
    if (this.#opening) return this.#opening
    this.#work = this.#run()
    this.#opening = this.#work.then(async () => {
      // The checkpoint deliberately stops before provider/SDK/Session effects.
      // Retain the root, tab lock and MIGRATION until revocation/pagehide.
      if (!this.#live()) { await this.close(); return }
      this.#notice('captured-held')
    }, async () => {
      this.#stop()
      // #work is already terminal here; close cannot join itself.
      await this.close()
    })
    return this.#opening
  }
  #beginMemberWallet(view: PrivateMemberView, action: PrivateMemberAction): OrdinaryPrivateWalletTicket {
    if (action.walletStarted || !action.claimed || !action.current() || view.walletTicket ||
        action.kind === 'connect-private-member') hold()
    action.walletStarted = true // Permanent even when availability now refuses.
    this.#input.assertActive()
    if (!this.#input.focused()) hold()
    let resolve!: () => void, reject!: (error: unknown) => void
    const focus = new Promise<void>((yes, no) => {resolve = yes; reject = no})
    void focus.catch(() => {})
    this.#trackMember(focus)
    const ticket = privateRootFreeze(privateRootCreate(null)) as OrdinaryPrivateWalletTicket
    const work: PrivateWalletWork = privateRootAssign(privateRootCreate(null), {action, view, ticket, focus,
      resolve, reject, phase: 'pending' as const, blurred: false, focusReturnedAfterBlur: false,
      removeFocus: undefined, cancelTimer: undefined})
    walletTickets.set(ticket, work); view.walletTicket = ticket
    try {
      work.removeFocus = this.#input.listenFocus(() => {
        if ((work.phase === 'pending' || work.phase === 'ending') && walletTickets.get(ticket) === work &&
            view.walletTicket === ticket && work.action.current() && this.#input.focused()) {
          if (work.blurred) work.focusReturnedAfterBlur = true
          if (work.phase === 'ending') work.resolve()
        }
      })
      if (!action.current() || !this.#input.focused()) hold()
    } catch (error) {this.#discardMemberWallet(ticket); throw error}
    return ticket
  }
  #memberWindowBlur(view: PrivateMemberView): void {
    const ticket = view.walletTicket, work = ticket && walletTickets.get(ticket)
    if (work && work.view === view && (work.phase === 'pending' || work.phase === 'ending') && work.action.current()) {
      work.blurred = true // Only this already-started effect may remain pending.
      work.focusReturnedAfterBlur = false // A later blur spends the previous return.
      return
    }
    this.#stop(); void this.close().catch(() => {})
  }
  #endMemberWallet(ticket: OrdinaryPrivateWalletTicket): Promise<void> {
    const work = walletTickets.get(ticket)
    if (!work || work.phase !== 'pending' || work.view.walletTicket !== ticket || !work.action.current()) return Promise.reject(new Error('Protected startup held'))
    work.phase = 'ending' // Consume end before await; repeated end cannot pass.
    try {
      if (this.#input.focused() && (!work.blurred || work.focusReturnedAfterBlur)) work.resolve()
      else work.cancelTimer = this.#input.after(10_000, () => {
        if (walletTickets.get(ticket) === work && work.view.walletTicket === ticket && work.phase === 'ending') {
          this.#stop(); void this.close().catch(() => {})
        }
      })
    } catch (error) {this.#discardMemberWallet(ticket); return Promise.reject(error)}
    return work.focus.then(() => {
      if (work.phase !== 'ending' || walletTickets.get(ticket) !== work || work.view.walletTicket !== ticket ||
          !work.action.current() || !this.#input.focused() || (work.blurred && !work.focusReturnedAfterBlur)) hold()
      work.phase = 'ended'
      walletTickets.delete(ticket); work.view.walletTicket = undefined
      this.#stopOne(() => work.removeFocus?.()); this.#stopOne(() => work.cancelTimer?.())
      work.removeFocus = undefined; work.cancelTimer = undefined
      this.#check() // Every cleanup was attempted; a failure refuses result acceptance.
    }, error => {this.#discardMemberWallet(ticket); throw error})
  }
  #discardMemberWallet(ticket: OrdinaryPrivateWalletTicket): void {
    const work = walletTickets.get(ticket)
    if (!work) return
    walletTickets.delete(ticket)
    work.phase = 'revoked'
    if (work.view.walletTicket === ticket) work.view.walletTicket = undefined
    work.reject(new Error('Protected startup held'))
    this.#stopOne(() => work.removeFocus?.()); this.#stopOne(() => work.cancelTimer?.())
    work.removeFocus = undefined; work.cancelTimer = undefined
  }

  #trackMember<T>(work: Promise<T>): Promise<T> {
    this.#memberTails.add(work)
    void work.finally(() => this.#memberTails.delete(work)).catch(() => {})
    return work
  }
  prepareMember(): Promise<void> {
    if (this.#memberOpening) return this.#memberOpening
    if (this.#providerWork || this.#closed) { this.#stop(); return this.close() }
    // The mode is fixed before start's first await. Ambient restoration is
    // held while the explicit private member UI owns this root.
    this.#trustedMemberMode = true
    const opening = this.#trackMember(this.start().then(() => this.#showMemberAction('unlock-private-member')))
    this.#memberOpening = opening.then(undefined, async () => {this.#stop(); await this.close()})
    return this.#memberOpening
  }
  #retireMemberView(): void {
    const value = this.#memberView
    this.#memberView = undefined // Invalidate before any DOM/cancel operation.
    if (value) {
      value.phase = 'retired'
      if (value.walletTicket) this.#stopOne(() => this.#discardMemberWallet(value.walletTicket!))
      if (value.intent) memberIntents.delete(value.intent)
      if (value.command) memberCommands.delete(value.command)
      this.#stopOne(() => this.#input.disable(value.button))
      this.#stopOne(() => value.removeWatch?.())
      this.#stopOne(() => value.removeListener?.())
      this.#stopOne(() => this.#input.removeNode(value.node))
      value.removeWatch = undefined; value.removeListener = undefined
      value.intent = undefined; value.command = undefined
    }
    this.#stopOne(() => this.#nativeMember?.revokeOrdinaryPrivateSelectionPreview(this as unknown as OrdinaryPrivateExistingRoot))
  }
  #showMemberAction(kind: OrdinaryPrivateMemberActionKind): Promise<void> {
    let resolve!: () => void, reject!: (error: unknown) => void
    const outer = new Promise<void>((yes, no) => {resolve = yes; reject = no})
    void outer.catch(() => {})
    this.#trackMember(outer)
    // The root owns this outer before any native read is queued.
    void Promise.resolve().then(async () => {
      this.#check(); if (!this.#trustedMemberMode || !this.#nativeMember || !this.#captureReady) hold()
      this.#retireMemberView(); this.#check()
      const preview = await this.#nativeMember.prepareOrdinaryPrivateSelectionPreview(this as unknown as OrdinaryPrivateExistingRoot, kind)
      this.#check()
      const node = this.#input.make('section'), heading = this.#input.make('h1'), details = this.#input.make('p'),
        account = this.#input.make('p'), room = this.#input.make('p'), destinations = this.#input.make('p'),
        button = this.#input.make('button') as HTMLButtonElement
      this.#input.attr(node, 'data-private-member-view', kind)
      this.#input.attr(button, 'type', 'button')
      this.#input.attr(button, 'data-private-member-action', kind)
      this.#input.disable(button)
      const label = kind === 'unlock-private-member' ? 'Unlock private room' : kind === 'verify-private-member' ? 'Verify account' : 'Connect to room'
      let relays = 'Direct relay destinations:'
      for (let index = 0; index < preview.display.relays.length; index++) relays += '\n' + preview.display.relays[index]
      const facts = privateRootFreeze([
        privateRootFreeze({node: heading, text: preview.display.roomLabel}),
        privateRootFreeze({node: details, text: kind === 'unlock-private-member' ?
          'Allow your browser signer to identify this account. This does not sign a proof or connect to relays.' :
          kind === 'verify-private-member' ? 'Sign one account-control proof to prepare this room. This does not connect to relays.' :
          'Connect to the relay destinations shown below. Your browser signer will not be asked to sign again.'}),
        privateRootFreeze({node: account, text: 'Account: ' + preview.display.account}),
        privateRootFreeze({node: room, text: 'Room: ' + preview.display.roomId}),
        privateRootFreeze({node: destinations, text: relays}), privateRootFreeze({node: button, text: label}),
      ])
      for (let index = 0; index < facts.length; index++) {
        this.#input.setText(facts[index]!.node, facts[index]!.text)
        this.#input.append(node, facts[index]!.node)
      }
      const view: PrivateMemberView = privateRootAssign(privateRootCreate(null), {identity: privateRootFreeze(privateRootCreate(null)), kind,
        preview, node, button, facts, phase: 'ready' as const, removeListener: undefined, removeWatch: undefined, intent: undefined, command: undefined, walletTicket: undefined})
      this.#memberView = view
      view.removeListener = this.#input.listen(button, event => {this.#takeMemberAction(event, view)})
      this.#input.mount(node); this.#check()
      if (this.#memberView !== view || view.phase !== 'ready') hold()
      this.#input.enable(button)
      this.#notice(kind === 'unlock-private-member' ? 'unlock-ready' : kind === 'verify-private-member' ? 'verify-ready' : 'connect-ready')
    }).then(resolve, reject).catch(() => {})
    return outer
  }
  #memberActionCurrent(view: PrivateMemberView, command: Promise<void>): boolean {
    try {
      if (!this.#live() || !this.#trustedMemberMode || this.#memberView !== view || view.phase !== 'pending' ||
          view.command !== command || !this.#input.connected(view.node) || !this.#input.connected(view.button)) return false
      for (let index = 0; index < view.facts.length; index++) {
        const fact = view.facts[index]!
        if (!this.#input.connected(fact.node) || !this.#input.hasText(fact.node, fact.text)) return false
      }
      return true
    } catch { return false }
  }
  #takeMemberAction(event: Event, view: PrivateMemberView): void {
    if (!this.#live() || !this.#trustedMemberMode || this.#memberView !== view || view.phase !== 'ready' || !this.#nativeMember) return
    // Rendering is part of the same synchronous decision as native input.
    for (let index = 0; index < view.facts.length; index++) {
      const fact = view.facts[index]!
      if (!this.#input.connected(fact.node) || !this.#input.hasText(fact.node, fact.text)) {this.#stop(); void this.close().catch(() => {}); return}
    }
    try {this.#input.take(event, view.button)} catch {return}
    view.phase = 'pending' // Before a token, import, getter or queued work.
    let resolve!: () => void, reject!: (error: unknown) => void
    const command = new Promise<void>((yes, no) => {resolve = yes; reject = no})
    void command.catch(() => {})
    this.#trackMember(command)
    view.command = command
    const intent = privateRootFreeze(privateRootCreate(null)) as OrdinaryPrivateMemberIntent
    view.intent = intent
    const action: PrivateMemberAction = privateRootAssign(privateRootCreate(null), {root: this, kind: view.kind,
      receipt: view.preview.receipt, command, claimed: false, walletStarted: false, current: () => this.#memberActionCurrent(view, command),
      wallet: () => this.#beginMemberWallet(view, action), walletEnd: (ticket: OrdinaryPrivateWalletTicket) => this.#endMemberWallet(ticket),
      walletDiscard: (ticket: OrdinaryPrivateWalletTicket) => this.#discardMemberWallet(ticket)})
    memberIntents.set(intent, action); memberCommands.set(command, action)
    try {
      view.removeWatch = this.#input.watchLaterActivation(() => {this.#stop(); void this.close().catch(() => {})}, () => this.#memberWindowBlur(view))
      if (view.kind === 'unlock-private-member') {
        this.#providerWork = command
        providerCommands.set(command, {root: this, current: () => this.#providerWork === command && this.#captureReady && action.current()})
        this.#nativeMember.reserveOrdinaryPrivateTrustedUnlock(this as unknown as OrdinaryPrivateExistingRoot, intent, view.preview.receipt, command)
        this.#provider = this.#beginProvider!(this as unknown as OrdinaryPrivateExistingRoot, command)
        if (this.#closed) this.#provider.stop()
        // The fixed owner awaits the actual resource and constructs the whole
        // non-network member graph. The root never receives an SDK or proof.
        const finishing = this.#nativeMember.finishOrdinaryPrivateTrustedUnlock(this as unknown as OrdinaryPrivateExistingRoot, command)
        void finishing.then(resolve, reject)
      } else if (view.kind === 'verify-private-member') {
        this.#nativeMember.reserveOrdinaryPrivateTrustedProof(this as unknown as OrdinaryPrivateExistingRoot, intent, view.preview.receipt, command)
        void this.#nativeMember.finishOrdinaryPrivateTrustedUnlock(this as unknown as OrdinaryPrivateExistingRoot, command).then(resolve, reject)
      } else {
        const connecting = this.#nativeMember.connectOrdinaryPrivateTrustedMember(this as unknown as OrdinaryPrivateExistingRoot, intent, view.preview.receipt, command)
        void connecting.then(resolve, reject)
      }
    } catch (error) {reject(error)}
    void command.then(async () => {
      memberIntents.delete(intent); memberCommands.delete(command); providerCommands.delete(command)
      // Stop the old input watcher before publishing the next distinct step.
      this.#stopOne(() => view.removeWatch?.()); view.removeWatch = undefined
      this.#check()
      if (view.kind === 'unlock-private-member') await this.#showMemberAction('verify-private-member')
      else if (view.kind === 'verify-private-member') await this.#showMemberAction('connect-private-member')
      else {this.#retireMemberView(); this.#check(); this.#notice('member-joined')}
    }, () => {this.#stop(); void this.close().catch(() => {})}).catch(() => {this.#stop(); void this.close().catch(() => {})})
  }

  restoreProvider(): Promise<void> {
    if (this.#trustedMemberMode) return Promise.reject(new Error('Protected startup held'))
    if (this.#providerOpening) return this.#providerOpening
    // Checkpoint callers must wait for the actual native capture. There is
    // no queued provider construction hidden behind initial startup work.
    if (!this.#captureReady || !this.#beginProvider || !this.#live()) {
      this.#stop()
      return this.close()
    }
    let resolve!: () => void, reject!: (error: unknown) => void
    const command = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    // Publish the exact command before native resource creation can revoke or
    // re-enter this root. The provider retains this same outer on both owners.
    this.#providerWork = command
    providerCommands.set(command, {root: this, current: () => this.#providerWork === command && this.#captureReady && this.#live()})
    void command.finally(() => providerCommands.delete(command)).catch(() => {})
    this.#providerOpening = this.#providerWork.then(async () => {
      if (!this.#live()) { await this.close(); return }
      this.#notice('provider-held')
    }, async () => { this.#stop(); await this.close() })
    try {
      this.#provider = this.#beginProvider!(this as unknown as OrdinaryPrivateExistingRoot, command)
      // Resource creation may synchronously revoke before assignment. Retain
      // that late resource and stop it; close joins it before releasing locks.
      if (this.#closed) this.#provider.stop()
      void this.#provider.completed.then(resolve, reject)
    } catch (error) { reject(error) }
    return this.#providerOpening
  }
  async #run(): Promise<void> {
    if (!this.#marker || !HEX.test(this.#marker) || !this.#origin || this.#origin === 'null' ||
        new URL(this.#href).origin !== this.#origin) hold()
    await this.#startup.acquire()
    this.#startupAcquired = true
    if (this.#closed) hold()
    if (await this.#startup.inspectPresence() !== 'existing' || this.#closed) hold()
    this.#worker = new OrdinaryProtectedWorkerLifetime()
    const prepared = await this.#worker.prepare()
    if (prepared !== 'ready' || this.#closed) hold()
    // Being controlled after worker installation cannot replace control at
    // document entry; this root's original controller must still be exact.
    this.#check()
    await new Promise<void>((resolve, reject) => {
      this.#lockWork = navigator.locks.request(`kithmoot-ordinary-state-v1:lifetime:${this.#marker}`,
        { mode: 'exclusive', ifAvailable: true }, async lock => {
          if (!lock || this.#closed) { reject(new Error('Protected startup held')); return }
          await new Promise<void>(release => { this.#releaseTab = release; resolve() })
        }).then(() => {})
      void this.#lockWork.catch(reject)
    })
    this.#check()
    await this.#worker.assertCurrent()
    this.#check()
    // This is the first owner/crypto/SDK runtime import in the root graph.
    const native = await import('./ordinary-state-owner.js')
    this.#check()
    this.#nativeMember = native
    this.#beginProvider = native.beginOrdinaryPrivateExistingProvider
    this.#claimable = true
    this.#capture = native.beginOrdinaryPrivateExistingCapture(this as unknown as OrdinaryPrivateExistingRoot)
    // begin queues the fixed exclusive native WRITE operation synchronously.
    // Release only the initial shared WRITE; keep MIGRATION and the tab lock.
    await this.#startup.releaseInitialWrite()
    this.#check()
    await this.#capture.completed
    this.#check()
    this.#captureReady = true
  }
  #notice(state: 'held' | 'captured-held' | 'provider-held' | 'unlock-ready' | 'verify-ready' | 'connect-ready' | 'member-joined'): void {
    document.documentElement.dataset.ordinaryProtectedStartup = state
  }
  #stopOne(stop: () => void): void {
    try { stop() } catch (error) { this.#stopFailure ??= { error } }
  }
  #stop(): void {
    if (this.#closed) return
    this.#closed = true
    this.#claimable = false
    this.#captureReady = false
    this.#retireMemberView()
    if (this.#providerWork) providerCommands.delete(this.#providerWork)
    this.#stopOne(() => this.#notice('held'))
    // Before acquire's continuation no native reader or worker was started.
    // Abort a queued acquisition now; once acquired, retain MIGRATION until
    // the ordered close below joins every subsequently owned resource.
    if (!this.#startupAcquired) this.#stopOne(() => {
      this.#startupClose = this.#startup.close()
      void this.#startupClose.catch(() => {})
    })
    this.#stopOne(() => this.#provider?.stop())
    this.#stopOne(() => this.#capture?.stop())
    this.#stopOne(() => {
      this.#workerClose = this.#worker?.close()
      void this.#workerClose?.catch(() => {})
    })
    this.#stopOne(() => window.removeEventListener('pagehide', this.#pagehide))
    this.#stopOne(() => navigator.serviceWorker?.removeEventListener('controllerchange', this.#changed))
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing
    let resolve!: () => void, reject!: (error: unknown) => void
    this.#closing = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    // Publish the close promise before synchronous revocation callbacks can
    // re-enter close through a native resource.
    this.#stop()
    // Starting close synchronously revokes native transactions. Its join runs
    // alongside the root work so a blocked open retains its real terminal tail.
    const initialProvider = this.#provider, initialCapture = this.#capture
    const providerClose = joinClose(() => initialProvider?.close())
    const nativeClose = joinClose(() => initialCapture?.close())
    const nativeJoins = Promise.allSettled([providerClose, nativeClose])
    void (async () => {
      await this.#work?.catch(() => {})
      await this.#providerWork?.catch(() => {})
      while (this.#memberTails.size) await Promise.allSettled([...this.#memberTails])
      // Rejection cannot skip another owned resource. Pending provider work
      // still retains the tab and MIGRATION locks until it has actually joined.
      const results = await nativeJoins
      // A synchronous revocation during provider construction can start close
      // before #provider is assigned. Join the actual late assignment too.
      // Failure order is first synchronous stop failure, initial provider,
      // initial capture, late provider, late capture, tab release, tab join,
      // worker, startup. Resolution order cannot skip a join or
      // change which error is reported. The same resource is never reclosed.
      results.push(...await Promise.allSettled([
        this.#provider !== initialProvider ? joinClose(() => this.#provider?.close()) : undefined,
        this.#capture !== initialCapture ? joinClose(() => this.#capture?.close()) : undefined,
      ]))
      results.push(...await Promise.allSettled([joinClose(() => this.#releaseTab?.())]))
      this.#releaseTab = undefined
      results.push(...await Promise.allSettled([this.#lockWork]))
      results.push(...await Promise.allSettled([this.#workerClose]))
      results.push(...await Promise.allSettled([joinClose(() => this.#startupClose ??= this.#startup.close())])) // MIGRATION last.
      if (this.#stopFailure) throw this.#stopFailure.error
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })().then(resolve, reject)
    return this.#closing
  }
}

let started: Promise<void> | undefined
let actualRoot: ExistingRoot | undefined
/** Unmounted existing-member checkpoint only. No root, owner, image, selector,
 * key, provider, signer or current-authority capability is returned. */
export function prepareOrdinaryPrivateExistingRoot(): Promise<void> {
  if (started) return started
  try { actualRoot = new ExistingRoot(); started = actualRoot.start() }
  catch { started = Promise.resolve(); document.documentElement.dataset.ordinaryProtectedStartup = 'held' }
  return started
}

/** Unmounted current-provider discovery checkpoint. All native/SDK objects
 * remain private; no member session, carrier or UI is activated. */
export function restoreOrdinaryPrivateExistingProviderRoot(): Promise<void> {
  // A cold checkpoint call waits for capture, then invokes construction
  // synchronously. Capture readiness supplies timing only, never consent.
  return prepareOrdinaryPrivateExistingRoot().then(() => actualRoot?.restoreProvider())
}

/** Unmounted complete-member entry under construction. It publishes only its
 * native view; no root/owner/provider/selection authority is returned. */
export function prepareOrdinaryPrivateMemberRoot(): Promise<void> {
  try {
    actualRoot ??= new ExistingRoot()
    const opening = actualRoot.prepareMember() // Fix trusted mode synchronously.
    started ??= actualRoot.start()
    return opening
  } catch {
    document.documentElement.dataset.ordinaryProtectedStartup = 'held'
    return Promise.resolve()
  }
}
