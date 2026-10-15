import type { BrowserContext, Page, TestInfo } from '@playwright/test'

/** Opt-in observation for the unresolved WebKit board-opening failure. This
 * observes each document from creation, without a command inserted between
 * joining and the original click. It never opens a panel or grants acceptance. */
export async function installBoardOpenDiagnostic(context: BrowserContext): Promise<void> {
  context.on('page', page => {
    page.on('pageerror', error => console.error('Board open page error:', error.name, error.message.slice(0, 512)))
    page.on('console', message => {
      if (message.text().startsWith('BOARD_OPEN_DIAGNOSTIC ')) console.log(message.text())
    })
  })
  await context.addInitScript(() => {
    const events: unknown[] = []
    let sequence = 0
    const state = () => {
      const panel = document.getElementById('boardsPanel')
      const button = document.getElementById('openAssignments') as HTMLButtonElement | null
      const room = document.getElementById('roomArea')
      const signIn = document.getElementById('homeSignIn')
      const bounds = button?.getBoundingClientRect()
      return { ready: document.readyState, startup: document.documentElement?.dataset.ordinaryStartup ?? null,
        switching: document.documentElement?.dataset.roomSwitching ?? null,
        signInHidden: signIn?.hidden ?? null, roomHidden: room?.hidden ?? null, roomInert: room?.inert ?? null,
        active: document.activeElement?.id ?? null, panelExists: !!panel,
        panelOpen: panel instanceof HTMLDialogElement ? panel.open : null,
        frames: panel?.querySelectorAll('iframe').length ?? 0,
        button: button && { disabled: button.disabled, text: button.textContent?.slice(0, 80),
          expanded: button.getAttribute('aria-expanded'), controls: button.getAttribute('aria-controls'),
          bounds: bounds && {x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height} } }
    }
    const mark = (kind: string, detail?: unknown) => {
      const record = { sequence: ++sequence, kind, at: performance.now(), detail, state: state() }
      events.push(record)
      if (events.length > 128) events.shift()
      if (sequence <= 512) console.log('BOARD_OPEN_DIAGNOSTIC ' + JSON.stringify(record))
    }
    const capture = (event: Event) => {
      const id = (target: EventTarget | null) => target instanceof Element ? target.id || target.tagName : null
      const input = event as MouseEvent
      mark('window-capture-' + event.type, { trusted: event.isTrusted, defaultPrevented: event.defaultPrevented,
        target: id(event.target), path: event.composedPath().slice(0, 8).map(id),
        x: input.clientX, y: input.clientY, hit: id(document.elementFromPoint(input.clientX, input.clientY)) })
    }
    for (const name of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) window.addEventListener(name, capture, true)
    // Observe entry before the actual app listener stops propagation. Only
    // this anonymous, never-removed capture handler is wrapped; it receives
    // the identical event/receiver exactly once, and throws are preserved.
    const descriptor = Object.getOwnPropertyDescriptor(EventTarget.prototype, 'addEventListener')!
    const add = descriptor.value as typeof EventTarget.prototype.addEventListener
    Object.defineProperty(EventTarget.prototype, 'addEventListener', { ...descriptor,
      value: function(this: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions) {
        if (this instanceof HTMLButtonElement && this.id === 'openAssignments' && type === 'click' &&
            typeof listener === 'function' && (options === true || typeof options === 'object' && options.capture === true)) {
          mark('app-handler-registered')
          const actual = listener
          listener = function(this: EventTarget, event: Event) {
            mark('app-handler-entry', {trusted: event.isTrusted})
            try {const result = Reflect.apply(actual, this, [event]); mark('app-handler-return'); return result}
            catch (error) {mark('app-handler-throw', error instanceof Error ? {name: error.name, message: error.message.slice(0, 512), stack: error.stack?.slice(0, 2048)} : typeof error); throw error}
          }
        }
        return Reflect.apply(add, this, [type, listener, options])
      } })
    for (const name of ['showModal', 'close'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)!
      const actual = descriptor.value as (...args: unknown[]) => unknown
      Object.defineProperty(HTMLDialogElement.prototype, name, { ...descriptor,
        value: function (this: HTMLDialogElement, ...args: unknown[]) {
          if (this.id !== 'boardsPanel') return Reflect.apply(actual, this, args)
          mark(name + '-entry')
          try { const result = Reflect.apply(actual, this, args); mark(name + '-return'); return result }
          catch (error) { mark(name + '-throw', error instanceof Error ? error.name : typeof error); throw error }
        } })
    }
    const error = (event: ErrorEvent) => mark('error', { name: event.error?.name ?? null, message: event.message.slice(0, 512) })
    const rejection = (event: PromiseRejectionEvent) => mark('unhandled-rejection', {
      name: event.reason instanceof Error ? event.reason.name : typeof event.reason,
      message: event.reason instanceof Error ? event.reason.message.slice(0, 512) : null,
    })
    window.addEventListener('error', error)
    window.addEventListener('unhandledrejection', rejection)
    const observer = new MutationObserver(records => {
      if (records.some(record => record.target instanceof Element &&
          (record.target === document.documentElement || ['roomArea', 'openAssignments', 'boardsPanel'].includes(record.target.id) || record.target.closest('#boardsPanel')))) mark('panel-or-button-mutation')
    })
    const observe = () => observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['open', 'hidden', 'inert', 'disabled', 'aria-expanded', 'aria-controls', 'data-room-switching', 'data-ordinary-startup'] })
    if (document.documentElement) observe()
    else document.addEventListener('DOMContentLoaded', observe, {once: true})
    ;(window as any).__boardOpenDiagnostic = () => ({ state: state(), sequence, events: [...events] })
    mark('installed')
  })
}

export async function captureBoardOpenDiagnostic(page: Page, info: TestInfo, phase: string): Promise<void> {
  const report = await page.evaluate(() => (window as any).__boardOpenDiagnostic())
  console.log('BOARD_OPEN_DIAGNOSTIC_SNAPSHOT ' + phase + ' ' + JSON.stringify(report))
  await info.attach('board-open-' + phase, { body: Buffer.from(JSON.stringify(report, null, 2)), contentType: 'application/json' })
}
