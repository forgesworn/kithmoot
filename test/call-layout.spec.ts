import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { closeCallView, createRoom, inbound, joinWithMedia, newDeviceContext, open, openCallView } from './browser.js'

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

async function ringSettled(tile: import('@playwright/test').Locator): Promise<void> {
  await expect.poll(() => tile.evaluate(el => getComputedStyle(el).boxShadow)).toContain(' 4px')
}

/** The strip is one column or one row, and no wider than about a fifth of
 *  the room's long side: the stage is what the room is looking at. */
async function expectSlimStrip(page: Page, strip: { box: Box }[], label: string): Promise<void> {
  const xs = new Set(strip.map(tile => tile.box.x))
  const ys = new Set(strip.map(tile => tile.box.y))
  expect(xs.size === 1 || ys.size === 1, `${label}: the strip is more than one column or row`).toBe(true)
  const room = await page.locator('#room').evaluate(el => ({ width: el.clientWidth, height: el.clientHeight }))
  expect(strip[0].box.width, `${label}: strip tiles are ${strip[0].box.width}px in a ${room.width}px room`).toBeLessThanOrEqual(Math.max(162, Math.max(room.width, room.height) * 0.23))
}

async function chooseView(page: Page, label: 'Gallery' | 'Speaker' | 'Screen'): Promise<void> {
  await openCallView(page)
  await page.locator('#callView').getByRole('button', { name: label, exact: true }).click()
  // Choosing puts the bar's View menu away, so read the state off the
  // button whether or not it is still on screen.
  await expect(page.locator('#callView .callViewChoice button', { hasText: new RegExp(`^${label}$`) })).toHaveAttribute('aria-pressed', 'true')
}

