import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openSettings } from './browser.js'

/**
 * The built-in call relay's row, page, Turn on dialog, outside check picker
 * and Relay on rail item (K5, spec 12.1). The page runs in the desktop build
 * with a stub of `window.kithmootDesktop` that reports whatever state a test
 * pushes and records what the page asks the main process to do. Without the
 * stub there is no relay on the page at all.
 *
 * RELAY_SHOTS_DIR=<dir> also writes the screenshots the owner reviews.
 */

type State = Record<string, unknown>
const LIMIT = 5_000_000_000
const off: State = { available: true, blocked: false, wanted: false, startOnOpen: false, today: 0, dailyLimit: LIMIT, status: 'off' }
const running: State = { ...off, wanted: true, status: 'running', control: { relays: 2 }, counts: { allocations: 0, bytesRelayed: 0, lastAllocation: null },
  mapping: { method: 'upnp', allocationPorts: 10, requested: 10, permanent: false, restored: 0 } }
const failed = (code: string, wanted = false, extra: State = {}): State => ({ ...off, wanted, status: 'failed', error: { code, message: 'LEAK: never shown' }, ...extra })
const inUse: State = { ...running, today: 1_200_000_000, counts: { allocations: 3, bytesRelayed: 1_200_000_000, lastAllocation: null } }

interface Options {
  state?: State
  stub?: boolean
  scheme?: 'light' | 'dark'
  size?: 'standard' | 'large' | 'huge'
  viewport?: { width: number; height: number }
  hideIp?: boolean
  forcedColors?: boolean
  contrast?: boolean
}

async function launch(browser: Browser, baseURL: string, options: Options = {}): Promise<{ context: BrowserContext; page: Page }> {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: options.viewport ?? { width: 1280, height: 800 },
    colorScheme: options.scheme ?? 'light', ...(options.forcedColors ? { forcedColors: 'active' as const } : {}), ...(options.contrast ? { contrast: 'more' as const } : {}) })
  await context.routeWebSocket(url => url.protocol === 'wss:' && url.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  await context.addInitScript(({ size, hideIp }) => {
    if (size && size !== 'standard') localStorage.setItem('kithmoot.textSize', size)
    if (hideIp) localStorage.setItem('kithmoot.hide-ip.v1', '1')
  }, { size: options.size, hideIp: options.hideIp })
  if (options.stub !== false) {
    await context.addInitScript(initial => {
      const listeners: Array<(value: unknown) => void> = []
      const calls = { start: 0, stop: 0, startOnOpen: [] as boolean[], removeKeys: 0, asked: [] as string[] }
      let current = initial
      let menuListener: ((command: string) => void) | undefined
      Object.assign(window, {
        __relayCalls: calls,
        __menuCommand: (command: string) => menuListener?.(command),
        __relayState: (next: unknown) => { current = next as typeof initial; for (const listener of listeners) listener({ state: current, pairing: null }) },
        __kithmootRelayCheckStub: {
          roomName: "Reading room",
          candidates: [{ device: 'own-1', label: 'Your other device', who: 'your other device' }, { device: 'alex-1', label: 'Alex', who: 'Alex' }],
          outcome: { answered: true, ok: true },
          ask(this: { outcome: unknown }, device: string) { calls.asked.push(device); return Promise.resolve(this.outcome) },
        },
      })
      const known: Record<string, unknown> = {
        updateState: async () => ({ phase: 'disabled' }), installUpdate: async () => false,
        relayState: async () => ({ state: current, pairing: null }),
        onMenuCommand: (listener: (command: string) => void) => { menuListener = listener; return () => {} },
        onRelayState: (listener: (value: unknown) => void) => { listeners.push(listener); return () => {} },
        relayStart: async () => { calls.start++; return true },
        relayStop: async () => { calls.stop++; return true },
        relaySetStartOnOpen: async (on: boolean) => { calls.startOnOpen.push(on); return true },
        relayRemoveKeys: async () => { calls.removeKeys++; return true },
      }
      Object.assign(window, { kithmootDesktop: new Proxy(known, {
        get: (target, key) => key in target ? target[key as string]
          : String(key).startsWith('supports') || key === 'shareAreaMode' ? undefined
          : String(key).startsWith('on') ? () => () => {} : () => undefined,
      }) })
    }, options.state ?? off)
  }
  const page = await context.newPage()
  await page.goto(baseURL)
  return { context, page }
}

