import { test, expect } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Relay } from 'nostr-tools/relay'
import { newDeviceContext, openSettings } from './browser.js'
import { TEST_RELAY_WS, testRelays } from './relays.js'

/**
 * Public call relays, off by default: the switch asks only this device's
 * own relays (here the offline test relay), the picker lists verified
 * adverts as the operator's own claims, and nothing contacts an operator
 * until the person asks for a check. No TURN is needed for this.
 */
function advert(key: Uint8Array, host: string, extra: { note?: string; region?: string; sig?: string; privacy?: string } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const event = finalizeEvent({
    kind: 31478, created_at: now,
    tags: [['d', 'spry-turn'], ['v', '1'], ['status', 'open'], ['auth', 'public'], ['expiration', String(now + 7200)], ...(extra.region ? [['g', extra.region]] : []), ...(extra.privacy ? [['privacy', extra.privacy]] : [])],
    content: JSON.stringify({ credentials: `https://${host}/v1/public/credentials`,
      urls: [`turn:${host}:3478?transport=udp`, `turns:${host}:5349?transport=tcp`], ...(extra.note ? { note: extra.note } : {}) }),
  }, key)
  return extra.sig ? { ...event, sig: extra.sig } : event
}

test('the public call relay switch lists verified adverts from my own relays and contacts no operator', async ({ browser, baseURL }) => {
  test.skip(test.info().project.name !== 'chromium', 'one browser is enough for the picker')
  test.skip(!testRelays()?.length, 'needs the offline test relay')
  const good = generateSecretKey(), local = generateSecretKey(), forged = generateSecretKey()
  const host = `relay-${getPublicKey(good).slice(0, 8)}.example.org`
  // The operator's privacy notice, on a site of its own: shown, never fetched.
  const noticeHost = `notice-${getPublicKey(good).slice(0, 8)}.example.org`
  const notice = `https://${noticeHost}/legal/privacy`
  const relay = await Relay.connect(TEST_RELAY_WS)
  try {
    await relay.publish(advert(good, host, { region: 'GB', note: 'Run from \u202ehome\u202c broadband', privacy: notice }))
    await relay.publish(advert(local, 'relay.example'))
    const bad = advert(forged, `forged-${getPublicKey(forged).slice(0, 8)}.example.org`)
    await relay.publish({ ...bad, sig: bad.sig.replace(/^./, bad.sig[0] === '0' ? '1' : '0') }).catch(() => {})
  } finally { relay.close() }

  const context = await newDeviceContext(browser, baseURL!)
  const operatorRequests: string[] = []
  await context.route(/^https:\/\/[^/]*\.example\.org\//, route => { operatorRequests.push(route.request().url()); return route.abort() })
  try {
    const page = await context.newPage()
    await page.goto(baseURL!)
    await openSettings(page, 'Connections')
    await page.getByText('Other call relays', { exact: true }).click()
    const toggle = page.getByLabel('Find public call relays on my Nostr relays')
    await expect(toggle).not.toBeChecked()
    await expect(page.locator('#publicRelaysPicker')).toBeHidden()
    expect(await page.evaluate(() => localStorage.getItem('kithmoot.public-call-relays.v1'))).toBeNull()

    await toggle.check()
    const list = page.locator('#publicRelaysList')
    await expect(list.getByText(host, { exact: true })).toBeVisible({ timeout: 15_000 })
    const entry = list.locator('li', { hasText: host })
    // The operator's claims, labelled as such, with no reordering characters.
    await expect(entry.locator('bdi')).toHaveText('The operator says: region GB · Run from home broadband')
    await expect(list.getByText('relay.example', { exact: true })).toHaveCount(0)
    await expect(list.getByText(/^forged-/)).toHaveCount(0)
    const link = entry.getByRole('link', { name: `The operator\u2019s privacy notice (${noticeHost})` })
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', notice)
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow')
    await expect(link).toHaveAttribute('referrerpolicy', 'no-referrer')
    await expect(link).toHaveAccessibleDescription(`Opens ${noticeHost} in your browser. KithMoot has not checked it.`)
    // Outside the label: it does not choose the relay.
    expect(await entry.locator('label a').count()).toBe(0)
    await page.screenshot({ path: test.info().outputPath('public-relay-privacy-link.png') })
    await expect(page.locator('#publicRelaysCheck')).toBeDisabled()

    await entry.getByRole('radio').check()
    await expect(page.locator('#publicRelaysCheck')).toBeEnabled()
    // Finding and choosing contacts nobody but my own relays.
    expect(operatorRequests).toEqual([])
    const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('kithmoot.public-call-relays.v1') ?? '{}'))
    expect(saved).toMatchObject({ v: 1, on: true })
    expect(saved.lastGood).toBeUndefined()
    expect(JSON.stringify(saved)).not.toContain(host)
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(noticeHost)
    expect(await page.evaluate(() => localStorage.getItem('kithmoot.call-relay.v1'))).toBeNull()

    await toggle.uncheck()
    await expect(page.locator('#publicRelaysPicker')).toBeHidden()
    expect(await page.evaluate(() => localStorage.getItem('kithmoot.public-call-relays.v1'))).toBeNull()
  } finally { await context.close() }
})
