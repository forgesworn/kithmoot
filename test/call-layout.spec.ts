import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { createRoom, joinWithMedia, newDeviceContext, open } from './browser.js'

/**
 * The call stage: one box for every face, calm when people come and go.
 *
 * The owner's word for the old stage was "disconcerting": cameras were 4:3
 * boxes sized by a CSS grid, a screen share was whatever shape its picture
 * was, a camera that was off was a pill, and a share decoding late moved
 * everybody. This walks one call from two people to eight and asserts the
 * thing the eye notices first - every person's tile the same size as every
 * other's, camera on or off - and that nothing moves while nobody joins,
 * leaves or resizes anything.
 *
 * Two people are real: two browsers on a real call, so the tiles are the
 * ones `render()` builds and the share is a real share. Everybody past them
 * is a stand-in tile of the same shape with a canvas for a camera: eight
 * browsers each encoding for seven others is more than a laptop running the
 * suite can carry, and the layout does not care where a picture came from.
 *
 * Screenshots go to CALL_LAYOUT_SHOTS when it is set.
 */

// A click that cannot land should fail where it is, not eat the whole test.
test.use({ actionTimeout: 30_000 })

const SHOTS = process.env.CALL_LAYOUT_SHOTS ?? resolve('test-results/call-layout')
/** Stand-ins past the two real people; `false` is a camera that is off. */
const STAND_INS: [string, boolean][] = [['Cy', true], ['Di', false], ['Ed', true], ['Flo', false], ['Gus', true], ['Hal', false]]

interface Box { x: number; y: number; width: number; height: number }

async function join(browser: Browser, baseURL: string, url: string, name: string, contexts: BrowserContext[]): Promise<Page> {
  const context = await newDeviceContext(browser, baseURL)
  contexts.push(context)
  const page = await context.newPage()
  await page.setViewportSize({ width: 1440, height: 900 })
  // Into a call that is already on, as a person would: the room says there
  // is a call, and they join it.
  await open(page, url, name)
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
  await expect(page.locator('#callToggle')).toHaveText('Join call', { timeout: 60_000 })
  await page.locator('#callToggle').click()
  await expect(page.locator('#deviceControls')).toBeVisible()
  await page.locator('#toggleCamera').click()
  await expect(page.locator('#toggleCamera')).toHaveAttribute('data-on', 'true')
  await page.locator('#toggleMic').click()
  await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
  return page
}

/**
 * Somebody on the call, as far as the stage can tell: a tile shaped the way
 * `render()` shapes one, with a canvas standing in for a camera.
 */
async function addStandIns(page: Page, people: [string, boolean][]): Promise<void> {
  await page.evaluate(list => {
    const room = document.getElementById('room')!
    for (const [index, [name, camera]] of list.entries()) {
      const box = document.createElement('div')
      box.className = 'participant onCall'
      box.dataset.participant = `stand-in-${name}`
      box.dataset.self = 'false'
      box.dataset.name = name
      const heading = document.createElement('h3')
      const label = document.createElement('span')
      label.className = 'name'
      label.textContent = name
      heading.append(label)
      box.append(heading)
      if (camera) {
        const canvas = document.createElement('canvas')
        canvas.width = 640; canvas.height = 480
        const ctx = canvas.getContext('2d')!
        const hue = (index * 67) % 360
        const draw = () => {
          ctx.fillStyle = `hsl(${hue} 35% 30%)`; ctx.fillRect(0, 0, 640, 480)
          ctx.fillStyle = `hsl(${hue} 45% 70%)`; ctx.beginPath(); ctx.arc(320, 260, 110, 0, Math.PI * 2); ctx.fill()
        }
        draw(); setInterval(draw, 500)
        const video = document.createElement('video')
        video.muted = true; video.autoplay = true; video.playsInline = true
        video.srcObject = canvas.captureStream(2)
        const media = document.createElement('div')
        media.className = 'media'
        media.append(video)
        box.append(media)
      }
      room.append(box)
    }
  }, people)
}

/** Every tile the stage is showing, as the page lays it out. */
async function tiles(page: Page): Promise<{ name: string; box: Box; floating: boolean; camera: string }[]> {
  return page.locator('#room[data-layout] > .participant:not([data-layout-hidden])').evaluateAll(els => els.map(el => {
    const r = el.getBoundingClientRect()
    const box = el as HTMLElement
    return {
      name: box.dataset.name ?? '',
      box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      floating: box.hasAttribute('data-floating'),
      camera: box.dataset.camera ?? '',
    }
  }))
}