const push = (page: Page, state: State) => page.evaluate(next => (window as unknown as { __relayState(s: unknown): void }).__relayState(next), state)
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __relayCalls: { start: number; stop: number; startOnOpen: boolean[]; removeKeys: number; asked: string[] } }).__relayCalls)
async function openRelayPage(page: Page): Promise<void> {
  await openSettings(page, 'Connections')
  await page.locator('#settingsRowCallRelay').click()
  await expect(page.locator('#settingsTitle')).toHaveText('Call relay on this computer')
}
const page$ = (page: Page) => ({
  head: page.locator('#relayRunning'), reachable: page.locator('#relayReachable'), use: page.locator('#relayUse'),
  toggle: page.locator('#relayToggle'), check: page.locator('#relayCheck'), soo: page.locator('#relayStartOnOpen'),
  details: page.locator('#relayDetails'), row: page.locator('#settingsRowCallRelay'), sub: page.locator('#settingsSubCallRelay'), rail: page.locator('#railRelay'),
})
const INTRO = "When two people can't connect directly, a call relay passes their encrypted audio and video along. Turn this on to let people in rooms you made use this computer as their relay. It uses your upload bandwidth while they're on a call, and they'll see your internet address. You run it, and you can stop it at any time."

test('without the desktop app (no bridge), Settings > Connections has no call relay row', async ({ browser, baseURL }) => {
  const { context, page } = await launch(browser, baseURL!, { stub: false })
  try {
    await openSettings(page, 'Connections')
    await expect(page.locator('#settingsRowCallRelay')).toBeHidden()
    await expect(page.locator('#railRelay')).toBeHidden()
  } finally { await context.close() }
})

test('the row reads "Call relay on this computer", Off, only when the relay is available', async ({ browser, baseURL }) => {
  const { context, page } = await launch(browser, baseURL!, { state: { ...off, available: false } })
  try {
    await openSettings(page, 'Connections')
    await expect(page.locator('#settingsRowCallRelay')).toBeHidden()
    await push(page, off)
    const p = page$(page)
    await expect(p.row).toBeVisible()
    await expect(p.row.locator('.infoRowTitle')).toHaveText('Call relay on this computer')
    await expect(p.sub).toHaveText('Off')
    // Directly after Bothy connection, in the same group.
    const ids = await page.locator('[data-settings-page="connections"] .infoRows > button:not([hidden])').evaluateAll(rows => rows.map(row => row.id))
    expect(ids.slice(ids.indexOf('bothySettingsOpen'), ids.indexOf('bothySettingsOpen') + 2)).toEqual(['bothySettingsOpen', 'settingsRowCallRelay'])
  } finally { await context.close() }
})

test('Off page: title, Off, the intro, one Turn on button, no checkbox and no Details', async ({ browser, baseURL }) => {
  const { context, page } = await launch(browser, baseURL!)
  try {
    await openRelayPage(page)
    const p = page$(page)
    await expect(p.head).toHaveText('Off')
    await expect(p.reachable).toHaveText(INTRO)
    await expect(p.use).toHaveText('')
    await expect(p.toggle).toHaveText('Turn on…')
    await expect(p.toggle).toHaveClass(/primary/)
    await expect(p.check).toBeHidden()
    await expect(p.soo).toBeHidden()
    await expect(p.details).toBeHidden()
    await expect(page.locator('#settingsPane [data-settings-page="callRelay"] button:visible')).toHaveCount(1)
  } finally { await context.close() }
})