for (const phone of [false, true]) {
  test(`gallery pages preserve live audio and an independent share viewer (${phone ? 'touch phone' : 'desktop'})`, async ({ browser, baseURL }) => {
    test.skip(test.info().project.name !== 'chromium', 'Chromium supplies the synthetic microphone, camera and touch input')
    const contexts: BrowserContext[] = []
    try {
      const context = await newDeviceContext(browser, baseURL!, phone ? { isMobile: true, hasTouch: true } : {})
      contexts.push(context)
      const page = await context.newPage()
      await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 900 })
      const url = await createRoom(page, baseURL!)
      await joinWithMedia(page, url, 'Ada')
      const bob = await join(browser, baseURL!, url, 'Bob', contexts)
      await bob.locator('#toggleScreen').click()
      await expect(page.locator('#room video.screenPreview')).toBeVisible()
      await page.locator('#room .participant[data-name="Bob"] .shareExpand').click()
      const popupReady = page.waitForEvent('popup')
      await page.locator('dialog.shareViewer').getByRole('button', { name: 'Pop out', exact: true }).click()
      const popup = await popupReady
      const popupVideo = popup.locator('.shareStage > video')
      await expect.poll(() => popupVideo.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0)
      if (!phone) await chooseView(page, 'Gallery')
      // Two real media participants plus layout stand-ins. This proves
      // paging behaviour, not a 26-person encoded-media capacity claim.
      await addStandIns(page, Array.from({ length: 24 }, (_, i) => [`Guest ${i}`, i % 3 !== 0] as [string, boolean]))
      const pager = page.locator('#galleryPager')
      await expect(pager).toBeVisible()
      await expect(pager).toHaveAttribute('data-page', '1')
      const bobCamera = page.locator('#room .participant[data-name="Bob"] video:not(.screenPreview)')
      await bobCamera.evaluate((video: HTMLVideoElement) => {
        const win = window as unknown as { __galleryCamera: HTMLVideoElement; __galleryTrack: MediaStreamTrack }
        win.__galleryCamera = video; win.__galleryTrack = (video.srcObject as MediaStream).getVideoTracks()[0]
      })
      const audioCount = await page.locator('#room audio').count()
      const energy = (await page.evaluate(inbound)).audioEnergy
      const popupTime = await popupVideo.evaluate((video: HTMLVideoElement) => video.currentTime)
      await pager.getByRole('button', { name: 'Next gallery page' }).click()
      await expect(pager).toHaveAttribute('data-page', '2')
      await expect.poll(() => bobCamera.evaluate((video: HTMLVideoElement) => video.paused)).toBe(true)
      await expect.poll(() => page.evaluate(inbound).then(stats => stats.audioEnergy)).toBeGreaterThan(energy)
      await expect.poll(() => popupVideo.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(popupTime)
      await expect(popup.locator('audio')).toHaveCount(0)
      await expect(page.locator('#room audio')).toHaveCount(audioCount)
      await expect(pager.locator('.gallerySpeaking')).toContainText('Bob')
      await addStandIns(page, [['Newcomer', false]])
      await expect(pager).toHaveAttribute('data-page', '2')

      // Keyboard controls leave page selection with the member; returning
      // uses the original element and received track, not another decoder.
      await pager.focus(); await pager.press('Home')
      await expect(pager).toHaveAttribute('data-page', '1')
      await expect.poll(() => bobCamera.evaluate((video: HTMLVideoElement) => !video.paused && video.currentTime > 0)).toBe(true)
      expect(await bobCamera.evaluate((video: HTMLVideoElement) => {
        const win = window as unknown as { __galleryCamera: HTMLVideoElement; __galleryTrack: MediaStreamTrack }
        return video === win.__galleryCamera && (video.srcObject as MediaStream).getVideoTracks()[0] === win.__galleryTrack
      })).toBe(true)
      if (phone) {
        const nextBox = (await pager.getByRole('button', { name: 'Next gallery page' }).boundingBox())!
        expect(nextBox.width).toBeGreaterThanOrEqual(44); expect(nextBox.height).toBeGreaterThanOrEqual(44)
        expect(nextBox.y + nextBox.height).toBeLessThanOrEqual(844)
        // Swipe a visible camera, not the centre of a camera-plus-share
        // tile that can extend below the phone's scroll viewport.
        const tile = (await page.locator('#room .participant[data-name="Ada"] video:not(.screenPreview)').boundingBox())!
        const y = tile.y + tile.height / 2
        const input = await context.newCDPSession(page)
        await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 320, y }] })
        await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 80, y }] })
        await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await expect(pager).toHaveAttribute('data-page', '2')
        await input.detach()
      } else {
        await pager.press('End')
        await expect(pager.getByRole('button', { name: 'Next gallery page' })).toBeDisabled()
        await pager.press('PageUp')
        await expect(pager).toHaveAttribute('data-page', '3')
      }
      await popup.close()
    } finally {
      for (const context of contexts) await context.close()
    }
  })
}

