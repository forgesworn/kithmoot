import { build } from 'esbuild'
import { test, expect, type Page } from '@playwright/test'
import { openRoomUrl, pinToTestRelays } from './relays.js'

let fixtureCode = ''
test.beforeAll(async () => {
  const result = await build({ stdin: { contents: "export { FacePrivacy } from './app/src/face-privacy.ts'; export { OwnedCameraVision } from './app/src/owned-camera-vision.ts';", resolveDir: process.cwd() }, bundle: true, write: false,
    format: 'esm', platform: 'browser', target: 'es2022', define: { 'import.meta.env.BASE_URL': '"/j/"' } })
  fixtureCode = result.outputFiles[0]!.text
})

async function fixture(page: Page): Promise<void> {
  await page.route('**/face-privacy-fixture.js', route => route.fulfill({ contentType: 'text/javascript', body: fixtureCode }))
  await page.goto('./')
}

test('real canvas pixels cover every face and conceal again after loss or failure', async ({ page }) => {
  await fixture(page)
  const result = await page.evaluate(async () => {
    const path = '/j/face-privacy-fixture.js'
    const { FacePrivacy } = await import(path)
    const output = document.createElement('canvas')
    output.width = 640; output.height = 480
    const ctx = output.getContext('2d')!
    let faces = [{ x: 100, y: 100, width: 100, height: 100 }, { x: 400, y: 200, width: 50, height: 60 }]
    let fails = false
    const privacy = new FacePrivacy(output, () => {}, async () => ({
      detect() { if (fails) throw new Error('device failed'); return faces }, close() {},
    }))
    const pixel = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data]
    let cameraDraws = 0
    const render = (stamp: number) => privacy.render({}, 640, 480, stamp, () => {
      cameraDraws++; ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 0, 640, 480)
    })
    privacy.setMode('avatar'); render(1)
    const avatar = pixel(0, 0)
    privacy.setMode('mask'); render(2)
    const loading = pixel(0, 0)
    await Promise.resolve()
    render(3)
    const tracking = [pixel(61, 51), pixel(381, 171), pixel(8, 470)]
    faces = []; render(4)
    const lost = pixel(8, 470)
    fails = true; render(5)
    const failure = pixel(8, 470)
    privacy.setMode('off'); fails = false
    faces = [{ x: 100, y: 100, width: 100, height: 100 }]
    privacy.setMode('mask'); render(6); await Promise.resolve()
    const paint = ctx.fill.bind(ctx)
    ctx.fill = (() => { throw new Error('artwork paint failed') }) as typeof ctx.fill
    render(7)
    const artworkFailure = pixel(8, 470)
    ctx.fill = paint
    privacy.close()
    return { avatar, loading, tracking, lost, failure, artworkFailure, cameraDraws }
  })
  const dark = [16, 24, 32, 255]
  expect(result.avatar).toEqual(dark)
  expect(result.loading).toEqual(dark)
  expect(result.tracking).toEqual([dark, dark, [0, 255, 0, 255]])
  expect(result.lost).toEqual(dark)
  expect(result.failure).toEqual(dark)
  expect(result.artworkFailure).toEqual(dark)
  expect(result.cameraDraws).toBe(2)
})

test('the unavailable owned model covers the whole scene without making requests', async ({ page, baseURL }) => {
  await fixture(page)
  const outside: string[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.protocol.startsWith('http') && url.origin !== new URL(baseURL!).origin) outside.push(url.origin)
  })
  await page.evaluate(async () => {
    const path = '/j/face-privacy-fixture.js'
    const { FacePrivacy, OwnedCameraVision } = await import(path)
    const output = document.createElement('canvas')
    const source = document.createElement('canvas')
    source.width = 320; source.height = 240
    const ctx = source.getContext('2d')!
    ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 0, 320, 240)
    const owned = new OwnedCameraVision()
    const privacy = new FacePrivacy(output, () => {}, async () => owned.detector())
    privacy.setMode('mask')
    const state = { privacy, cameraDraws: 0, tick: 0 }
    ;(window as any).__facePrivacy = state
    state.tick = window.setInterval(() => privacy.render(source, 320, 240, performance.now(), () => { state.cameraDraws++ }), 100)
  })
  await expect.poll(() => page.evaluate(() => (window as any).__facePrivacy.privacy.state.message)).toContain('face detection is unavailable')
  const result = await page.evaluate(() => {
    const state = (window as any).__facePrivacy
    clearInterval(state.tick); state.privacy.close()
    return state.cameraDraws
  })
  expect(result).toBe(0)
  expect(outside).toEqual([])
})

async function enter(page: Page): Promise<void> {
  await page.goto('./')
  await page.getByRole('button', { name: 'Start a room', exact: true }).click()
  const share = page.locator('#shareUrl')
  await expect.poll(async () => (await share.inputValue()).length).toBeGreaterThan(0)
  await openRoomUrl(page, pinToTestRelays(await share.inputValue()))
  await page.locator('#displayName').fill('Mask test')
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
  if (await page.locator('#deviceControls').isHidden()) await page.locator('#callToggle').click()
  await expect(page.locator('#deviceControls')).toBeVisible()
}

test('avatar can be chosen before capture and stays covered across camera restarts', async ({ page }) => {
  await enter(page)
  await page.locator('#facePrivacyEffects').evaluate(element => {
    let node: HTMLElement | null = element as HTMLElement
    while (node) { if (node instanceof HTMLDetailsElement) node.open = true; node = node.parentElement }
  })
  await page.locator('[data-privacy="avatar"]').click()
  for (let cycle = 0; cycle < 2; cycle++) {
    await page.locator('#toggleCamera').click()
    await expect(page.locator('.media.mine video')).toBeVisible()
    await expect.poll(() => page.evaluate(() => {
      const video = document.querySelector<HTMLVideoElement>('.media.mine video')!
      if (!video.videoWidth) return []
      const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8
      const ctx = canvas.getContext('2d')!; ctx.drawImage(video, 0, 0, 8, 8)
      return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3)
    })).toEqual([16, 24, 32])
    await expect(page.locator('#facePrivacyNotice')).toContainText('whole camera picture is replaced')
    await page.locator('#toggleCamera').click()
    await expect(page.locator('.media.mine video')).toHaveCount(0)
  }
  await page.reload()
  await expect(page.locator('[data-privacy="avatar"]')).toHaveAttribute('aria-checked', 'true')
})