test('Turn on asks first with Cancel in focus; Enter cancels and the relay is not started', async ({ browser, baseURL }) => {
  const { context, page } = await launch(browser, baseURL!)
  try {
    await openRelayPage(page)
    const p = page$(page)
    await p.toggle.click()
    const dialog = page.getByRole('alertdialog', { name: 'Turn on the call relay on this computer?' })
    await expect(dialog).toBeVisible()
    await expect(page.locator('#actionCancel')).toBeFocused()
    await expect(dialog).toContainText("They'll see your internet address. It uses your upload bandwidth, up to 5 GB a day.")
    await expect(dialog).toContainText("Check that the laws that apply to you and your internet provider's terms allow it.")
    await expect(dialog).not.toContainText("Hide my IP address doesn't hide your address")
    await page.keyboard.press('Enter')
    await expect(dialog).toBeHidden()
    expect((await calls(page)).start).toBe(0)
    await expect(p.toggle).toBeFocused()
  } finally { await context.close() }
})

test('Turn on, confirmed, starts the relay once and focus comes back to the control, now Stop', async ({ browser, baseURL }) => {
  const { context, page } = await launch(browser, baseURL!)
  try {
    await openRelayPage(page)
    const p = page$(page)
    await p.toggle.click()
    await expect(page.locator('#actionCancel')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.locator('#actionConfirm')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('#actionDialog')).toHaveCount(0)
    expect((await calls(page)).start).toBe(1)
    await push(page, { ...off, wanted: true, status: 'starting' })
    await expect(p.toggle).toHaveText('Stop')
    await expect(p.toggle).toBeFocused()
    await expect(p.toggle).not.toHaveClass(/primary|danger/)
    await expect(p.toggle).not.toHaveAttribute('aria-pressed', /.*/)
    await p.toggle.click()
    expect((await calls(page)).stop).toBe(1)
  } finally { await context.close() }
})

test('with Hide my IP on, the dialog says it does not hide the address from people who use the relay', async ({ browser, baseURL }) => {
  for (const hideIp of [true, false]) {
    const { context, page } = await launch(browser, baseURL!, { hideIp })
    try {
      await openRelayPage(page)
      await page$(page).toggle.click()
      const dialog = page.getByRole('alertdialog')
      await expect(dialog).toBeVisible()
      const line = "Hide my IP address doesn't hide your address from people who use your relay."
      if (hideIp) await expect(dialog).toContainText(line)
      else await expect(dialog).not.toContainText(line)
    } finally { await context.close() }
  }
})