async function settle(page: Page, count: number): Promise<void> {
  await expect.poll(async () => (await tiles(page)).length, { timeout: 90_000, message: `never showed ${count} tiles` }).toBe(count)
  // Pictures land over a few seconds; the layout must not care, so wait
  // for them and then assert nothing moved.
  await page.waitForTimeout(1500)
}

function expectSameBox(list: { name: string; box: Box }[], label: string): void {
  const [first] = list
  for (const tile of list) {
    expect(Math.abs(tile.box.width - first.box.width), `${label}: ${tile.name} is ${tile.box.width}px wide, ${first.name} is ${first.box.width}px`).toBeLessThanOrEqual(1)
    expect(Math.abs(tile.box.height - first.box.height), `${label}: ${tile.name} is ${tile.box.height}px tall, ${first.name} is ${first.box.height}px`).toBeLessThanOrEqual(1)
  }
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png` })
}

async function chooseView(page: Page, label: 'Gallery' | 'Speaker' | 'Screen'): Promise<void> {
  await page.locator('#callView').getByRole('button', { name: label, exact: true }).click()
  await expect(page.locator('#callView').getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true')
}

test('every face is one box, from a call of two to a call of eight', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved')
  test.setTimeout(300_000)
  await mkdir(SHOTS, { recursive: true })
  const contexts: BrowserContext[] = []
  try {
    const first = await (async () => {
      const context = await newDeviceContext(browser, baseURL!)
      contexts.push(context)
      const page = await context.newPage()
      await page.setViewportSize({ width: 1440, height: 900 })
      return page
    })()
    const url = await createRoom(first, baseURL!)
    await joinWithMedia(first, url, 'Ada')
    const pages = [first]

    // Two: a FaceTime call. The other person fills the stage, your own
    // picture floats in a corner.
    pages.push(await join(browser, baseURL!, url, 'Bob', contexts))
    await settle(first, 2)
    await expect(first.locator('#room')).toHaveAttribute('data-layout', 'solo')
    const two = await tiles(first)
    const mine = two.find(tile => tile.floating)!
    const theirs = two.find(tile => !tile.floating)!
    expect(mine, 'your own picture should float').toBeTruthy()
    expect(mine.name).toBe('Ada')
    expect(theirs.box.width).toBeGreaterThan(mine.box.width * 3)
    // Inside the other picture, in the bottom right by default.
    expect(mine.box.x).toBeGreaterThan(theirs.box.x + theirs.box.width / 2)
    expect(mine.box.y).toBeGreaterThan(theirs.box.y + theirs.box.height / 2)
    await shot(first, '2-one-to-one')

    // The keyboard way to move it, remembered on this device.
    await first.locator('#moveSelfView').click()
    await expect.poll(async () => (await tiles(first)).find(tile => tile.floating)!.box.x).toBeLessThan(theirs.box.x + theirs.box.width / 2)
    expect(await first.evaluate(() => localStorage.getItem('kithmoot.call-self-corner'))).toBe('bottom-left')
    // And by dragging it to the top right.
    const floating = first.locator('#room > .participant[data-floating]')
    const start = await floating.boundingBox()
    await first.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2)
    await first.mouse.down()
    await first.mouse.move(theirs.box.x + theirs.box.width - 60, theirs.box.y + 60, { steps: 8 })
    await first.mouse.up()
    await expect.poll(() => first.evaluate(() => localStorage.getItem('kithmoot.call-self-corner'))).toBe('top-right')
    await first.waitForTimeout(400)
    await shot(first, '2-one-to-one-top-right')

    // Four, one of them with no camera: one box for all.
    await addStandIns(first, STAND_INS.slice(0, 2))
    await settle(first, 4)
    await expect(first.locator('#room')).toHaveAttribute('data-layout', 'gallery')
    const four = await tiles(first)
    expect(four.some(tile => tile.camera === 'off'), 'Di has no camera and should still have a tile').toBe(true)
    expectSameBox(four, '4 people, gallery')
    await shot(first, '4-gallery')

    await chooseView(first, 'Speaker')
    await expect(first.locator('#room')).toHaveAttribute('data-layout', 'speaker')
    await first.waitForTimeout(400)
    const speaker4 = await tiles(first)
    const featured = await first.locator('#room > .participant[data-featured]').getAttribute('data-name')
    expectSameBox(speaker4.filter(tile => tile.name !== featured), '4 people, speaker strip')
    await shot(first, '4-speaker')
    expect(await first.evaluate(() => localStorage.getItem('kithmoot.call-view'))).toBe('speaker')
    await chooseView(first, 'Gallery')

    // Eight.
    await addStandIns(first, STAND_INS.slice(2))
    await settle(first, 8)
    const eight = await tiles(first)
    expectSameBox(eight, '8 people, gallery')
    await shot(first, '8-gallery')

    // Nothing moves while nobody joins or leaves, however the pictures are
    // getting on.
    await first.waitForTimeout(3000)
    expect(await tiles(first), 'a tile moved with nobody joining or leaving').toEqual(eight)

    await chooseView(first, 'Speaker')
    await first.waitForTimeout(400)
    const speaker8 = await tiles(first)
    const featured8 = await first.locator('#room > .participant[data-featured]').getAttribute('data-name')
    expectSameBox(speaker8.filter(tile => tile.name !== featured8), '8 people, speaker strip')
    await shot(first, '8-speaker')

    // Pin somebody: they take the big picture and keep it.
    const pinTarget = first.locator('#room > .participant', { hasText: 'Flo' })
    await pinTarget.hover()
    await pinTarget.getByRole('button', { name: 'Pin Flo' }).click()
    await expect(pinTarget).toHaveAttribute('data-featured', '')
    // Tiles glide to their new places; photograph where they land.
    await first.mouse.move(0, 0)
    await first.waitForTimeout(500)
    await shot(first, '8-speaker-pinned')
    await pinTarget.getByRole('button', { name: 'Unpin Flo' }).click()

    // A share: the stage switches to it by itself, and people keep one
    // size in a strip beside it.
    await pages[1].locator('#toggleScreen').click()
    await expect(pages[1].locator('#toggleScreen')).toHaveAttribute('data-on', 'true')
    await expect(first.locator('#room')).toHaveAttribute('data-layout', 'share', { timeout: 60_000 })
    await expect(first.locator('#room video.screenPreview')).toBeVisible()
    await first.waitForTimeout(2000)
    const shared = await tiles(first)
    expect(shared).toHaveLength(8)
    expectSameBox(shared, '8 people beside a share')
    const stage = await first.locator('#room video.screenPreview').boundingBox()
    expect(stage!.width, 'the share should be the biggest thing on the stage').toBeGreaterThan(shared[0].box.width * 2)
    for (const tile of shared) {
      const overlapX = Math.min(tile.box.x + tile.box.width, stage!.x + stage!.width) - Math.max(tile.box.x, stage!.x)
      const overlapY = Math.min(tile.box.y + tile.box.height, stage!.y + stage!.height) - Math.max(tile.box.y, stage!.y)
      expect(overlapX > 1 && overlapY > 1, `${tile.name} sits on the share`).toBe(false)
    }
    await shot(first, '8-share')

    // Hide people without video: the three with cameras off go.
    await first.locator('.callViewOptions > summary').click()
    await first.getByLabel('Hide people without video').check()
    await first.locator('.callViewOptions > summary').click()
    await expect.poll(async () => (await tiles(first)).length).toBe(5)
    await shot(first, '8-share-hide-no-video')
    expect(await first.evaluate(() => localStorage.getItem('kithmoot.call-hide-no-video'))).toBe('true')
  } finally {
    for (const context of contexts) await context.close()
  }
})

test('the speaking cue is more than a colour, and can be said aloud', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved')
  const contexts: BrowserContext[] = []
  try {
    const context = await newDeviceContext(browser, baseURL!)
    contexts.push(context)
    const page = await context.newPage()
    await page.setViewportSize({ width: 1440, height: 900 })
    const url = await createRoom(page, baseURL!)
    await joinWithMedia(page, url, 'Ada')
    await join(browser, baseURL!, url, 'Bob', contexts)
    const tile = page.locator('#room > .participant', { hasText: 'Bob' })
    await expect(tile).toHaveClass(/speaking/, { timeout: 30_000 })

    // A thicker ring and a solid label: the label's fill changes, not just
    // its hue, so the cue survives a colour it cannot be told by.
    const cue = await tile.evaluate(el => {
      const label = el.querySelector('h3')!
      return { ring: getComputedStyle(el).boxShadow, label: getComputedStyle(label).backgroundColor, ink: getComputedStyle(label).color }
    })
    expect(cue.ring).toContain('4px')
    expect(cue.label).toBe('rgb(23, 96, 47)')
    expect(cue.ink).toBe('rgb(255, 255, 255)')
    await expect(page.locator('#speakingNow')).toContainText('Bob')

    // Spoken announcements are opt in and remembered.
    await expect(page.locator('#speakerAnnouncement')).toHaveText('')
    await page.locator('.callViewOptions > summary').click()
    await page.getByLabel('Announce who is speaking (screen readers)').check()
    await expect(page.locator('#speakerAnnouncement')).toHaveText(/is speaking/, { timeout: 10_000 })
    expect(await page.evaluate(() => localStorage.getItem('kithmoot.call-announce-speaker'))).toBe('true')
  } finally {
    for (const context of contexts) await context.close()
  }
})
