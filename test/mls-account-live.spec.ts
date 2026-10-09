import { test, expect, type Page } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { encodeRoomLink } from '../src/link.js'
import { generateRoomSecret } from '../src/room.js'
import { witnessDaemon } from './mls-witness-daemon.js'
const binary = process.env.BOTHYD, relay = process.env.LAB_RELAY
test.skip(!binary || !relay, 'Set BOTHYD and LAB_RELAY for the disposable full-app lab.')
async function settings(page: Page) {
  await page.locator('#openAppSettings').click()
  const connections = page.locator('#appConnections')
  if (!await connections.evaluate(e => (e as HTMLDetailsElement).open)) await connections.locator('summary').first().click()
  await page.locator('#mlsWitnessSettingsOpen').click()
}
test('full app creates and manages a witnessed device, survives reload, holds offline and switches accounts', async ({ context, page, baseURL }) => {
  const daemon = await witnessDaemon(binary!, relay!), secret = generateSecretKey(), alternate = generateSecretKey()
  let currentSecret = secret, hold: Promise<void> | undefined, release: (() => void) | undefined, signing = false
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  await context.exposeFunction('mlsPublic', () => getPublicKey(currentSecret))
  await context.exposeFunction('mlsSign', async (template: Parameters<typeof finalizeEvent>[0]) => {
    const key = currentSecret; signing = true; await hold; signing = false; return finalizeEvent(template, key)
  })
  await context.addInitScript(relayUrl => {
    const host = window as any
    Object.defineProperty(window, 'nostr', { configurable: true, value: { getPublicKey: () => host.mlsPublic(), signEvent: (e: unknown) => host.mlsSign(e) } })
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        const text = String(url), local = `wss://${location.host}`
        const defaults = ['wss://nostr.mom', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://purplepag.es', 'wss://relay.damus.io']
        const target = defaults.includes(text.replace(/\/$/, '')) ? `${local}/__test-relay` : text
        if (!target.startsWith(local + '/') && target !== relayUrl) throw new Error('External relay blocked by lab')
        super(target, protocols)
      }
    }
  }, relay!)
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(baseURL!).origin ? route.continue() : route.abort())
  const click = (name: string) => page.locator('#mlsWitness' + name).click()
  try {
    await page.goto(baseURL! + '?signin=nostr'); await page.getByRole('button', { name: /Browser extension/ }).click()
    await expect(page.locator('#homeSignIn')).toBeHidden(); await settings(page)
    await click('Prepare'); await expect(page.locator('#mlsWitnessPair')).toBeEnabled()
    // Do not put the capability into Playwright step arguments or reports.
    const code = await daemon.pair()
    await page.evaluate(({ code, relay }) => {
      (document.getElementById('mlsWitnessCode') as HTMLInputElement).value = code
      ;(document.getElementById('mlsWitnessRelays') as HTMLInputElement).value = relay
      document.getElementById('mlsWitnessPair')!.click()
    }, { code, relay: relay! })
    await expect(page.locator('#mlsWitnessGenesis')).toBeEnabled({ timeout: 60_000 }); await click('Genesis')
    await expect(page.locator('#mlsWitnessCheck')).toBeEnabled(); await daemon.enrol(await page.locator('#mlsWitnessCommand').inputValue())
    await click('VaultRead'); await expect(page.locator('#mlsWitnessDeviceNew')).toBeEnabled({ timeout: 60_000 })
    await click('DeviceNew'); await page.locator('#actionConfirm').click()
    await expect(page.locator('#mlsWitnessDevice')).toContainText('Credential:', { timeout: 60_000 })
    const device = await page.locator('#mlsWitnessDevice').textContent()
    await page.locator('#mlsWitnessPermissionBox').fill('78'.repeat(32)); await page.locator('#mlsWitnessPermissionMethod').selectOption('signBoxRequestV1/1')
    await click('PermissionApprove'); await expect(page.locator('#actionDescription')).toContainText('Bothy: ' + '78'.repeat(32)); await page.locator('#actionConfirm').click()
    await expect(page.locator('#mlsWitnessPermissions')).toContainText('Box authentication', { timeout: 60_000 })
    await page.reload(); await settings(page); await click('VaultRead')
    await expect(page.locator('#mlsWitnessDevice')).toHaveText(device!, { timeout: 60_000 })
    await expect(page.locator('#mlsWitnessPermissions')).toContainText('Box authentication')
    await page.getByText('Withdraw permission', { exact: true }).click(); await page.locator('#actionConfirm').click()
    await expect(page.locator('#mlsWitnessPermissions')).toBeEmpty({ timeout: 60_000 })
    await daemon.stop(); await click('VaultRead')
    await expect(page.locator('#mlsWitnessDevice')).toContainText('not confirmed', { timeout: 60_000 })
    await expect(page.locator('#mlsWitnessDeviceNew')).toBeHidden(); await expect(page.locator('#mlsWitnessDeviceReplace')).toBeHidden()
    await daemon.restart(); await click('VaultRead'); await expect(page.locator('#mlsWitnessDevice')).toHaveText(device!, { timeout: 60_000 })
    // A late external signer must not install a replacement after host sign-out.
    hold = new Promise(resolve => { release = resolve })
    await click('DeviceReplace'); await page.locator('#actionConfirm').click(); await expect.poll(() => signing).toBe(true)
    await click('Close'); await page.locator('#openAppSettings').click(); await page.locator('#signOut').click()
    release!(); hold = undefined
    await expect(page.locator('#signIn')).toBeVisible()
    currentSecret = alternate
    await page.goto(baseURL! + '?signin=nostr'); await page.getByRole('button', { name: /Browser extension/ }).click()
    await expect(page.locator('#homeSignIn')).toBeHidden(); await settings(page)
    await expect(page.locator('#mlsWitnessAccount')).toHaveText(getPublicKey(alternate)); await expect(page.locator('#mlsWitnessPrepare')).toBeVisible()
    await click('Close'); await page.locator('#openAppSettings').click(); await page.locator('#signOut').click()
    currentSecret = secret
    await page.goto(baseURL! + '?signin=nostr'); await page.getByRole('button', { name: /Browser extension/ }).click()
    await expect(page.locator('#homeSignIn')).toBeHidden(); await settings(page); await click('VaultRead')
    await expect(page.locator('#mlsWitnessDevice')).toHaveText(device!, { timeout: 60_000 })
    await click('DeviceRevoke'); await page.locator('#actionConfirm').click()
    await expect(page.locator('#mlsWitnessDevice')).toContainText('Credential revoked', { timeout: 60_000 })
    let quietWitnessConnections = 0
    page.on('websocket', socket => { if (socket.url() === relay) quietWitnessConnections++ })
    const quietUrl = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Quiet lab', relays: [], iceUrls: [], policy: { tier: 'open', members: [getPublicKey(secret)], quiet: true } })
    await page.goto(quietUrl); await settings(page)
    await expect(page.locator('#mlsWitnessVaultRead')).toBeDisabled()
    await expect(page.locator('#mlsWitnessNetworkStatus')).toContainText('connections are held')
    expect(quietWitnessConnections).toBe(0)
    expect(errors).toEqual([])
  } finally { release?.(); await daemon.cleanup() }
})