test.describe('every state says what the spec says', () => {
  test.describe.configure({ mode: 'serial' })
  let context: BrowserContext
  let page: Page
  test.beforeAll(async ({ browser, baseURL }) => { ({ context, page } = await launch(browser, baseURL!)); await openRelayPage(page) })
  test.afterAll(async () => { await context.close() })

  const rows: Array<[string, State, string, string | undefined, string | undefined, string, string]> = [
    ['S1', off, 'Off', INTRO, undefined, 'Turn on…', 'Off'],
    ['S13', { ...off, startOnOpen: true }, 'Off. It starts next time KithMoot opens.', INTRO, undefined, 'Turn on…', 'Off · starts when KithMoot opens'],
    ['S3', { ...off, wanted: true, status: 'starting' }, 'Starting…', 'Setting up your router. This can take up to a minute.', undefined, 'Stop', 'Starting…'],
    ['S4', running, 'Running on this computer', 'Not checked from outside yet', 'Not used yet · Relayed today: 0 MB of 5 GB', 'Stop', 'On'],
    ['S5', inUse, 'Running on this computer', 'Not checked from outside yet', 'In use now · Relayed today: 1.2 GB of 5 GB', 'Stop', 'On · in use now'],
    ['S14', { ...running, control: { relays: 0 } }, 'Running, waiting for your Nostr relays', 'Nobody can use it until KithMoot reaches at least one of your Nostr relays.', 'Not used yet · Relayed today: 0 MB of 5 GB', 'Stop', 'On · waiting for Nostr relays'],
    ['S11', { ...off, wanted: true }, 'Waiting for a network', 'It starts when this computer is back online.', undefined, 'Stop', 'Waiting for a network'],
    ['S7x', { ...off, status: 'cannot-host', reason: 'vpn' }, "Can't run on this network", "A VPN is on. People can't reach a relay behind it.", undefined, 'Turn on…', "Can't run on this network"],
    ['S8a', failed('ERR_RELAY_EXITED', true), 'The relay stopped unexpectedly', 'Starting it again…', undefined, 'Stop', 'Restarting…'],
    ['S8b', failed('ERR_CRASHED_TWICE'), 'Stopped', 'The relay stopped unexpectedly twice, so it was left off.', 'Turn it on again to try once more. If it keeps stopping, restart KithMoot.', 'Turn on…', 'Stopped'],
    ['S8c', failed('ERR_START_FAILED'), 'Stopped', "The relay couldn't start.", 'Try turning it on again.', 'Turn on…', 'Stopped'],
    ['S8d', failed('ERR_HELPER'), 'Stopped', 'Part of KithMoot that runs the relay is missing or damaged.', 'Reinstall KithMoot from kithmoot.app, then try again.', 'Turn on…', 'Stopped'],
    ['S8e', failed('ERR_STOP_TIMEOUT'), 'Still stopping', "The relay hasn't stopped yet. Press Stop again.", undefined, 'Stop', 'Stopping…'],
    ['S8f', failed('ERR_RELAY_EXITED'), 'Stopped', 'The relay stopped unexpectedly.', 'Try turning it on again.', 'Turn on…', 'Stopped'],
    ['S8g', failed('ERR_SOMETHING_ELSE'), 'Stopped', "The relay couldn't start.", 'Try turning it on again.', 'Turn on…', 'Stopped'],
    ['S8h', failed('ERR_IDENTITY'), 'Stopped', "The relay's saved keys couldn't be read. This happens after switching between builds of KithMoot.", undefined, 'Remove keys…', 'Stopped'],
    ['S9', failed('ERR_DAILY_LIMIT', true), 'Paused for today', "Today's limit of 5 GB is used up.", 'It starts again after midnight.', 'Stop', 'Paused until midnight'],
    ['S10a', failed('ERR_HAND_PAIRED'), 'You already use your own Spry relay', "Your calls go through your Spry node, so this computer's relay stays off. To use this one instead, unpair Spry on the Connections page.", undefined, '', 'Not used: you have Spry'],
    ['S10b', failed('ERR_NO_ACCOUNT'), 'Stopped', 'Start or open a room first, so the relay knows whose rooms it serves.', undefined, 'Turn on…', 'Off'],
    ['S10c', failed('ERR_OTHER_ACCOUNT'), 'Stopped', "This computer's relay is set up for another account you use here. Switch to that account to use it.", undefined, 'Turn on…', 'Off'],
    ['S10d', failed('ERR_NO_CONTROL_RELAYS'), 'Stopped', 'None of your Nostr relays can carry requests for the call relay. Add one whose address starts with wss:// and uses a domain name, in Nostr relays.', undefined, 'Turn on…', 'Off'],
    ['S12', { ...running, status: 'stopping' }, 'Stopping…', '', undefined, 'Stopping…', 'Stopping…'],
  ]
  for (const [id, state, line1, line2, line3, control, rowSub] of rows) {
    test(`${id}`, async () => {
      await push(page, state)
      const p = page$(page)
      await expect(p.head).toHaveText(line1)
      await expect(p.reachable).toHaveText(line2 ?? '')
      await expect(p.use).toHaveText(line3 ?? '')
      if (control) { await expect(p.toggle).toBeVisible(); await expect(p.toggle).toHaveText(control) } else await expect(p.toggle).toBeHidden()
      if (control === 'Stopping…') await expect(p.toggle).toBeDisabled()
      await expect(p.sub).toHaveText(rowSub)
      await expect(page.locator('#settingsPane')).not.toContainText('LEAK')
    })
  }

  const reasons: Array<[string, string]> = [
    ['no-gateway', 'This computer has no route to the internet.'],
    ['vpn', "A VPN is on. People can't reach a relay behind it."],
    ['wrong-interface', 'This computer reaches its router through another connection. It tries again once the network settles.'],
    ['no-answer', "Your router didn't allow automatic setup. Turn on UPnP in its settings, or ask whoever runs your network."],
    ['refused', 'Your router refused to open what the relay needs.'],
    ['failed', "Your router couldn't open what the relay needs."],
    ['carrier-grade-nat', 'Your internet provider shares one address between many customers, so nothing outside can reach this computer.'],
    ['double-nat', "There's a second router between you and the internet. Automatic setup can't open it."],
    ['unusable-address', "Your router reported an internet address people can't reach."],
    ['too-few-ports', 'Your router opened too little for the relay to work.'],
    ['record', "The relay couldn't save its list of router openings, so it gave them back."],
    ['expired', "Your router dropped the relay and wouldn't take it back."],
    ['something-new', "This network can't host a call relay."],
  ]
  for (const [reason, words] of reasons) {
    test(`S7 ${reason}`, async () => {
      await push(page, { ...off, wanted: true, status: 'cannot-host', reason, reasonText: 'LEAK: never shown' })
      const p = page$(page)
      await expect(p.head).toHaveText("Can't run on this network")
      await expect(p.reachable).toHaveText(words)
      await expect(p.use).toHaveText('It tries again when this computer joins another network.')
      await expect(p.toggle).toHaveText('Stop')
      await expect(p.sub).toHaveText("Can't run on this network")
      await expect(page.locator('#settingsPane')).not.toContainText(/\bports?\b|PCP|NAT-PMP|LEAK/)
    })
  }

  test('S8h asks before it removes the keys', async () => {
    await push(page, failed('ERR_IDENTITY'))
    const p = page$(page)
    await p.toggle.click()
    const dialog = page.getByRole('alertdialog', { name: "Remove the relay's saved keys?" })
    await expect(dialog).toContainText('The relay starts afresh with new keys. People will use its new address the next time they open your rooms.')
    await expect(page.locator('#actionCancel')).toBeFocused()
    await page.keyboard.press('Escape')
    expect((await calls(page)).removeKeys).toBe(0)
    await p.toggle.click()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await calls(page)).removeKeys).toBe(1)
  })
})

