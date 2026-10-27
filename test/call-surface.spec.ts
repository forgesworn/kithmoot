import { test, expect, type Page } from '@playwright/test'
import { deriveRoom, generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { testRelaysFor } from './relays.js'
import { PANE_COLLAPSE_MS } from '../app/src/call-stance.js'
import { collectAppDiagnostics } from './app-diagnostics.js'
import { createRoom, inbound, joinWithMedia, newDeviceContext, open, openNewRoomForm, turnOnMedia, leaveToChats, switchToRoom, chooseCallLayout, chooseCallMore, join, nameCreator } from './browser.js'

// Three encoded-media clients and two live popouts produced over 5,000 trace
// screencast frames (about 200 MB) during this journey on the hosted runner.
// Keep DOM snapshots, source, assertions and the deliberate gallery screenshot;
// avoid continuously screenshotting all five views while testing continuity.
test.use({ trace: { mode: 'retain-on-failure', screenshots: false, snapshots: true, sources: true } })

async function chooseView(page: Page, name: 'Gallery' | 'Speaker'): Promise<void> {
  await chooseCallLayout(page, name)
}

/** While a call is docked its controls are out of sight, and the dock carries
 *  only Mic, Return and Leave. The call's own button is still the one that
 *  starts a share or a recording on it, so these press it from script. */
const pressDocked = (page: Page, id: string): Promise<void> => page.locator(id).evaluate(el => (el as HTMLElement).click())

/** The dock has no Record: it starts in the call, from More. So a recording
 *  that must run while docked is started on the call and the call is docked
 *  again, in the room it was docked in, which is what the dock then reports. */
async function startRecordingThenDock(page: Page, layout: string): Promise<string> {
  // The title changes before admission finishes. Return is deliberately
  // ignored during that transition, so wait for the room to be interactive.
  await expect(page.locator('#roomArea')).toBeVisible()
  await expect(page.locator('#roomArea')).not.toHaveAttribute('inert', '')
  const room = (await page.locator('#roomTitle').textContent())!
  await page.locator('#callDockBack').click()
  await expect(page.locator('#callDock')).toBeHidden()
  await chooseCallMore(page, 'Record call…')
  await expect(page.locator('#actionTitle')).toContainText('Record the call in')
  await page.locator(`input[name="recording-layout"][value="${layout}"]`).check()
  await page.locator('#actionConfirm').click()
  await page.keyboard.press('Control+k')
  await switchToRoom(page, room)
  await expect(page.locator('#callDock')).toBeVisible()
  return room
}

test('portrait cameras stay whole and another chat defaults to a gallery with working share pop-outs', async ({browser, baseURL}, info) => {
  test.skip(!['chromium', 'chromium-desktop'].includes(info.project.name), 'Synthetic media needs Chromium')
  const contexts = await Promise.all([0, 1].map(() => newDeviceContext(browser, baseURL!, {viewport: {width: 1440, height: 900}})))
  const secret = generateRoomSecret(), side = {roomId: deriveRoom(secret).roomId, name: 'Side chat', link: encodeRoomLink(baseURL!, {secret, name: 'Side chat', relays: testRelaysFor(baseURL!) ?? [], iceUrls: []}), openedAt: 1, readAt: 0}
  await contexts[0]!.addInitScript(room => localStorage.setItem('kithmoot.room.' + room.roomId, JSON.stringify(room)), side)
  try {
    const viewer = await contexts[0]!.newPage(), phone = await contexts[1]!.newPage()
    await phone.addInitScript(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = constraints?.audio ? await original({audio: constraints.audio}) : new MediaStream()
        if (constraints?.video) {
          const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 720
          const ctx = canvas.getContext('2d')!
          const paint = () => {ctx.fillStyle = '#26765b'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#fce189'; ctx.fillRect(0, 0, canvas.width, 80); ctx.fillStyle = '#cc5b56'; ctx.fillRect(0, canvas.height - 80, canvas.width, 80)}
          paint(); const timer = setInterval(paint, 80), track = canvas.captureStream(12).getVideoTracks()[0]!, stop = track.stop.bind(track)
          track.stop = () => {clearInterval(timer); stop()}; stream.addTrack(track)
          Object.assign(window, {portraitCamera: canvas})
        }
        return stream
      }
    })
    const url = await createRoom(viewer, baseURL!)
    await joinWithMedia(viewer, url, 'Ada')
    await open(phone, url, 'Pixel'); await join(phone)
    await expect(phone.locator('#callToggle')).toHaveText('Join call'); await turnOnMedia(phone)
    const camera = viewer.locator('#room .participant[data-name="Pixel"] video:not(.screenPreview)')
    await expect.poll(() => camera.evaluate((v: HTMLVideoElement) => v.videoHeight > v.videoWidth && v.videoWidth > 0)).toBe(true)
    await expect(camera).toHaveAttribute('data-camera-orientation', 'portrait')
    await expect.poll(() => camera.evaluate(v => getComputedStyle(v).objectFit)).toBe('contain')
    await viewer.screenshot({path: info.outputPath('portrait-camera.png')})
    await switchToRoom(viewer, 'Side chat')
    await expect(viewer.locator('#room')).toHaveAttribute('data-layout', 'gallery')
    await expect(viewer.locator('#room .participant[data-floating]')).toHaveCount(0)
    await expect(viewer.locator('#room .participant[data-name="Ada"]')).toBeVisible()
    await expect(viewer.locator('#room .participant[data-name="Pixel"]')).toBeVisible()
    const energy = (await viewer.evaluate(inbound)).audioEnergy
    await expect.poll(() => viewer.evaluate(inbound).then(stats => stats.audioEnergy)).toBeGreaterThan(energy)
    await phone.locator('#toggleScreen').click()
    await expect(viewer.locator('#room')).toHaveAttribute('data-layout', 'gallery')
    await viewer.getByRole('button', {name: 'Expand screen share from Pixel', exact: true}).click()
    const opening = viewer.waitForEvent('popup'); await viewer.locator('dialog.shareViewer').getByRole('button', {name: 'Pop out', exact: true}).click(); const popup = await opening
    await expect.poll(() => popup.locator('.shareStage > video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0)
    await expect(popup).toHaveTitle(/Pixel/)
    await viewer.locator('#chatInput').fill('Chat while the call and its share continue'); await viewer.locator('#chatInput').press('Enter')
    await expect(viewer.locator('#chatLog')).toContainText('Chat while the call and its share continue')
    await expect(viewer.locator('#roomTitle')).toHaveText('Side chat')
    await viewer.screenshot({path: info.outputPath('docked-gallery-and-chat.png')})
    await phone.evaluate(() => {const canvas = (window as unknown as {portraitCamera: HTMLCanvasElement}).portraitCamera; canvas.width = 720; canvas.height = 480})
    await expect.poll(() => camera.evaluate((v: HTMLVideoElement) => v.videoWidth > v.videoHeight)).toBe(true)
    await expect(camera).not.toHaveAttribute('data-camera-orientation', 'portrait')
    await popup.close()
  } finally {await Promise.all(contexts.map(context => context.close()))}
})

for (const phone of [false, true]) {
  test(`the persistent gallery owns its call across rooms, home and collapsed views (${phone ? 'touch phone' : 'desktop'})`, async ({ browser, baseURL }, info) => {
    test.skip(!['chromium', 'chromium-desktop'].includes(info.project.name), 'Synthetic call media needs Chromium')
    // This journey includes three encoded-media clients, two independent
    // popouts and two recording lifecycles. Keep individual checks bounded
    // by the ordinary expectation timeout; the whole journey needs room for
    // those checks on a software-rendering runner. This is not a speed gate.
    test.setTimeout(300_000)
    const contexts = await Promise.all(Array.from({ length: 3 }, (_, i) => newDeviceContext(browser, baseURL!, i === 0 && phone ? { isMobile: true, hasTouch: true } : {})))
    const sides = ['Side B', 'Side C'].map((name, i) => {
      const secret = generateRoomSecret()
      return { roomId: deriveRoom(secret).roomId, name, project: `Local group ${i + 2}`, link: encodeRoomLink(baseURL!, { secret, name, relays: testRelaysFor(baseURL!) ?? [], iceUrls: [] }), openedAt: Math.floor(Date.now() / 1000), readAt: 0 }
    })
    await contexts[0]!.addInitScript(rooms => {
      for (const room of rooms) {
        localStorage.setItem('kithmoot.room.' + room.roomId, JSON.stringify(room))
        localStorage.setItem('kithmoot.project.v1.visitor.' + room.roomId, room.project)
      }
    }, sides)
    try {
      const [ada, bo, cy] = await Promise.all(contexts.map(context => context.newPage()))
      await ada!.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 900 })
      const url = await createRoom(ada!, baseURL!)
      await joinWithMedia(ada!, url, 'Ada')
      for (const [page, name] of [[bo!, 'Bo'], [cy!, 'Cy']] as const) {
        await open(page, url, name); await join(page)
        await expect(page.locator('#callToggle')).toHaveText('Join call')
        await page.locator('#callToggle').click()
        await page.locator('#toggleCamera').click(); await page.locator('#toggleMic').click()
        await page.locator('#toggleScreen').click()
      }
      // Layout-only camera-off cards keep this a three-client media test.
      // They survive redraws because they are not owned by render's tile map.
      // This exercises a second desktop page without seven extra media peers.
      if (!phone) await ada!.evaluate(() => {
        for (let i = 0; i < 7; i++) {
          const card = document.createElement('div')
          card.className = 'participant onCall'
          card.dataset.participant = `layout-fixture-${i}`
          card.dataset.name = `Layout fixture ${i}`
          card.dataset.self = 'false'
          const name = document.createElement('h3'); name.textContent = card.dataset.name
          card.append(name); document.getElementById('room')!.append(card)
        }
      })
      const popups: Page[] = []
      for (const name of ['Bo', 'Cy']) {
        if (phone && name === 'Cy') await ada!.locator('#galleryPager').getByRole('button', { name: 'Next gallery page' }).click()
        await ada!.getByRole('button', { name: `Expand screen share from ${name}`, exact: true }).click()
        const ready = ada!.waitForEvent('popup')
        await ada!.locator('dialog.shareViewer').getByRole('button', { name: 'Pop out', exact: true }).click()
        const popup = await ready; popups.push(popup)
        await expect.poll(() => popup.locator('.shareStage > video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0)
      }
      if (phone) { await ada!.locator('#galleryPager').focus(); await ada!.locator('#galleryPager').press('Home') }
      if (!phone) {
        const roomId = await ada!.evaluate(ids => Object.keys(localStorage).find(key => key.startsWith('kithmoot.room.') && !ids.includes(key.slice('kithmoot.room.'.length)))!.slice('kithmoot.room.'.length), sides.map(room => room.roomId))
        await ada!.evaluate(id => localStorage.setItem('kithmoot.project.v1.visitor.' + id, 'Local group 1'), roomId)
        await expect(ada!.locator('#callSurfaceOrigin')).toContainText('Local group 1')
        await ada!.getByRole('button', { name: 'Pin Bo', exact: true }).click()
        await chooseView(ada!, 'Speaker')
        await expect(ada!.locator('#room .participant[data-name="Bo"]')).toHaveAttribute('data-featured', '')
        await chooseView(ada!, 'Gallery')
      }
      const pager = ada!.locator('#galleryPager')
      await expect(pager).toBeVisible()
      await pager.getByRole('button', { name: 'Next gallery page' }).click()
      await expect(pager).toHaveAttribute('data-page', '2')
      await ada!.evaluate(() => {
        const win = window as unknown as { __callSurface: { stage: Element; room: Element; videos: Array<{ element: HTMLVideoElement; track: MediaStreamTrack }> } }
        win.__callSurface = { stage: document.getElementById('callStage')!, room: document.getElementById('room')!, videos: Array.from(document.querySelectorAll<HTMLVideoElement>('#room video')).map(element => ({ element, track: (element.srcObject as MediaStream).getVideoTracks()[0]! })) }
      })
      const audioCount = await ada!.locator('#room audio').count()
      const ownerLabel = await ada!.locator('#callSurfaceOrigin').textContent()
      const continuous = async (): Promise<void> => {
        const energy = (await ada!.evaluate(inbound)).audioEnergy
        await expect.poll(() => ada!.evaluate(inbound).then(stats => stats.audioEnergy)).toBeGreaterThan(energy)
        for (const popup of popups) {
          const video = popup.locator('.shareStage > video')
          const before = await video.evaluate((node: HTMLVideoElement) => node.currentTime)
          await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeGreaterThan(before)
          await expect(popup.locator('audio')).toHaveCount(0)
        }
        await expect(ada!.locator('#room audio')).toHaveCount(audioCount)
        expect(await ada!.evaluate(() => {
          const saved = (window as unknown as { __callSurface: { stage: Element; room: Element; videos: Array<{ element: HTMLVideoElement; track: MediaStreamTrack }> } }).__callSurface
          return saved.stage === document.getElementById('callStage') && saved.stage.parentElement?.id === 'callSurface' && saved.room === document.getElementById('room') && saved.videos.every(({ element, track }) => element.isConnected && (element.srcObject as MediaStream).getVideoTracks()[0] === track)
        })).toBe(true)
      }
      for (const room of sides) {
        await ada!.keyboard.press('Control+k')
        await switchToRoom(ada!, `${room.name}`)
        await expect(ada!.locator('#roomTitle')).toHaveText(room.name)
        await expect(ada!.locator('#callSurface')).toBeVisible()
        await expect(ada!.locator('#callStage')).toBeVisible()
        await expect(pager).toHaveAttribute('data-page', '2')
        await expect(ada!.locator('#callSurfaceOrigin')).toHaveText(ownerLabel!)
        await ada!.locator('#chatInput').fill(`Hello ${room.name}`); await ada!.locator('#chatInput').press('Enter')
        await expect(ada!.locator('#chatLog')).toContainText(`Hello ${room.name}`)
        await expect(bo!.locator('#chatLog')).not.toContainText(`Hello ${room.name}`)
        if (!phone) {
          // Docked, the call is a strip over the conversation, not a page of
          // its own: the log must outweigh the gallery, and the composer stay on screen.
          const log = (await ada!.locator('#chatLog').boundingBox())!, stage = (await ada!.locator('#callStage').boundingBox())!, form = (await ada!.locator('#chatForm').boundingBox())!
          expect(log.height, `the log gets ${log.height.toFixed(0)}px beside a ${stage.height.toFixed(0)}px gallery`).toBeGreaterThanOrEqual(stage.height)
          expect(form.y + form.height, 'the composer runs off the bottom of the window').toBeLessThanOrEqual(900)
        }
        // The old pane state hid the gallery after its collapse delay, while
        // the outer stage and popouts remained present. Test the gallery itself.
        await ada!.waitForTimeout(PANE_COLLAPSE_MS + 100)
        await expect(ada!.locator('#callSurface #whoIsHere')).toBeVisible()
        await expect(ada!.locator('#callSurface #room')).toBeVisible()
        await continuous()
      }
      await ada!.locator('#callGalleryCollapse').click()
      await expect(ada!.locator('#callStage')).toBeHidden()
      await expect.poll(() => ada!.locator('#room video').evaluateAll((videos: HTMLVideoElement[]) => videos.every(video => video.paused))).toBe(true)
      await expect(ada!.locator('#callDockMic')).toBeVisible()
      await continuous()
      await ada!.locator('#callGalleryCollapse').click()
      await expect(ada!.locator('#callStage')).toBeVisible()
      await expect(pager).toHaveAttribute('data-page', '2')
      // Screen capture initiated while C is read still belongs to A's call.
      await pressDocked(ada!, '#toggleScreen')
      await expect(bo!.getByRole('button', { name: 'Expand screen share from Ada', exact: true })).toBeVisible()
      await pressDocked(ada!, '#toggleScreen')
      await expect(bo!.getByRole('button', { name: 'Expand screen share from Ada', exact: true })).toHaveCount(0)
      // Recording uses the original call's device key and notice, while C's
      // own banner and the permission to share the resulting file stay separate.
      const dockedIn = await startRecordingThenDock(ada!, 'gallery')
      await expect(bo!.locator('#recordingBanner')).toBeVisible()
      await expect(ada!.locator('#recordingBanner')).toBeHidden()
      await expect(ada!.locator('#chatLog')).not.toContainText('This call is being recorded.')
      await expect(ada!.locator('#callDockRecordingNotice')).toContainText('You are recording')
      await expect(ada!.locator('#callDockRecordingElapsed')).toBeVisible()
      await continuous()
      // Stopping is on the call too: back to it, then the banner's Stop.
      await ada!.locator('#callDockBack').click()
      await ada!.locator('#recordingStop').click()
      await expect(ada!.locator('#recordingReady')).toBeVisible()
      const dimensions = await ada!.locator('#recordingSave').evaluate(async (link: HTMLAnchorElement) => {
        const video = document.createElement('video')
        const ready = new Promise<void>((resolve, reject) => {
          video.addEventListener('loadedmetadata', () => resolve(), { once: true })
          video.addEventListener('error', () => reject(new Error('original-call video export did not decode')), { once: true })
        })
        video.src = link.href; await ready
        const result = { width: video.videoWidth, height: video.videoHeight }
        video.removeAttribute('src'); video.load()
        return result
      })
      expect(dimensions).toEqual({ width: 1280, height: 720 })
      // Docked again in the other room, the finished file is not offered there.
      await ada!.keyboard.press('Control+k')
      await switchToRoom(ada!, dockedIn)
      await expect(ada!.locator('#callDock')).toBeVisible()
      await expect(ada!.locator('#recordingShare')).toBeHidden()
      await expect(bo!.locator('#recordingBanner')).toBeHidden()
      await leaveToChats(bo!)
      await expect(bo!.locator('#home:visible, #rooms:visible').first()).toBeVisible()
      await bo!.locator('#callDockBack').click()
      await expect(bo!.locator('#callDock')).toBeHidden()
      await chooseCallMore(bo!, 'Record call…')
      await expect(bo!.locator('#actionTitle')).toContainText('Record the call in')
      await bo!.locator('#actionCancel').click()
      const permissionScreenshot = info.outputPath('participant-recording-permission.png')
      await bo!.screenshot({ path: permissionScreenshot })
      await info.attach('participant-recording-permission.png', { path: permissionScreenshot, contentType: 'image/png' })
      await continuous()
      await leaveToChats(ada!)
      await expect(ada!.locator('#home:visible, #rooms:visible').first()).toBeVisible()
      await expect(ada!.locator('#callStage')).toBeVisible()
      await continuous()
      await ada!.locator('#callDockBack').click()
      await expect(ada!.locator('#callDock')).toBeHidden()
      await expect(ada!.locator('#callStage')).toBeVisible()
      await expect(pager).toHaveAttribute('data-page', '2')
      await expect(ada!.locator('#recordingShare')).toBeVisible()
      await continuous()
      if (!phone) {
        await chooseView(ada!, 'Speaker')
        await expect(ada!.locator('#room .participant[data-name="Bo"]')).toHaveAttribute('data-featured', '')
      }
      if (phone) {
        const roomBox = await ada!.locator('#roomArea').boundingBox()
        const surfaceBox = await ada!.locator('#callSurface').boundingBox()
        expect(surfaceBox!.y - (roomBox!.y + roomBox!.height)).toBeLessThan(24)
        expect(surfaceBox!.height).toBeGreaterThan(300)
      }
      await ada!.screenshot({ path: info.outputPath(`persistent-gallery-${phone ? 'phone' : 'desktop'}.png`) })
      await ada!.keyboard.press('Control+k')
      await switchToRoom(ada!, 'Side B')
      // Leaving from another room also stops the original room's recorder.
      await ada!.locator('#recordingDiscard').click()
      await ada!.locator('#actionConfirm').click()
      await expect(ada!.locator('#recordingReady')).toBeHidden()
      await startRecordingThenDock(ada!, 'audio')
      await expect(bo!.locator('#recordingBanner')).toBeVisible()
      await continuous()
      await ada!.locator('#callDockLeave').click()
      await expect(ada!.locator('#callSurface')).toBeHidden()
      await expect(ada!.locator('#roomTitle')).toHaveText('Side B')
      for (const popup of popups) await expect.poll(() => popup.isClosed()).toBe(true)
      await expect.poll(() => ada!.locator('#room audio').count()).toBe(0)
      await expect(ada!.locator('#recordingReady')).toBeVisible()
      await expect(ada!.locator('#recordingShare')).toBeHidden()
      try { await expect(bo!.locator('#recordingBanner')).toBeHidden() }
      catch (error) {
        for (const [label, page] of [['recorder', ada!], ['listener', bo!]] as const) await info.attach(`${label}-stop-diagnostics`, {
          contentType: 'application/json', body: await collectAppDiagnostics(page),
        })
        throw error
      }
    } finally {
      await Promise.allSettled(contexts.map(context => context.close()))
    }
  })
}

for (const destruct of [false, true]) {
  test(`an expired original call cleans up while another room stays open (${destruct ? 'self-destruct' : 'keep history'})`, async ({ browser, baseURL }, info) => {
    test.skip(info.project.name !== 'chromium', 'One real-media browser project covers the expiry ownership boundary')
    test.setTimeout(120_000)
    const contexts = await Promise.all([newDeviceContext(browser, baseURL!), newDeviceContext(browser, baseURL!)])
    const secret = generateRoomSecret()
    const side = { roomId: deriveRoom(secret).roomId, name: 'Still open', link: encodeRoomLink(baseURL!, { secret, name: 'Still open', relays: testRelaysFor(baseURL!) ?? [], iceUrls: [] }), openedAt: Math.floor(Date.now() / 1000), readAt: 0 }
    await contexts[0]!.addInitScript(room => localStorage.setItem('kithmoot.room.' + room.roomId, JSON.stringify(room)), side)
    try {
      const ada = await contexts[0]!.newPage(), bo = await contexts[1]!.newPage()
      await ada.clock.install()
      await ada.goto(baseURL!)
      await openNewRoomForm(ada)
      await ada.locator('#roomName').fill('Dated call')
      await ada.locator('#roomEnds').selectOption('test')
      await ada.locator('#roomWhenEnds').selectOption(destruct ? 'destruct' : 'keep')
      await nameCreator(ada, 'Ada')
      await ada.locator('#create').click()
      await expect(ada.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
      const url = await ada.locator('#shareUrl').inputValue()
      await joinWithMedia(ada, url, 'Ada')
      await open(bo, url, 'Bo'); await join(bo)
      await expect(bo.locator('#callToggle')).toHaveText('Join call')
      await bo.locator('#callToggle').click()
      await bo.locator('#toggleCamera').click(); await bo.locator('#toggleMic').click(); await bo.locator('#toggleScreen').click()
      await ada.getByRole('button', { name: 'Expand screen share from Bo', exact: true }).click()
      const ready = ada.waitForEvent('popup')
      await ada.locator('dialog.shareViewer').getByRole('button', { name: 'Pop out', exact: true }).click()
      const popup = await ready
      await expect.poll(() => popup.locator('.shareStage > video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0)
      const roomId = await ada.evaluate(() => Object.keys(localStorage).find(key => key.startsWith('kithmoot.room.') && JSON.parse(localStorage.getItem(key)!).name === 'Dated call')!.slice('kithmoot.room.'.length))
      await switchToRoom(ada, 'Still open')
      await expect(ada.locator('#roomTitle')).toHaveText('Still open')
      await startRecordingThenDock(ada, 'audio')
      await expect(bo.locator('#recordingBanner')).toBeVisible()
      await expect(ada.locator('#room audio')).not.toHaveCount(0)
      const energy = (await ada.evaluate(inbound)).audioEnergy
      await expect.poll(() => ada.evaluate(inbound).then(stats => stats.audioEnergy)).toBeGreaterThan(energy)
      // The codec needs real audio samples before its clock is jumped.
      await ada.waitForTimeout(750)
      // Only Ada's clock advances. Bo remains on the real call; its media
      // cannot be responsible for closing Ada's gallery or owned popout.
      await ada.clock.fastForward(95_000)
      await expect(ada.locator('#callSurface')).toBeHidden()
      await expect.poll(() => popup.isClosed()).toBe(true)
      await expect(ada.locator('#room audio')).toHaveCount(0)
      await expect(ada.locator('#roomTitle')).toHaveText('Still open')
      await expect(ada.locator('#chatLog')).not.toContainText('The recording has stopped.')
      await ada.locator('#chatInput').fill('Side room still works'); await ada.locator('#chatInput').press('Enter')
      await expect(ada.locator('#chatLog')).toContainText('Side room still works')
      await expect.poll(() => ada.evaluate(id => {
        const saved = localStorage.getItem('kithmoot.room.' + id)
        return saved ? JSON.parse(saved).endedAt !== undefined : 'gone'
      }, roomId)).toBe(destruct ? 'gone' : true)
      if (destruct) {
        await expect(ada.locator('#recordingReady')).toBeHidden()
        expect(await ada.evaluate(id => localStorage.getItem('kithmoot.device.' + id), roomId)).toBeNull()
      } else {
        await expect(ada.locator('#recordingReady')).toBeVisible()
        await expect(ada.locator('#recordingShare')).toBeHidden()
      }
    } finally { await Promise.allSettled(contexts.map(context => context.close())) }
  })
}
