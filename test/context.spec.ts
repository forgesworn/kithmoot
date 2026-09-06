import { test, expect, type Page } from '@playwright/test'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils'
import { generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { RoomAgent } from '../src/agent.js'
import { openRoomDetails } from './browser.js'
import { sha256Hex } from '../src/attachment.js'

async function openContext(page: Page) {
  await openRoomDetails(page)
  await page.locator('#openContext').click()
  await expect(page.locator('#contextStatus')).toContainText('Cached context')
}

test('two people share encrypted context, keep personal notes private, and recover after reopening', async ({ browser, baseURL }) => {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Context workshop', relays: [relay.href], iceUrls: [] })
  const keeper = await RoomAgent.join({ link, relays: ['ws://127.0.0.1:7777'], name: 'Fixture keeper' })
  const aliceSk = generateSecretKey(), bobSk = generateSecretKey()
  const contexts = await Promise.all([aliceSk, bobSk].map(async sk => {
    const c = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
    await c.addInitScript(key => localStorage.setItem('kithmoot.participant', key), bytesToHex(sk))
    await c.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
    await c.route('**/turn', r => r.fulfill({ status: 503, body: '' }))
    return c
  }))
  const blobs = new Map<string, Buffer>(); let fetches = 0
  for (const c of contexts) await c.route('https://kithmoot.forgesworn.dev/**', async route => {
    fetches++
    const req = route.request()
    if (req.method() === 'PUT') {
      const bytes = req.postDataBuffer()!, hash = sha256Hex(bytes)
      expect(bytes.includes('Check the board display')).toBe(false)
      blobs.set('/blossom/' + hash, bytes)
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ sha256: hash, size: bytes.length, url: 'https://kithmoot.forgesworn.dev/blossom/' + hash }) })
    } else { const blob = blobs.get(new URL(req.url()).pathname); await route.fulfill({ status: blob ? 200 : 404, body: blob ?? '' }) }
  })
  const [alice, bob] = await Promise.all(contexts.map(c => c.newPage()))
  try {
    for (const [page, name] of [[alice, 'Alice'], [bob, 'Bob']] as const) { await page.goto(link); await page.locator('#displayName').fill(name); await page.locator('#join').click(); await expect(page.locator('#roomArea')).toBeVisible() }
    await openContext(alice)
    await alice.locator('#contextTitle').fill('Private planning')
    await alice.locator('#contextScope').selectOption('personal')
    await alice.getByRole('button', { name: 'Create collection', exact: true }).click()
    await expect(alice.locator('#contextStatus')).toContainText('Collection created')
    await alice.locator('#contextTitle').fill('Shared workshop')
    await alice.locator('#contextScope').selectOption('kith')
    await alice.getByRole('button', { name: 'Create collection', exact: true }).click()
    await expect(alice.locator('#contextStatus')).toContainText('Collection created')
    await alice.locator('#contextText').fill('Check the board display <img src=x onerror=alert(1)>')
    await alice.locator('#contextSource').fill('kithmoot://workshop/chat/evidence-42')
    await alice.getByRole('button', { name: 'Save record', exact: true }).click()
    await expect(alice.locator('#contextRecords')).toContainText('Check the board display')
    await expect(alice.locator('#contextRecords img')).toHaveCount(0)
    expect(fetches).toBe(0)
    const cache = await alice.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('kithmoot.context.')).map(([, v]) => v).join(''))
    expect(cache).not.toContain('Private planning'); expect(cache).not.toContain('Check the board display')
    await alice.getByText('Sharing and permissions', { exact: true }).click()
    await alice.locator('#contextRecipient').fill(getPublicKey(bobSk))
    await alice.getByRole('button', { name: 'Grant access and rotate key', exact: true }).click()
    await expect(alice.locator('#contextStatus')).toContainText('Grant saved')
    await alice.locator('#contextShareRecipient').selectOption(getPublicKey(bobSk))
    const downloaded = alice.waitForEvent('download')
    await alice.getByRole('button', { name: 'Upload and download access file', exact: true }).click()
    const accessFile = await (await downloaded).path()
    await expect(alice.locator('#contextStatus')).toContainText('Encrypted revision uploaded')
    await openContext(bob)
    await bob.getByText('Import or back up context', { exact: true }).click()
    await bob.locator('#contextFile').setInputFiles(accessFile!)
    const before = fetches
    await bob.getByRole('button', { name: 'Preview access file', exact: true }).click()
    await expect(bob.locator('#contextImportPreview')).toContainText('Shared workshop')
    expect(fetches).toBe(before)
    await bob.locator('#contextImport').click()
    await expect(bob.locator('#contextRecords')).toContainText('Check the board display')
    await expect(bob.locator('#contextRecordForm')).toBeHidden()
    await expect(bob.locator('#contextCollection option')).toHaveCount(1)
    await bob.locator('#contextClose').click()
    await expect(bob.locator('#contextRecords')).toBeEmpty()
    await openContext(bob)
    await expect(bob.locator('#contextRecords')).toContainText('Check the board display')
    await bob.locator('#contextQuery').fill('absent')
    await expect(bob.locator('#contextRecords li')).toHaveCount(0)
    expect(await bob.locator('#contextPanel').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  } finally { await keeper.leave(); await Promise.all(contexts.map(c => c.close())) }
})