test('in use, nothing prints a people count or an address; Details has the connections and the router words', async ({ browser, baseURL }) => {
  const { context, page } = await launch(browser, baseURL!, { state: { ...inUse, urls: ['turn:203.0.113.7:30000?transport=udp'], endpoint: 'spry://' + 'c'.repeat(64), pairing: 'p'.repeat(43), local: { host: '192.168.1.20', port: 30000 } } })
  try {
    await openRelayPage(page)
    const p = page$(page)
    await p.details.locator('summary').click()
    await expect(p.details).toContainText('Connections now: 3')
    await expect(p.details).toContainText('Router: opened automatically using UPnP')
    await expect(p.details).toContainText('Openings on your router: 10 of 10')
    await expect(p.details).toContainText('Nostr relays: connected')
    await expect(p.details).toContainText("Daily limit: 5 GB. When it's reached, the relay pauses until midnight.")
    const text = await page.locator('#settingsPane').innerText()
    expect(text).not.toMatch(/\d\s+people/i)
    expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/)
    expect(text).not.toMatch(/spry:|turn:|[0-9a-f]{64}/)
    await expect(page.locator('#relayNote')).toContainText('They see your internet address.')
  } finally { await context.close() }
})

test('the live regions are there before the first state, and the control has no pressed state', async ({ browser, baseURL }) => {
  const { context, page } = await launch(browser, baseURL!, { stub: false })
  try {
    for (const id of ['relayRunning', 'relayReachable']) await expect(page.locator(`#${id}`)).toHaveAttribute('role', 'status')
    await expect(page.locator('#relayUse')).toHaveAttribute('aria-live', 'off')
    await expect(page.locator('#relayToggle')).not.toHaveAttribute('aria-pressed', /.*/)
    await expect(page.locator('#relayRunning')).toHaveText('')
  } finally { await context.close() }
})