test('every face is one box, from a call of two to a call of eight', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved')
  test.setTimeout(300_000)
  await mkdir(SHOTS, { recursive: true })
  const contexts: BrowserContext[] = []
  try {
    const first = await (async () => {
      // Measure layout endpoints, including a fixed share during scrolling.
      // Speaker changes can start another tile transition between geometry
      // reads; a sleep cannot settle continuously changing synthetic speech.
      const context = await newDeviceContext(browser, baseURL!, { reducedMotion: 'reduce' })
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
    await openCallView(first)
    await first.locator('#moveSelfView').click()
    await closeCallView(first)
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
    const speakerStrip8 = speaker8.filter(tile => tile.name !== featured8)
    expectSameBox(speakerStrip8, '8 people, speaker strip')
    await expectSlimStrip(first, speakerStrip8, '8 people, speaker')
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
    // A visible track can still have no decoded dimensions. Its first
    // frame fits the picture inside the fixed stage, so measure scrolling
    // after decoding rather than comparing that fit with the empty slot.
    await expect.poll(() => first.locator('#room video.screenPreview').evaluate((video: HTMLVideoElement) =>
      video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && video.currentTime > 0
        && Math.abs(video.offsetHeight - video.offsetWidth * video.videoHeight / video.videoWidth) <= 1,
    ), { message: 'the shared screen has decoded before measuring its scroll position' }).toBe(true)
    // Hovering Flo to pin them scrolled the strip; start from the top.
    await first.locator('#room').evaluate(el => { el.scrollTop = 0; el.scrollLeft = 0 })
    await first.waitForTimeout(2000)
    const shared = await tiles(first)
    expect(shared).toHaveLength(8)
    expectSameBox(shared, '8 people beside a share')
    await expectSlimStrip(first, shared, '8 people beside a share')
    const stage = await first.locator('#room video.screenPreview').boundingBox()
    const roomBox = (await first.locator('#room').boundingBox())!
    expect(stage!.width, 'the share should take most of the room').toBeGreaterThan(roomBox.width * 0.65)
    for (const tile of shared) {
      const overlapX = Math.min(tile.box.x + tile.box.width, stage!.x + stage!.width) - Math.max(tile.box.x, stage!.x)
      const overlapY = Math.min(tile.box.y + tile.box.height, stage!.y + stage!.height) - Math.max(tile.box.y, stage!.y)
      expect(overlapX > 1 && overlapY > 1, `${tile.name} sits on the share`).toBe(false)
    }
    await shot(first, '8-share')

    // Faces past the end of the room scroll; the share stays where it is.
    await first.locator('#room').evaluate(el => { el.scrollTop = el.scrollHeight; el.scrollLeft = el.scrollWidth })
    // The scroll event schedules the stage update; wait for that update
    // rather than reading before the share has followed the new offset.
    const drift = async () => {
      const scrolled = (await first.locator('#room video.screenPreview').boundingBox())!
      return Math.max(Math.abs(scrolled.y - stage!.y), Math.abs(scrolled.x - stage!.x))
    }
    await expect.poll(drift, { message: 'the share scrolled away with the faces', timeout: 3_000 }).toBeLessThanOrEqual(2)
    await shot(first, '8-share-scrolled')
    await first.locator('#room').evaluate(el => { el.scrollTop = 0; el.scrollLeft = 0 })

    // Hide people without video: the three with cameras off go.
    await openCallView(first)
    await first.locator('.callViewOptions > summary').click()
    await first.getByLabel('Hide people without video').check()
    await first.locator('.callViewOptions > summary').click()
    await closeCallView(first)
    await expect.poll(async () => (await tiles(first)).length).toBe(5)
    await shot(first, '8-share-hide-no-video')
    expect(await first.evaluate(() => localStorage.getItem('kithmoot.call-hide-no-video'))).toBe('true')

    // The same stage in the dark theme, for the eye.
    await first.getByLabel('Hide people without video').evaluate(el => { (el as HTMLInputElement).click() })
    await first.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(async () => (await tiles(first)).length).toBe(8)
    await first.waitForTimeout(500)
    await shot(first, '8-share-dark')
  } finally {
    for (const context of contexts) await context.close()
  }
})

test('the speaking cue is more than a colour, and is shown rather than spoken', async ({ browser, baseURL }) => {
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
    // After the ring's 120ms ease in.
    // Polled: speech comes and goes, and on a slow runner one reading can
    // land in a pause, with the label back at rest for that moment.
    await ringSettled(tile)
    await expect.poll(() => tile.evaluate(el => {
      const label = el.querySelector('h3')!
      return { label: getComputedStyle(label).backgroundColor, ink: getComputedStyle(label).color }
    }), { timeout: 15_000 }).toEqual({ label: 'rgb(23, 96, 47)', ink: 'rgb(255, 255, 255)' })
    await expect(page.locator('#speakingNow')).toContainText('Bob')

    // B2: the h3's own colour is white on green, but `.name` set its own
    // colour and used to win the cascade back to the page's dark text in
    // light theme - about 2.3:1 on the green fill. It has to read white too.
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => tile.evaluate(el => getComputedStyle(el.querySelector('h3 .name')!).color)).toBe('rgb(255, 255, 255)')

    // Shown, never spoken: nothing on the call page announces speakers.
    await expect(page.locator('[aria-live] , [role="status"]').filter({ hasText: /speaking/i })).toHaveCount(0)
  } finally {
    for (const context of contexts) await context.close()
  }
})
