import { test, expect, type Page } from '@playwright/test'
import { deriveRoom, generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { testRelaysFor } from './relays.js'
import { createRoom, inbound, joinWithMedia, newDeviceContext, open, openNewRoomForm } from './browser.js'

async function chooseView(page: Page, name: 'Gallery' | 'Speaker'): Promise<void> {
  const extras = page.locator('#callExtras')
  if (!await extras.evaluate((node: HTMLDetailsElement) => node.open)) await extras.locator(':scope > summary').click()
  await page.locator('#callView').getByRole('button', { name, exact: true }).click()
  if (await extras.evaluate((node: HTMLDetailsElement) => node.open)) await extras.locator(':scope > summary').click()
}

for (const phone of [false, true]) {
  test(`the persistent gallery owns its call across rooms, home and collapsed views (${phone ? 'touch phone' : 'desktop'})`, async ({ browser, baseURL }, info) => {
    test.skip(!['chromium', 'chromium-desktop'].includes(info.project.name), 'Synthetic call media needs Chromium')
    test.setTimeout(180_000)
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
        await open(page, url, name); await page.locator('#join').click()
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
        await ada!.locator('#roomSwitcherList').getByRole('button', { name: `Switch to ${room.name}`, exact: true }).click()
        await expect(ada!.locator('#roomTitle')).toHaveText(room.name)
        await expect(ada!.locator('#callSurface')).toBeVisible()
        await expect(ada!.locator('#callStage')).toBeVisible()
        await expect(pager).toHaveAttribute('data-page', '2')
        await expect(ada!.locator('#callSurfaceOrigin')).toHaveText(ownerLabel!)
        await ada!.locator('#chatInput').fill(`Hello ${room.name}`); await ada!.locator('#chatInput').press('Enter')
        await expect(ada!.locator('#chatLog')).toContainText(`Hello ${room.name}`)
        await expect(bo!.locator('#chatLog')).not.toContainText(`Hello ${room.name}`)
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
      await ada!.locator('#callDockScreen').click()
      await expect(bo!.getByRole('button', { name: 'Expand screen share from Ada', exact: true })).toBeVisible()
      await ada!.locator('#callDockScreen').click()
      await expect(bo!.getByRole('button', { name: 'Expand screen share from Ada', exact: true })).toHaveCount(0)
      // Recording uses the original room's authority and notice, while C's
      // own banner and the permission to share the resulting file stay separate.
      await ada!.locator('#callDockRecording').click()
      await expect(ada!.locator('#actionTitle')).toContainText('Record the call in')
      await ada!.locator('#actionConfirm').click()
      await expect(bo!.locator('#recordingBanner')).toBeVisible()
      await expect(ada!.locator('#recordingBanner')).toBeHidden()
      await expect(ada!.locator('#chatLog')).not.toContainText('This call is being recorded.')
      await expect(ada!.locator('#callDockRecordingNotice')).toContainText('You are recording')
      await continuous()
      await ada!.locator('#callDockRecording').click()
      await expect(ada!.locator('#recordingReady')).toBeVisible()
      await expect(ada!.locator('#recordingShare')).toBeHidden()
      await expect(bo!.locator('#recordingBanner')).toBeHidden()
      await ada!.keyboard.press('Control+k'); await ada!.locator('#roomSwitcherHome').click()
      await expect(ada!.locator('#home')).toBeVisible()
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
      await ada!.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Side B', exact: true }).click()
      // Leaving from another room also stops the original room's recorder.
      await ada!.locator('#recordingDiscard').click()
      await ada!.locator('#actionConfirm').click()
      await expect(ada!.locator('#recordingReady')).toBeHidden()
      await ada!.locator('#callDockRecording').click()
      await ada!.locator('#actionConfirm').click()
      await expect(bo!.locator('#recordingBanner')).toBeVisible()
      await continuous()
      await ada!.locator('#callDockLeave').click()
      await expect(ada!.locator('#callSurface')).toBeHidden()
      await expect(ada!.locator('#roomTitle')).toHaveText('Side B')
      for (const popup of popups) await expect.poll(() => popup.isClosed()).toBe(true)
      await expect.poll(() => ada!.locator('#room audio').count()).toBe(0)
      await expect(ada!.locator('#recordingReady')).toBeVisible()
      await expect(ada!.locator('#recordingShare')).toBeHidden()
      await expect(bo!.locator('#recordingBanner')).toBeHidden()
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
      await ada.locator('#create').click()
      await expect(ada.locator('#join')).toBeVisible()
      const url = await ada.locator('#shareUrl').inputValue()
      await joinWithMedia(ada, url, 'Ada')
      await open(bo, url, 'Bo'); await bo.locator('#join').click()
      await expect(bo.locator('#callToggle')).toHaveText('Join call')
      await bo.locator('#callToggle').click()
      await bo.locator('#toggleCamera').click(); await bo.locator('#toggleMic').click(); await bo.locator('#toggleScreen').click()
      await ada.getByRole('button', { name: 'Expand screen share from Bo', exact: true }).click()
      const ready = ada.waitForEvent('popup')
      await ada.locator('dialog.shareViewer').getByRole('button', { name: 'Pop out', exact: true }).click()
      const popup = await ready
      await expect.poll(() => popup.locator('.shareStage > video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0)
      const roomId = await ada.evaluate(() => Object.keys(localStorage).find(key => key.startsWith('kithmoot.room.') && JSON.parse(localStorage.getItem(key)!).name === 'Dated call')!.slice('kithmoot.room.'.length))
      await ada.keyboard.press('Control+k'); await ada.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Still open', exact: true }).click()
      await expect(ada.locator('#roomTitle')).toHaveText('Still open')
      await ada.locator('#callDockRecording').click(); await ada.locator('#actionConfirm').click()
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