test.describe('the outside check', () => {
  test('is offered for a room that shares the relay, names the room and starts with your other device', async ({ browser, baseURL }) => {
    const { context, page } = await launch(browser, baseURL!, { state: running })
    try {
      await openRelayPage(page)
      const p = page$(page)
      await expect(p.reachable).toHaveText('Not checked from outside yet')
      await expect(p.check).toHaveText('Check from another device…')
      await p.check.click()
      const dialog = page.getByRole('dialog', { name: 'Check from another device' })
      await expect(dialog).toContainText("Pick someone in Reading room.")
      const radios = dialog.getByRole('radio')
      await expect(radios).toHaveCount(2)
      await expect(dialog.getByRole('radio', { name: 'Your other device' })).toBeChecked()
      await expect(dialog.getByRole('radio', { name: 'Alex' })).not.toBeChecked()
      await expect(dialog.getByRole('group', { name: 'Device to check from' })).toBeVisible()
      await dialog.getByRole('button', { name: 'Check', exact: true }).click()
      await expect(p.reachable).toHaveText(/^Reachable, checked from your other device at \d\d:\d\d$/)
      expect((await calls(page)).asked).toEqual(['own-1'])
      await expect(p.check).toHaveText('Check from another device…')
    } finally { await context.close() }
  })

  test('shows the checking state while it waits, and each outcome in the spec\'s words', async ({ browser, baseURL }) => {
    const { context, page } = await launch(browser, baseURL!, { state: running })
    try {
      await openRelayPage(page)
      const p = page$(page)
      const outcomes: Array<[unknown, RegExp]> = [
        [{ answered: true, ok: true, sameNetwork: true }, /^Not proved yet: Alex is on the same network as this computer\./],
        [{ answered: true, ok: false, stage: 'inbound' }, /^Opened on your router, but people still can't reach it \(checked from Alex at \d\d:\d\d\)$/],
        [{ answered: true, ok: false, stage: 'allocate' }, /^Can't be reached from Alex's network \(checked at \d\d:\d\d\)$/],
        [{ answered: true, ok: false, stage: 'declined' }, /^Alex couldn't check just now\./],
        [{ answered: true, ok: false, stage: 'credentials' }, /^Your relay didn't let Alex in/],
        [{ answered: false }, /^No answer from Alex\. Check that KithMoot is open on that device\.$/],
      ]
      for (const [outcome, line] of outcomes) {
        await page.evaluate(next => { (window as unknown as { __kithmootRelayCheckStub: { outcome: unknown } }).__kithmootRelayCheckStub.outcome = next }, outcome)
        await p.check.click()
        await page.getByRole('radio', { name: 'Alex' }).check()
        await page.getByRole('button', { name: 'Check', exact: true }).click()
        await expect(p.reachable).toHaveText(line)
        await expect(p.reachable).not.toHaveText(/^Reachable/)
        if ((outcome as { stage?: string }).stage === 'inbound') await expect(p.details).toContainText(/Last check: from Alex at \d\d:\d\d, stopped at the inbound step/)
      }
    } finally { await context.close() }
  })

  test('is not offered with nobody to ask, and says how to check', async ({ browser, baseURL }) => {
    const { context, page } = await launch(browser, baseURL!, { state: running })
    try {
      await openRelayPage(page)
      const p = page$(page)
      await page.evaluate(() => { (window as unknown as { __kithmootRelayCheckStub: { candidates: unknown[] } }).__kithmootRelayCheckStub.candidates = [] })
      await push(page, running)
      await expect(p.check).toBeHidden()
      await expect(p.reachable).toHaveText('Not checked from outside yet. To check, open a room you made that your phone or a friend is in.')
    } finally { await context.close() }
  })

  test('a result is forgotten when the relay restarts', async ({ browser, baseURL }) => {
    const { context, page } = await launch(browser, baseURL!, { state: running })
    try {
      await openRelayPage(page)
      const p = page$(page)
      await p.check.click()
      await page.getByRole('button', { name: 'Check', exact: true }).click()
      await expect(p.reachable).toHaveText(/^Reachable, checked from/)
      await push(page, { ...off, wanted: true, status: 'starting' })
      await push(page, running)
      await expect(p.reachable).toHaveText('Not checked from outside yet')
    } finally { await context.close() }
  })
})

test('Start it when KithMoot opens is sent once, and comes back ticked under Turn on', async ({ browser, baseURL }) => {
  const { context, page } = await launch(browser, baseURL!, { state: running })
  try {
    await openRelayPage(page)
    const p = page$(page)
    await expect(p.soo).not.toBeChecked()
    await p.soo.check()
    await expect.poll(async () => (await calls(page)).startOnOpen).toEqual([true])
    await push(page, { ...off, startOnOpen: true })
    await expect(p.head).toHaveText('Off. It starts next time KithMoot opens.')
    await expect(p.soo).toBeChecked()
    await expect(p.toggle).toHaveText('Turn on…')
  } finally { await context.close() }
})

test('Relay on sits in the rail above Settings while starting or running, and opens the page', async ({ browser, baseURL }) => {
  const { context, page } = await launch(browser, baseURL!, { state: inUse })
  try {
    await page.locator('#openAppSettings').waitFor()
    const p = page$(page)
    await expect(p.rail).toBeVisible()
    await expect(p.rail).toHaveText('Relay on')
    await expect(p.rail).toHaveAttribute('aria-label', 'Call relay on')
    await expect(p.rail).not.toHaveAttribute('data-destination', /.*/)
    await expect(p.rail).not.toHaveAttribute('aria-current', /.*/)
    const [relayBox, settingsBox] = [await p.rail.boundingBox(), await page.locator('#openAppSettings').boundingBox()]
    expect(relayBox!.y).toBeLessThan(settingsBox!.y)
    await p.rail.click()
    await expect(page.locator('#settingsTitle')).toHaveText('Call relay on this computer')
    await expect(p.head).toHaveText('Running on this computer')
    for (const state of [{ ...off, wanted: true, status: 'starting' }, running, { ...running, control: { relays: 0 } }]) { await push(page, state); await expect(p.rail).toBeVisible() }
    for (const state of [off, { ...off, status: 'cannot-host', reason: 'vpn' }, failed('ERR_START_FAILED'), { ...running, status: 'stopping' }]) { await push(page, state); await expect(p.rail).toBeHidden() }
    // Back goes to Connections, as every page under it does.
    await page.locator('#settingsBack').click()
    await expect(page.locator('#settingsTitle')).toHaveText('Connections')
  } finally { await context.close() }
})

test('the keyboard walks the page in order, with no trap', async ({ browser, baseURL }) => {
  const { context, page } = await launch(browser, baseURL!, { state: inUse })
  try {
    await openRelayPage(page)
    await page.locator('#settingsBack').focus()
    const seen: string[] = []
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab')
      seen.push(await page.evaluate(() => { const a = document.activeElement!; return a.id || (a.tagName === 'SUMMARY' && a.closest('#relayDetails') ? 'details' : a.tagName) }))
    }
    expect(seen).toEqual(['relayToggle', 'relayCheck', 'relayStartOnOpen', 'details'])
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.closest('[data-settings-page="callRelay"]') === null)).toBe(true)
  } finally { await context.close() }
})

