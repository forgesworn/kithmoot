// Run inside the disposable container (see README.md here), against the
// unpacked Linux package. It moves the real pointer with xdotool, which is
// the only way to meet what a person meets: synthetic events from the
// browser tooling reach a window the X server would have passed over.
// --no-sandbox is confined to this root-owned container.
import { _electron as electron } from 'playwright-core'
import { execSync } from 'node:child_process'
const exe = process.env.KITHMOOT_EXE ?? '/opt/kithmoot/kithmoot'
const sh = command => { try { return execSync(command, { encoding: 'utf8' }).trim() } catch (error) { return `ERR ${error.message.split('\n')[0]}` } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const mouse = (...steps) => sh(`xdotool ${steps.join(' ')}`)
const glide = async (from, to, steps = 10) => { for (let i = 0; i <= steps; i++) { mouse(`mousemove ${Math.round(from.x + (to.x - from.x) * i / steps)} ${Math.round(from.y + (to.y - from.y) * i / steps)}`); await sleep(25) } }
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`) }

const app = await electron.launch({ executablePath: exe, args: ['--no-sandbox', `--user-data-dir=/tmp/kithmoot-share-${Date.now()}`, '--use-fake-device-for-media-stream'], timeout: 60000 })
const page = await app.firstWindow()
const child = mark => app.evaluate(({ BrowserWindow }, mark) => BrowserWindow.getAllWindows().filter(window => window.webContents.getURL().includes(mark)).sort((a, b) => a.id - b.id).map(window => ({ id: window.id, ...window.getBounds() })), mark)
const place = (id, bounds) => app.evaluate(({ BrowserWindow }, [id, bounds]) => BrowserWindow.fromId(id).setBounds(bounds), [id, bounds])
const mainWindow = action => app.evaluate(({ BrowserWindow }, action) => BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().startsWith('about:blank'))[action](), action)
const open = async button => { const opened = app.waitForEvent('window'); await page.locator(button).click(); const popup = await opened; await sleep(1200); return popup }
// Through the see-through middle, then a drag of the bar: did the window follow?
async function followsTheBar(mark, grab) {
  const [before] = await child(mark)
  const middle = { x: before.x + Math.round(before.width / 2), y: before.y + Math.round(before.height / 2) }, bar = { x: before.x + grab, y: before.y + 15 }
  await glide({ x: 20, y: 20 }, middle); await sleep(600)
  await glide(middle, bar); await sleep(300)
  mouse('mousedown 1'); await sleep(150)
  await glide(bar, { x: bar.x + 50, y: bar.y + 30 }, 5); mouse('mouseup 1'); await sleep(400)
  const [after] = await child(mark)
  return after.x !== before.x || after.y !== before.y
}
try {
  await page.locator('#newRoom:visible, #roomName:visible').first().waitFor({ timeout: 30000 })
  if (!await page.locator('#roomName').isVisible()) await page.locator('#newRoom').click()
  await page.locator('#create').click()
  await page.waitForFunction(() => document.getElementById('shareUrl')?.value.length > 0, null, { timeout: 30000 })
  if (await page.locator('#displayName').isVisible().catch(() => false)) await page.locator('#displayName').fill('Linux check')
  if (await page.locator('#join').isVisible().catch(() => false)) await page.locator('#join').click()
  await page.locator('#roomArea').waitFor({ timeout: 60000 })
  if (!await page.locator('#deviceControls').isVisible()) await page.locator('#callToggle:visible, #mobileCall:visible').first().click()
  await page.locator('#deviceControls').waitFor({ timeout: 30000 })

  // With KithMoot minimised no window of ours is beneath the pointer, which
  // is when the app's own reading of the cursor stops moving.
  await open('#addRedaction')
  check('box: the bar answers after the pointer crossed the middle', await followsTheBar('kithmoot-redaction-box', 60))
  await mainWindow('minimize'); await sleep(1500)
  check('box: and still does with KithMoot minimised', await followsTheBar('kithmoot-redaction-box', 60))
  check('box: and again', await followsTheBar('kithmoot-redaction-box', 60))
  await mainWindow('restore'); await sleep(1500)
  await page.evaluate(() => window.kithmootDesktop.redactionAction(null, 'close-all')); await sleep(800)

  const area = await open('#shareArea')
  const [frame] = await child('kithmoot-share-area')
  const start = area.getByRole('button', { name: 'Start sharing', exact: true }), footer = area.locator('footer')
  await mainWindow('minimize'); await sleep(1500)
  check('frame: the bar answers with KithMoot minimised', await followsTheBar('kithmoot-share-area', 60))
  await mainWindow('restore'); await sleep(1500)

  await place(frame.id, { x: 1200, y: 150, width: 900, height: 600 }); await sleep(700)
  check('frame across two screens: Start is off and the bar says why', !await start.isEnabled() && /one screen/.test(await footer.textContent()), await footer.textContent())
  // The backstop: a request that reaches the main process anyway is refused, and the frame stays.
  await area.evaluate(() => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Start sharing').disabled = false })
  await start.click(); await sleep(1500)
  check('frame: a refused request keeps the frame and says why', !area.isClosed() && /one screen/.test(await footer.textContent()))
  await place(frame.id, { x: 200, y: 150, width: 900, height: 600 }); await sleep(700)
  check('frame moved back: Start is on again', await start.isEnabled(), await footer.textContent())
  await start.click(); await sleep(3000)
  const sizes = await page.evaluate(() => [...document.querySelectorAll('video')].filter(video => video.srcObject && video.videoWidth).map(video => `${video.videoWidth}x${video.videoHeight}`))
  check('frame: the share starts and is the size of the hole', !area.isClosed() && sizes.includes('884x508'), sizes.join())

  await area.evaluate(() => { window.__seen = []; for (const type of ['pointerdown', 'pointermove']) document.addEventListener(type, event => window.__seen.push(`${type}:${event.target.tagName}`), true) })
  mouse('mousemove 650 450'); await sleep(400); mouse('click 1'); await sleep(300)
  check('frame, not drawing: the hole passes clicks on', (await area.evaluate(() => window.__seen.splice(0))).length === 0)
  await area.getByRole('button', { name: 'Draw', exact: true }).click(); await sleep(500)
  mouse('mousemove 600 400'); await sleep(200); mouse('mousedown 1'); await sleep(100); mouse('mousemove 680 440'); await sleep(100); mouse('mouseup 1'); await sleep(400)
  check('frame, drawing: the pen lands on the canvas in the hole', (await area.evaluate(() => window.__seen.splice(0))).includes('pointerdown:CANVAS'))
  await area.getByRole('button', { name: 'Draw', exact: true }).click(); await sleep(500)

  await open('#addRedaction'); await open('#addRedaction')
  const [first, second] = await child('kithmoot-redaction-box')
  await place(first.id, { x: 300, y: 300, width: 200, height: 100 }); await place(second.id, { x: 700, y: 450, width: 240, height: 120 }); await sleep(1500)
  // The shared picture is the hole: 884x508 from (208, 202) on the screen.
  const sample = points => page.evaluate(points => {
    const video = [...document.querySelectorAll('video')].find(video => video.srcObject && video.videoWidth === 884)
    if (!video) return null
    const canvas = document.createElement('canvas'); canvas.width = 884; canvas.height = 508
    const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(video, 0, 0)
    return points.map(([x, y]) => Math.max(...context.getImageData(x - 208, y - 202, 1, 1).data.slice(0, 3)))
  }, points)
  const inside = await sample([[400, 350], [310, 310], [490, 390], [820, 510], [710, 460], [930, 560]]), beside = await sample([[560, 640], [1000, 300]])
  // The cover is a pattern in two dark colours, both under 60 in every channel.
  check('two boxes: both are covered in the shared picture and the rest is not', Boolean(inside?.every(value => value < 60) && beside?.some(value => value > 100)), `inside ${inside}, beside ${beside}`)
  console.log(`${results.filter(Boolean).length} of ${results.length} passed`)
} catch (error) { results.push(false); console.log('FAILED', error.message) } finally {
  // Closing a window on a call raises a dialog that waits for an answer.
  try { app.process().kill('SIGKILL') } catch { /* already gone */ }
  process.exit(results.every(Boolean) ? 0 : 1)
}
