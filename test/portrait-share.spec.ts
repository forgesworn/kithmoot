import { test, expect, type Locator, type Page } from '@playwright/test'
import { createRoom, newDeviceContext, offerPairing, open, openCall } from './browser.js'

/**
 * A phone sharing its screen in portrait, and nothing on top of it.
 *
 * Seen on the desktop app, 18 September 2026: a person on two devices, the
 * phone sharing a portrait game, and over most of the picture a grey box
 * with a dashed outline and the person's name in it. That box was the name
 * stand-in a share with no camera gets beside it - and, because the tile
 * had a device label, the same `::before` also picked up the label caption's
 * absolute position and grey fill, so it sat on the share instead of beside
 * it. The first case here, your own tile, has a label ("This device") too,
 * which is why it needs no second device to go wrong.
 *
 * Runs in both `chromium` and `chromium-desktop`: the rules are in
 * style.css, and the desktop build adds the fitting on top.
 */

/** A portrait screen: 720x1280, drawn afresh so it keeps producing frames.
 *  `__failShares` makes the next N shares fail the way the desktop app's
 *  do on a Mac whose Screen Recording permission has gone stale. */
const PORTRAIT_SCREEN = () => {
  Object.assign(window, { __failShares: 0 })
  navigator.mediaDevices.getDisplayMedia = async () => {
    const fails = (window as unknown as { __failShares: number }).__failShares
    if (fails > 0) {
      Object.assign(window, { __failShares: fails - 1 })
      throw new DOMException('Invalid capture constraints', 'NotReadableError')
    }
    const canvas = document.createElement('canvas'); canvas.width = 720; canvas.height = 1280
    const ctx = canvas.getContext('2d')!
    let frame = 0
    const draw = () => {
      ctx.fillStyle = '#2f5d32'; ctx.fillRect(0, 0, 720, 1280)
      ctx.fillStyle = '#fff'; ctx.font = '60px sans-serif'; ctx.fillText('Portrait game', 60, 120)
      ctx.fillStyle = '#efb64c'; ctx.fillRect(200, (frame++ * 9) % 1100, 300, 180)
    }
    draw(); const timer = setInterval(draw, 80)
    const stream = canvas.captureStream(12)
    const track = stream.getVideoTracks()[0]!
    const stop = track.stop.bind(track)
    track.stop = () => { clearInterval(timer); stop() }
    return stream
  }
}

const VIEWPORT = { width: 1320, height: 880 }

async function enter(page: Page, url: string, name: string): Promise<void> {
  await page.setViewportSize(VIEWPORT)
  await open(page, url, name)
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
  await openCall(page)
}

/**
 * Every share in `tile` is on screen, whole, the shape of a portrait
 * picture, and uncovered: at a grid of points across it the share is in the
 * hit-test stack, and nothing above it has a background of its own. A
 * pseudo-element never appears in `elementsFromPoint`, so the stand-in is
 * checked directly too: where there is one, it is not positioned over
 * anything.
 */
async function expectShareUncovered(tile: Locator, label: string): Promise<void> {
  const share = tile.locator('video.screenPreview')
  await expect(share, `${label}: no share in the tile`).toHaveCount(1, { timeout: 90_000 })
  await expect.poll(() => share.evaluate(v => (v as HTMLVideoElement).videoHeight), { message: `${label}: the share never decoded`, timeout: 90_000 })
    .toBeGreaterThan(0)
  await share.scrollIntoViewIfNeeded()
  // The fitting runs on the next frame after the picture's shape is known.
  await tile.page().waitForTimeout(500)

  const report = await share.evaluate((video: HTMLVideoElement) => {
    const problems: string[] = []
    const rect = video.getBoundingClientRect()
    if (rect.width < 40 || rect.height < 40) problems.push(`share is only ${rect.width.toFixed(0)}x${rect.height.toFixed(0)}`)
    if (rect.left < 0 || rect.top < 0 || rect.right > innerWidth + 0.5 || rect.bottom > innerHeight + 0.5) {
      problems.push(`share box ${JSON.stringify(rect)} is not fully inside the ${innerWidth}x${innerHeight} window`)
    }
    const natural = video.videoWidth / video.videoHeight
    if (natural > 0.7) problems.push(`share decoded as ${video.videoWidth}x${video.videoHeight}, not portrait`)
    if (getComputedStyle(video).objectFit === 'cover') problems.push('share is cropped with object-fit: cover')
    const transparent = (value: string) => value === 'transparent' || /rgba?\([^)]*,\s*0\)$/.test(value) || /\/\s*0%?\)$/.test(value)
    for (let i = 1; i < 6; i++) {
      for (let j = 1; j < 6; j++) {
        const x = rect.left + (rect.width * i) / 6
        const y = rect.top + (rect.height * j) / 6
        const stack = document.elementsFromPoint(x, y)
        const at = stack.indexOf(video)
        if (at < 0) { problems.push(`at ${x.toFixed(0)},${y.toFixed(0)} the share is not hit at all (top: ${stack[0]?.tagName}.${stack[0]?.className})`); continue }
        for (const el of stack.slice(0, at)) {
          if (el.contains(video)) continue
          const style = getComputedStyle(el)
          const opaque = !transparent(style.backgroundColor) || style.backgroundImage !== 'none' || el instanceof HTMLVideoElement || el instanceof HTMLImageElement
          if (opaque) problems.push(`at ${x.toFixed(0)},${y.toFixed(0)} ${el.tagName}.${String(el.className)} covers the share`)
        }
      }
    }
    for (const media of Array.from(video.closest('.participant')?.querySelectorAll('.media') ?? [])) {
      const before = getComputedStyle(media, '::before')
      if (before.content === 'none' || before.content === 'normal') continue
      const hasCamera = media.querySelector('video:not(.screenPreview)') !== null
      if (!hasCamera && (before.position === 'absolute' || before.position === 'fixed')) {
        problems.push(`the stand-in ${before.content} is positioned ${before.position} over the share (${before.width} x ${before.height})`)
      }
    }
    return problems
  })
  expect(report, `${label}: ${report.join('; ')}`).toEqual([])
}

