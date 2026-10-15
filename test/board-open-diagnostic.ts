import type { Page, TestInfo } from '@playwright/test'

/** Opt-in observation for the unresolved WebKit board-opening failure. This
 * does not sign, retry a click, open a panel or grant an acceptance result. */
export async function installBoardOpenDiagnostic(page: Page): Promise<void> {
  page.on('pageerror', error => console.error('Board open page error:', error.name, error.message.slice(0, 512)))
  page.on('console', message => {
    if (message.text().startsWith('BOARD_OPEN_DIAGNOSTIC ')) console.log(message.text())
  })
  await page.evaluate(() => {
    const events: unknown[] = []
    const state = () => {
      const panel = document.getElementById('boardsPanel')
      const button = document.getElementById('openAssignments') as HTMLButtonElement | null
      const room = document.getElementById('roomArea')
      const signIn = document.getElementById('homeSignIn')
      return { ready: document.readyState, path: location.pathname, hasFragment: !!location.hash,
        signInHidden: signIn?.hidden ?? null, roomHidden: room?.hidden ?? null, roomInert: room?.inert ?? null,
        active: document.activeElement?.id ?? null, panelExists: !!panel,
        panelOpen: panel instanceof HTMLDialogElement ? panel.open : null,
        frames: panel?.querySelectorAll('iframe').length ?? 0,
        button: button && { disabled: button.disabled, text: button.textContent?.slice(0, 80),
          expanded: button.getAttribute('aria-expanded'), controls: button.getAttribute('aria-controls') } }
    }
    const mark = (kind: string, detail?: unknown) => {
      if (events.length >= 128) return
      const record = { kind, at: performance.now(), detail, state: state() }
      events.push(record)
      console.log('BOARD_OPEN_DIAGNOSTIC ' + JSON.stringify(record))
    }
    const capture = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('#openAssignments')) {
        mark('window-capture-' + event.type, { trusted: event.isTrusted, defaultPrevented: event.defaultPrevented })
      }
    }
    for (const name of ['pointerdown', 'pointerup', 'click']) window.addEventListener(name, capture, true)
    // The application target listener was installed first and calls
    // stopImmediatePropagation before opening. Reaching this later listener
    // distinguishes a click that did not pass through that handler.
    document.getElementById('openAssignments')?.addEventListener('click', () => mark('late-target-click'), true)
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
          (record.target.id === 'openAssignments' || record.target.id === 'boardsPanel' || record.target.closest('#boardsPanel')))) mark('panel-or-button-mutation')
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['open', 'hidden', 'inert', 'disabled', 'aria-expanded', 'aria-controls'] })
    ;(window as any).__boardOpenDiagnostic = () => ({ state: state(), events: [...events] })
    mark('installed')
  })
}

export async function captureBoardOpenDiagnostic(page: Page, info: TestInfo, phase: string): Promise<void> {
  const report = await page.evaluate(() => (window as any).__boardOpenDiagnostic())
  console.log('BOARD_OPEN_DIAGNOSTIC_SNAPSHOT ' + phase + ' ' + JSON.stringify(report))
  await info.attach('board-open-' + phase, { body: Buffer.from(JSON.stringify(report, null, 2)), contentType: 'application/json' })
}