test('the File menu item sends call-relay, which opens the page when the relay is available and does nothing otherwise', async ({ browser, baseURL }) => {
  const { context, page } = await launch(browser, baseURL!, { state: { ...off, available: false } })
  try {
    await page.locator('#openAppSettings').waitFor()
    await page.evaluate(() => (window as unknown as { __menuCommand(c: string): void }).__menuCommand('call-relay'))
    await expect(page.locator('#settingsPane')).toBeHidden()
    await push(page, running)
    await page.evaluate(() => (window as unknown as { __menuCommand(c: string): void }).__menuCommand('call-relay'))
    await expect(page.locator('#settingsTitle')).toHaveText('Call relay on this computer')
    await expect(page$(page).head).toHaveText('Running on this computer')
  } finally { await context.close() }
})

for (const scheme of ['light', 'dark'] as const) {
  test(`axe finds nothing on the relay page (Off, in use) or its dialogs in ${scheme}`, async ({ browser, baseURL }) => {
    const { context, page } = await launch(browser, baseURL!, { scheme, state: off })
    try {
      await openRelayPage(page)
      const scan = async (label: string) => {
        const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
        expect(result.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), label).toEqual([])
      }
      await scan('Off')
      await page$(page).toggle.click()
      await expect(page.locator('#actionDialog')).toBeVisible()
      await scan('Turn on dialog')
      await page.keyboard.press('Escape')
      await push(page, inUse)
      await page$(page).details.locator('summary').click()
      await scan('In use')
      await page$(page).check.click()
      await expect(page.locator('#actionDialog')).toBeVisible()
      await scan('Check picker')
      await page.keyboard.press('Escape')
      await push(page, { ...off, wanted: true, status: 'cannot-host', reason: 'double-nat' })
      await scan("Can't run")
    } finally { await context.close() }
  })
}

