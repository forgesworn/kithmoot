/**
 * The built-in call relay's channels between the page and the main process.
 *
 * Every channel answers only the app's own trusted main frame (`allowed`),
 * takes no argument the main process does not check, and hands the page
 * nothing but the relay's state. Secrets and the pairing's key never come
 * back for display. The person's consent is the page's own dialog; the main
 * process still owns starting, stopping and the relay itself.
 */
export const RELAY_CHANNELS = Object.freeze({
  context: 'desktop:spry-relay-context',
  state: 'desktop:spry-relay-state',
  start: 'desktop:spry-relay-start',
  stop: 'desktop:spry-relay-stop',
  startOnOpen: 'desktop:spry-relay-start-on-open',
  removeKeys: 'desktop:spry-relay-remove-keys',
})

/**
 * @param {{ ipcMain: { on: Function, handle: Function },
 *   hosting: { setContext: Function, start: Function, stop: Function, setStartOnOpen: Function, removeKeys: Function },
 *   allowed: (event: unknown) => boolean, view: () => unknown }} options
 */
export function registerRelayIpc({ ipcMain, hosting, allowed, view }) {
  ipcMain.on(RELAY_CHANNELS.context, (event, value) => { if (allowed(event)) hosting.setContext(value) })
  ipcMain.handle(RELAY_CHANNELS.state, event => allowed(event) ? view() : null)
  // Turn on is the person's own, so the relay is wanted from here. Progress
  // arrives as state, not as this call's answer, which can take a minute.
  ipcMain.handle(RELAY_CHANNELS.start, event => {
    if (!allowed(event)) return false
    void hosting.start({ person: true })
    return true
  })
  ipcMain.handle(RELAY_CHANNELS.stop, async event => allowed(event) ? await hosting.stop() === true : false)
  ipcMain.handle(RELAY_CHANNELS.startOnOpen, async (event, on) => {
    if (!allowed(event) || typeof on !== 'boolean') return false
    await hosting.setStartOnOpen(on)
    return true
  })
  ipcMain.handle(RELAY_CHANNELS.removeKeys, async event => allowed(event) ? await hosting.removeKeys() === true : false)
}
