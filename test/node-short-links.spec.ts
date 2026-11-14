import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { signNodeRoom, encodeNodeRoomLink, encodeShortNodeRoomLink } from '@forgesworn/fold-kit/node-room'
import { newDeviceContext } from './browser.js'

const caddy = await readFile(new URL('../deploy/Caddyfile.kithmoot', import.meta.url), 'utf8')
const shortLinkCsp = caddy.match(/header @shortLink \{[^}]*Content-Security-Policy "([^"]+)"/)?.[1]
if (!shortLinkCsp) throw new Error('The short-link page test needs its production Content-Security-Policy')

/** Serve /n/ with the header Caddy adds, so the page is proven under it. */
async function productionHeaders(context: BrowserContext): Promise<void> {
  await context.route(url => url.pathname === '/n' || url.pathname.startsWith('/n/'), async route => {
    const response = await route.fetch({ maxRedirects: 0 })
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': shortLinkCsp! } })
  })
}
function refusals(page: Page): string[] {
  const seen: string[] = []
  page.on('console', message => { if (/Content.Security.Policy|Refused to/i.test(message.text())) seen.push(message.text()) })
  page.on('pageerror', error => seen.push(error.message))
  return seen
}

const record = (now: number, endsAt?: number) => signNodeRoom({ authoritySk: generateSecretKey(), room: getPublicKey(generateSecretKey()),
  origin: 'https://node.example', serviceKey: getPublicKey(generateSecretKey()), now, ...(endsAt === undefined ? {} : { endsAt }) })

test('a short node-room link opens the same door and is kept in its long form', async ({ browser, baseURL }) => {
  const now = Math.floor(Date.now() / 1000), event = record(now, now + 3600)
  const short = encodeShortNodeRoomLink(baseURL!, event, now), long = encodeNodeRoomLink(baseURL!, event, now)
  expect(short.length).toBeLessThan(320)
  const context = await newDeviceContext(browser, baseURL!)
  try {
    const page = await context.newPage()
    await page.goto(short)
    await expect.poll(() => page.url()).toBe(long)
    await expect(page.locator('#arrivalTitle')).not.toHaveText('This invite link is incomplete')
  } finally { await context.close() }
})

test('an ended node-room link says the room has ended, not that the link is incomplete', async ({ browser, baseURL }) => {
  const now = Math.floor(Date.now() / 1000), signedAt = now - 7200, event = record(signedAt, now - 3600)
  for (const link of [encodeNodeRoomLink(baseURL!, event, signedAt), encodeShortNodeRoomLink(baseURL!, event, signedAt)]) {
    const context = await newDeviceContext(browser, baseURL!)
    try {
      const page = await context.newPage()
      await page.goto(link)
      await expect(page.locator('#arrivalTitle')).toHaveText('This room has ended')
      await expect(page.locator('#arrivalLead')).toContainText('nobody can join it any more')
      await expect(page.locator('#retryArrival')).toBeHidden()
      await expect(page.locator('#joinRoomForm')).toBeHidden()
    } finally { await context.close() }
  }
})

test('a node-room link made ahead of this device’s clock says so', async ({ browser, baseURL }) => {
  const ahead = Math.floor(Date.now() / 1000) + 3600, event = record(ahead)
  const context = await newDeviceContext(browser, baseURL!)
  try {
    const page = await context.newPage()
    await page.goto(encodeShortNodeRoomLink(baseURL!, event, ahead))
    await expect(page.locator('#arrivalTitle')).toHaveText('This device’s clock is behind')
    await expect(page.locator('#arrivalLead')).toContainText('Set the date and time to update automatically')
    await expect(page.locator('#retryArrival')).toBeVisible()
  } finally { await context.close() }
})

test('the short-link page hands an open room to the app in the long form every reader knows', async ({ browser, baseURL }) => {
  const now = Math.floor(Date.now() / 1000), event = record(now, now + 3600), pageBase = new URL('../n/', baseURL!).href
  const short = encodeShortNodeRoomLink(pageBase, event, now), long = encodeNodeRoomLink(baseURL!, event, now)
  expect(short.length).toBeLessThan(320)
  for (const link of [short, short.replace('/n/#', '/n#')]) {
    const context = await newDeviceContext(browser, baseURL!)
    try {
      await productionHeaders(context)
      const page = await context.newPage(), refused = refusals(page)
      await page.goto(link)
      await expect.poll(() => page.url()).toBe(long)
      await expect(page.locator('#arrivalTitle')).not.toHaveText('This invite link is incomplete')
      expect(refused).toEqual([])
    } finally { await context.close() }
  }
})

test('the short-link page passes an ended room to the app, whose door says it has ended', async ({ browser, baseURL }) => {
  const now = Math.floor(Date.now() / 1000), signedAt = now - 7200, event = record(signedAt, now - 3600)
  const short = encodeShortNodeRoomLink(new URL('../n/', baseURL!).href, event, signedAt)
  const context = await newDeviceContext(browser, baseURL!)
  try {
    await productionHeaders(context)
    const page = await context.newPage()
    await page.goto(short)
    await expect.poll(() => page.url()).toBe(new URL(new URL(short).hash, baseURL!).href)
    await expect(page.locator('#arrivalTitle')).toHaveText('This room has ended')
  } finally { await context.close() }
})
