import { test, expect, type BrowserContext } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from 'nostr-tools/pure'
import { newDeviceContext, openCallSettings, closeSettings, openRoomInfoPage } from './browser.js'
import { signInAccount } from './nostr-account.js'
import { nodeBrowserFixture } from './node-browser-fixture.js'

test('a paired owner admits a guest without typing, exchanges encrypted chat and closes the node room', async ({ browser, baseURL }, info) => {
  test.skip(!process.env.E2E_NODE_SPRY_BINARY || !process.env.E2E_NODE_SHELTER_BINARY, 'requires the checked Spry and private Shelter candidate executables')
  const fixture = await nodeBrowserFixture(new URL(baseURL!).origin, { turnPorts: { udpTcp: 34790, tls: 53499 } }), contexts: BrowserContext[] = [], requests: string[] = []
  let failNextCredential = false
  try {
    async function device(owner = false) {
      const context = await newDeviceContext(browser, baseURL!, { ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1280, height: 860 } }); contexts.push(context)
      if (owner) {
        const key = generateSecretKey()
        await context.exposeFunction('nodeTestPublicKey', () => getPublicKey(key))
        await context.exposeFunction('nodeTestSign', (value: EventTemplate) => finalizeEvent(value, key))
        await context.addInitScript(() => {
          const w = window as typeof window & { nodeTestPublicKey(): Promise<string>; nodeTestSign(value: unknown): Promise<unknown> }
          Object.defineProperty(window, 'nostr', { configurable: true, value: { getPublicKey: () => w.nodeTestPublicKey(), signEvent: (value: unknown) => w.nodeTestSign(value) } })
        })
      }
      const accountRelay = new URL('/__test-relay', baseURL!); accountRelay.protocol = 'wss:'
      await context.addInitScript(({ node, accountRelay }) => {
        const Native = window.WebSocket
        window.WebSocket = class extends Native {
          constructor(url: string | URL, protocols?: string | string[]) {
            const value = String(url)
            super(value === 'wss://node.example/events' ? node : value.startsWith('wss://') && !value.includes('localhost') ? accountRelay : value, protocols)
          }
        }
      }, { node: fixture.websocket, accountRelay: accountRelay.href })
      await context.route('https://node.example/**', async route => {
        const path = new URL(route.request().url()).pathname; requests.push(path)
        if (path === '/v1/credentials' && failNextCredential) {
          failNextCredential = false
          return route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': new URL(baseURL!).origin }, body: '{}' })
        }
        const response = await route.fetch({ url: (path === '/v1/credentials' ? fixture.calls : fixture.desk) + path })
        await route.fulfill({ response })
      })
      const page = await context.newPage()
      page.on('pageerror', error => console.error('node browser error:', error.message))
      page.on('console', message => { if (message.type() === 'error') console.error('node app:', message.text()) })
      return page
    }
    const keeper = await device(true)
    await signInAccount(keeper, baseURL!)
    await openCallSettings(keeper, 'Your KithMoot node')
    await keeper.locator('#nodePairingInput').fill(fixture.pairing())
    await keeper.locator('#nodePair').click()
    await expect(keeper.locator('#actionDialog')).toContainText('node.example')
    expect(requests).toEqual([])
    await keeper.locator('#actionConfirm').click()
    await expect(keeper.locator('#nodeHost')).toHaveText('node.example')
    await keeper.locator('#nodeCheck').click()
    await expect(keeper.locator('#nodeFacts')).toContainText('Version 0.1.0-rc.1')
    await keeper.screenshot({ path: info.outputPath('node-settings.png') })
    await keeper.setViewportSize({ width: 390, height: 844 })
    await keeper.screenshot({ path: info.outputPath('node-settings-phone.png') })
    expect(await keeper.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await keeper.setViewportSize({ width: 1280, height: 860 })
    await closeSettings(keeper)
    await keeper.locator('#homeNewRoom').click()
    await keeper.locator('#roomName').fill('Node room')
    if (await keeper.locator('#newRoomYourName').isVisible()) await keeper.locator('#newRoomYourName').fill('Keeper')
    await keeper.locator('#roomOnNode').check()
    await keeper.locator('#create').click()
    await expect(keeper.locator('#chatInput')).toBeVisible({ timeout: 30000 })
    const beforeReconnect = requests.filter(path => path === '/v1/credentials').length
    failNextCredential = true
    await keeper.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect.poll(() => requests.filter(path => path === '/v1/credentials').length, { timeout: 15000 }).toBeGreaterThanOrEqual(beforeReconnect + 2)
    await expect(keeper.locator('#chatInput')).toBeVisible()
    await expect(keeper.locator('#status')).toContainText('restored')
    const link = keeper.url()
    expect(requests).toContain('/node/v1/enrol'); expect(requests).toContain('/v1/credentials')
    const guest = await device()
    await guest.goto(link)
    await guest.locator('#actionConfirm').click()
    await expect(guest.locator('#nodeWaiting')).toBeVisible()
    await expect(keeper.locator('.approvalCard.knock')).toBeVisible()
    await keeper.locator('.approvalCard.knock').getByRole('button', { name: 'Let in', exact: true }).click()
    await expect(guest.locator('#chatInput')).toBeVisible({ timeout: 30000 })
    await expect(guest.locator('#attachToggle')).toBeHidden()
    await guest.locator('#chatInput').fill('A private node message')
    await guest.locator('#chatInput').press('Enter')
    await expect(keeper.locator('#chatLog')).toContainText('A private node message')
    await openCallSettings(keeper, 'Your KithMoot node')
    await keeper.locator('#nodeUnpair').click(); await keeper.locator('#actionConfirm').click()
    await expect(keeper.locator('#nodeUnpaired')).toBeVisible()
    expect(fixture.ledger.rooms()).toHaveLength(1); expect(fixture.ledger.active()).toHaveLength(2)
    await closeSettings(keeper)
    await openRoomInfoPage(keeper, 'Privacy and connection')
    await expect(keeper.locator('#roomFilesLine')).toHaveText('Files are off in this hosted room.')
    await keeper.locator('#roomInfoBack').click()
    await expect(keeper.locator('#infoNodeHost')).toHaveText('node.example')
    await keeper.screenshot({ path: info.outputPath('node-hosted-on.png') })
    await keeper.locator('#hostPanel > summary').click()
    await keeper.locator('#hostList').getByRole('button', { name: 'Remove', exact: true }).click()
    await keeper.locator('#actionConfirm').click()
    await expect.poll(() => fixture.ledger.active().length).toBe(1)
    await expect.poll(() => guest.evaluate(() => Object.keys(localStorage).filter(k => /^kithmoot\.node-(?:room|device|access|keeper)\./.test(k)).length)).toBe(0)
    expect(fixture.ledger.rooms()).toHaveLength(1)
    expect((await fixture.relay.status()).rooms).toBe(1)
    await guest.context().close()
    await keeper.locator('#roomSheetClose').click()
    const declined = await device()
    await declined.goto(link); await declined.locator('#actionConfirm').click()
    await expect(declined.locator('#nodeWaiting')).toBeVisible()
    await keeper.locator('.approvalCard.knock').getByRole('button', { name: 'Decline', exact: true }).click()
    await expect(keeper.locator('.approvalCard.knock')).toHaveCount(0)
    await expect(declined.locator('#nodeWaiting')).toBeVisible()
    await expect(declined.locator('#chatInput')).toBeHidden()
    await declined.context().close()
    const remaining = await device()
    await remaining.goto(link); await remaining.locator('#actionConfirm').click()
    await keeper.locator('.approvalCard.knock').getByRole('button', { name: 'Let in', exact: true }).click()
    await expect(remaining.locator('#chatInput')).toBeVisible()
    await openRoomInfoPage(keeper, 'Privacy and connection'); await keeper.locator('#roomInfoBack').click()
    await keeper.locator('#endRoom').click()
    await keeper.locator('#actionConfirm').click()
    await expect.poll(() => fixture.ledger.rooms().length).toBe(0)
    await expect.poll(async () => (await fixture.relay.status()).rooms).toBe(0)
    await expect.poll(() => remaining.evaluate(() => Object.keys(localStorage).filter(k => /^kithmoot\.node-(?:room|device|access|keeper)\./.test(k)).length)).toBe(0)
    await expect.poll(() => keeper.evaluate(() => Object.keys(localStorage).filter(k => /^kithmoot\.node-(?:room|device|access|keeper)\./.test(k)).length)).toBe(0)
    await expect.poll(() => keeper.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('kithmoot.node-operation.v1.')).length)).toBe(1)
    await openCallSettings(keeper, 'Your KithMoot node')
    await keeper.getByRole('button', { name: 'Check closure', exact: true }).click()
    await expect(keeper.locator('#nodeOperations')).toContainText('Node confirmed: room access revoked and stored messages purged.')
    expect(await keeper.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('kithmoot.node-operation.v1.')).length)).toBe(0)
    expect(requests).not.toContain('/turn')
  } finally { for (const context of contexts) await context.close(); await fixture.close() }
})