test('a portrait share is shown whole and nothing sits on it', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')
  const a = await newDeviceContext(browser, baseURL!)
  const b = await newDeviceContext(browser, baseURL!)
  await a.addInitScript(PORTRAIT_SCREEN)
  try {
    const alex = await a.newPage(), sam = await b.newPage()
    const link = await createRoom(alex, baseURL!)
    await enter(alex, link, 'Alex')
    await enter(sam, link, 'Sam')

    await alex.locator('#toggleScreen').click()
    await expect(alex.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')

    // Your own tile carries "This device", which is what set the bug off.
    await expectShareUncovered(alex.locator('#room .participant', { has: alex.locator('video.screenPreview') }), 'own tile')
    const alexTile = sam.locator('#room .participant', { hasText: 'Alex' })
    await expectShareUncovered(alexTile, "Sam's view of Alex")

    // Popped out: the tile keeps its preview, and it is still uncovered.
    await sam.getByRole('button', { name: 'Expand screen share from Alex' }).click()
    const [popup] = await Promise.all([
      sam.waitForEvent('popup'),
      sam.getByRole('dialog', { name: 'Screen-share viewer' }).getByRole('button', { name: 'Pop out' }).click(),
    ])
    await expect(popup.locator('video')).toHaveCount(1)
    await expectShareUncovered(alexTile, "Sam's view of Alex, popped out")
    await popup.close()
  } finally {
    await a.close()
    await b.close()
  }
})

test('a person on two devices, one sharing portrait and one with only a microphone, is not covered', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')
  const laptop = await newDeviceContext(browser, baseURL!)
  const phone = await newDeviceContext(browser, baseURL!)
  const watcher = await newDeviceContext(browser, baseURL!)
  await phone.addInitScript(PORTRAIT_SCREEN)
  try {
    const pageLaptop = await laptop.newPage(), pagePhone = await phone.newPage(), sam = await watcher.newPage()
    await pageLaptop.setViewportSize(VIEWPORT); await pagePhone.setViewportSize(VIEWPORT)
    const url = await createRoom(pageLaptop, baseURL!)
    await open(pageLaptop, url, 'Alex')
    await pageLaptop.locator('#join').click()
    await expect(pageLaptop.locator('#roomArea')).toBeVisible()
    const pairUrl = await offerPairing(pageLaptop)
    await Promise.all([
      open(pagePhone, pairUrl, 'Alex'),
      pageLaptop.getByRole('button', { name: 'Add device', exact: true }).click(),
    ])
    await pagePhone.locator('#join').click()
    await expect(pagePhone.locator('#roomArea')).toBeVisible()

    // The laptop: on the call with a microphone, and no picture at all -
    // the Mac in the report.
    await openCall(pageLaptop)
    await pageLaptop.locator('#toggleMic').click()
    await expect(pageLaptop.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    // The phone: sharing a portrait screen, no camera.
    await openCall(pagePhone)
    await pagePhone.locator('#toggleScreen').click()
    await expect(pagePhone.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')

    await enter(sam, url, 'Sam')
    const grouped = sam.locator('#room .participant.linked')
    await expect(grouped).toHaveCount(1, { timeout: 90_000 })
    await expectShareUncovered(grouped, "Sam's view of Alex's two devices")
    // And on the laptop, where the phone is "Your other device".
    await expectShareUncovered(pageLaptop.locator('#room .participant', { has: pageLaptop.locator('video.screenPreview') }), "Alex's laptop")
  } finally {
    await laptop.close()
    await phone.close()
    await watcher.close()
  }
})

test('a share error goes once a share works, and says what to do', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')
  const a = await newDeviceContext(browser, baseURL!)
  await a.addInitScript(PORTRAIT_SCREEN)
  try {
    const alex = await a.newPage()
    const link = await createRoom(alex, baseURL!)
    await enter(alex, link, 'Alex')
    const status = alex.locator('#status')

    await alex.evaluate(() => Object.assign(window, { __failShares: 1 }))
    await alex.locator('#toggleScreen').click()
    await expect(status).toContainText('Screen Recording')
    await expect(status, 'the raw words are kept for a bug report').toHaveAttribute('title', /Invalid capture constraints/)
    await expect(status).not.toContainText('Invalid capture constraints')

    await alex.locator('#toggleScreen').click()
    await expect(alex.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')
    await expect(status, 'a live share under a share error').toHaveText('')

    // Fails again after stopping, then leaving the call takes it away too.
    await alex.locator('#toggleScreen').click()
    await expect(alex.locator('#toggleScreen')).toHaveAttribute('data-on', 'false')
    await alex.evaluate(() => Object.assign(window, { __failShares: 1 }))
    await alex.locator('#toggleScreen').click()
    await expect(status).toContainText('Screen Recording')
    await alex.locator('#leaveCall').click()
    await expect(status).not.toContainText('Screen Recording')
  } finally {
    await a.close()
  }
})