// Screenshots for the owner's review. Off unless RELAY_SHOTS_DIR names a folder.
const shotsDir = process.env.RELAY_SHOTS_DIR
test.describe('screenshots', () => {
  test.skip(!shotsDir, 'RELAY_SHOTS_DIR is not set')
  const states: Array<[string, State]> = [
    ['S1-off', off], ['S4-running', running], ['S5-in-use', inUse], ['S7-double-nat', { ...off, wanted: true, status: 'cannot-host', reason: 'double-nat' }],
    ['S9-daily-limit', failed('ERR_DAILY_LIMIT', true)], ['S8h-keys', failed('ERR_IDENTITY')], ['S10a-spry', failed('ERR_HAND_PAIRED')],
  ]
  const variants: Array<[string, Options]> = [
    ['1280-light', { scheme: 'light' }], ['1280-dark', { scheme: 'dark' }],
    ['1280-light-huge', { scheme: 'light', size: 'huge' }], ['1280-dark-huge', { scheme: 'dark', size: 'huge' }],
    ['900-light', { scheme: 'light', viewport: { width: 900, height: 640 } }], ['900-dark-huge', { scheme: 'dark', size: 'huge', viewport: { width: 900, height: 640 } }],
    ['1280-forced-colours', { scheme: 'light', forcedColors: true }], ['1280-more-contrast', { scheme: 'light', contrast: true }],
  ]
  for (const [name, options] of variants) {
    test(`pages ${name}`, async ({ browser, baseURL }) => {
      mkdirSync(shotsDir!, { recursive: true })
      const { context, page } = await launch(browser, baseURL!, options)
      try {
        await openRelayPage(page)
        for (const [id, state] of states) {
          await push(page, state)
          if (id === 'S5-in-use') await page.locator('#relayDetails summary').click()
          await page.waitForTimeout(150)
          await page.screenshot({ path: join(shotsDir!, `${id}-${name}.png`) })
          if (id === 'S5-in-use') await page.locator('#relayDetails summary').click()
        }
        await push(page, off)
        await page.locator('#relayToggle').click()
        await expect(page.locator('#actionDialog')).toBeVisible()
        await page.screenshot({ path: join(shotsDir!, `S2-turn-on-dialog-${name}.png`) })
        await page.keyboard.press('Escape')
        await push(page, running)
        await page.locator('#relayCheck').click()
        await expect(page.locator('#actionDialog')).toBeVisible()
        await page.screenshot({ path: join(shotsDir!, `D-CHK-picker-${name}.png`) })
        await page.keyboard.press('Escape')
        await page.locator('#settingsBack').click()
        await page.waitForTimeout(100)
        await page.screenshot({ path: join(shotsDir!, `D-ROW-connections-${name}.png`) })
      } finally { await context.close() }
    })
  }
})
