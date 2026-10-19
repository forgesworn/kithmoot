/** Real browser review/export, using only original synthetic test pictures. */
import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { chromium, expect } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { request } from 'node:http'
import { createWorkshopServer } from './serve.mjs'

let server, browser, origin, temporary
before(async () => {
  temporary = await mkdtemp(join(process.env.VISION_LAB_TEMP_ROOT ?? tmpdir(), 'kithmoot-workshop-browser-'))
  server = createWorkshopServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = 'http://127.0.0.1:' + server.address().port
  browser = await chromium.launch()
})
after(async () => {
  await browser?.close()
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  if (temporary) await rm(temporary, { recursive: true, force: true })
})

test('workshop serves only explicit static files and refuses uploads and foreign hosts', async () => {
  const foreign = await new Promise((resolve, reject) => {
    const req = request(origin, { headers: { Host: 'unrelated.example' } }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject); req.end()
  })
  assert.equal(foreign, 403)
  assert.equal((await fetch(origin, { method: 'POST', body: 'private footage' })).status, 405)
  assert.equal((await fetch(origin + '/sources.json', { method: 'PUT', body: '{}' })).status, 405)
  assert.equal((await fetch(origin + '/%2e%2e/pyproject.toml')).status, 404)
  const response = await fetch(origin)
  assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.ok(response.headers.get('content-security-policy').includes("script-src 'self'"))
  const candidates = await (await fetch(origin + '/sources.json')).json()
  assert.ok(candidates.sources.every(source => source.approved === false && source.automatic_download === false))
})

test('human source review and high-resolution labels export an importable dataset without network uploads', { timeout: 60_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  const page = await context.newPage(), errors = [], outgoing = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (request.method() !== 'GET' || ![origin + '/', 'blob:', 'data:'].some(prefix => request.url().startsWith(prefix))) outgoing.push(request.url()) })
  try {
    await page.goto(origin)
    await expect(page.locator('#candidates')).toContainText('pending human review')
    await expect(page.locator('#capture')).toBeDisabled()
    await expect(page.locator('#export-training')).toBeDisabled()
    for (const [index, split] of ['train', 'validation', 'test'].entries()) {
      const images = await page.evaluate(index => {
        const c = document.createElement('canvas'); c.width = 640; c.height = 384
        const ctx = c.getContext('2d'); ctx.fillStyle = ['#386b80', '#77659b', '#757b36'][index]; ctx.fillRect(0, 0, 640, 384)
        ctx.fillStyle = '#b98260'; ctx.fillRect(260, 50, 120, 120); ctx.fillStyle = '#ddd'; ctx.fillRect(220, 170, 200, 214)
        const rgb = c.toDataURL().split(',')[1]
        ctx.fillStyle = 'black'; ctx.fillRect(0, 0, 640, 384); ctx.fillStyle = 'white'; ctx.fillRect(260, 50, 120, 120); ctx.fillRect(220, 170, 200, 214)
        return { rgb, alpha: c.toDataURL().split(',')[1] }
      }, index)
      await page.locator('#footage').setInputFiles({ name: split + '.png', mimeType: 'image/png', buffer: Buffer.from(images.rgb, 'base64') })
      await expect(page.locator('#file-state')).toContainText('SHA-256')
      const fileHash = (await page.locator('#file-state').textContent()).match(/[a-f0-9]{64}/)[0]
      await page.locator('#source-notes').setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'kithmoot-workshop-source-notes-v1', source: { sha256: 'f'.repeat(64), title: 'Wrong source' } })) })
      await expect(page.locator('#status')).toContainText('do not match')
      await page.locator('#source-notes').setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'kithmoot-workshop-source-notes-v1', source: { sha256: fileHash, title: split + ' original synthetic fixture', licence: 'PROJECT-OWNED' } })) })
      await expect(page.locator('#status')).toContainText('Human rights review is still required')
      await expect(page.locator('#mit-rights')).not.toBeChecked()
      await page.locator('#url').fill('https://example.invalid/original-synthetic-fixture')
      await page.locator('#licence').selectOption('PROJECT-OWNED')
      await page.locator('#reviewer').fill('Automated fixture; no real footage')
      await page.locator('#terms').fill('Original synthetic test drawings. MIT training and weights permitted.')
      await page.locator('#permission-basis').fill('No real people. Tests verify the workflow, not camera accuracy.')
      await page.locator('#subjects').fill(split + '-synthetic-subject')
      await page.locator('#scene').fill(split + '-scene')
      await page.locator('#sequence').fill(split + '-take')
      await page.locator('#split').selectOption(split)
      await page.locator('#approve-source').click()
      await expect(page.locator('#capture')).toBeDisabled()
      for (const id of ['synthetic', 'training-rights', 'commercial-rights', 'mit-rights', 'subject-rights']) await page.locator('#' + id).check()
      await page.locator('#approve-source').click()
      await expect(page.locator('#source-state')).toContainText('Source review saved')
      await page.locator('#tasks').selectOption('both')
      await page.locator('#capture').click()
      assert.equal(await page.locator('#editor').evaluate(canvas => canvas.width), 640)
      await page.locator('#editor').scrollIntoViewIfNeeded()
      const box = await page.locator('#editor').boundingBox()
      await page.mouse.move(box.x + box.width * 260 / 640, box.y + box.height * 50 / 384)
      await page.mouse.down(); await page.mouse.move(box.x + box.width * 380 / 640, box.y + box.height * 170 / 384); await page.mouse.up()
      await page.locator('#alpha-file').setInputFiles({ name: 'mask.png', mimeType: 'image/png', buffer: Buffer.from(images.alpha, 'base64') })
      await expect(page.locator('#status')).toContainText('Mask imported as a draft')
      await page.locator('#save-frame').click()
      await expect(page.locator('#status')).toContainText('Review each selected task')
      await page.locator('#faces-reviewed').check(); await page.locator('#foreground-reviewed').check()
      await page.locator('#save-frame').click()
      await expect(page.locator('#sample-state')).toContainText((index + 1) + ' of 24')
    }
    const download = page.waitForEvent('download')
    await page.locator('#export-training').click()
    const exported = join(temporary, 'reviewed.json'); await (await download).saveAs(exported)
    const bundle = JSON.parse(await readFile(exported, 'utf8'))
    assert.equal(bundle.format, 'kithmoot-model-workshop-v1')
    assert.equal(bundle.public_model_permission, true)
    assert.equal(bundle.sources.length, 3); assert.equal(bundle.samples.length, 3)
    assert.ok(bundle.sources.every(source => source.synthetic && source.licence === 'PROJECT-OWNED' && /^[a-f0-9]{64}$/.test(source.sha256)))
    for (const sample of bundle.samples) {
      assert.equal(sample.faces.length, 1)
      assert.ok(Math.abs(sample.faces[0][0] - 260 / 640) < .01)
      assert.deepEqual(sample.labels, { faces: true, foreground: true })
    }
    if (process.env.VISION_WORKSHOP_EXPORT) await writeFile(process.env.VISION_WORKSHOP_EXPORT, JSON.stringify(bundle), { flag: 'wx' })
    // The review is portable and editable, and duplicate people are caught
    // even when every original file and frame has a different hash.
    bundle.format = 'kithmoot-model-workshop-project-v1'
    bundle.sources[2].subjects = bundle.sources[0].subjects
    await page.locator('#project-file').setInputFiles({ name: 'review.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)) })
    await expect(page.locator('#status')).toContainText('Saved review opened locally')
    await page.locator('#export-training').click()
    await expect(page.locator('#status')).toContainText('must stay within one split')
    await page.getByRole('button', { name: 'Edit frame', exact: true }).first().click()
    await expect(page.locator('#frame-state')).toContainText('Editing reviewed frame 1')
    await expect(page.locator('#faces-reviewed')).not.toBeChecked()
    await page.locator('#clear-project').click()
    await expect(page.locator('#sample-state')).toContainText('0 of 24')
    assert.deepEqual(errors, []); assert.deepEqual(outgoing, [])
  } finally { await context.close() }
})

test('review screen fits phone and desktop layouts in light and dark', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme })
    try {
      const page = await context.newPage(); await page.goto(origin)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Model Workshop')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      if (process.env.VISION_WORKSHOP_ARTIFACTS) {
        await mkdir(process.env.VISION_WORKSHOP_ARTIFACTS, { recursive: true })
        await page.screenshot({ path: join(process.env.VISION_WORKSHOP_ARTIFACTS, 'workshop-' + colorScheme + '.png'), fullPage: true })
      }
    } finally { await context.close() }
  }
})

test('local video can be sought and captured without camera or microphone access', { timeout: 30_000 }, async () => {
  const context = await browser.newContext()
  try {
    const page = await context.newPage(); await page.goto(origin)
    const bytes = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 192
      const ctx = canvas.getContext('2d'), stream = canvas.captureStream(15), chunks = []
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
      const done = new Promise(resolve => recorder.onstop = resolve)
      recorder.ondataavailable = event => chunks.push(event.data)
      ctx.fillStyle = '#246080'; ctx.fillRect(0, 0, 320, 192); recorder.start()
      await new Promise(resolve => setTimeout(resolve, 500))
      ctx.fillStyle = '#907030'; ctx.fillRect(0, 0, 320, 192)
      await new Promise(resolve => setTimeout(resolve, 500))
      recorder.stop(); await done; stream.getTracks().forEach(track => track.stop())
      return [...new Uint8Array(await new Blob(chunks).arrayBuffer())]
    })
    await page.locator('#footage').setInputFiles({ name: 'original-fixture.webm', mimeType: 'video/webm', buffer: Buffer.from(bytes) })
    await expect(page.locator('#file-state')).toContainText('SHA-256')
    await expect(page.locator('#video')).toBeVisible()
    await page.locator('#url').fill('https://example.invalid/original-video-fixture')
    await page.locator('#licence').selectOption('PROJECT-OWNED')
    await page.locator('#reviewer').fill('Automated synthetic video fixture')
    await page.locator('#terms').fill('Original generated test frames; MIT use permitted.')
    await page.locator('#permission-basis').fill('No real subjects or external material.')
    for (const id of ['subjects', 'scene', 'sequence']) await page.locator('#' + id).fill('original-video-' + id)
    for (const id of ['synthetic', 'training-rights', 'commercial-rights', 'mit-rights', 'subject-rights']) await page.locator('#' + id).check()
    await page.locator('#approve-source').click()
    const actualTime = await page.locator('#video').evaluate(video => new Promise(resolve => { video.addEventListener('seeked', () => resolve(video.currentTime), { once: true }); video.currentTime = .65 }))
    // Browser-recorded clips may end at their last encoded frame; seeking
    // beyond it clamps to that frame rather than the recorder stop time.
    assert.ok(actualTime >= .4)
    await page.locator('#capture').click()
    await expect(page.locator('#frame-state')).toContainText(actualTime.toFixed(2) + ' s')
    assert.equal(await page.locator('#editor').evaluate(canvas => canvas.width), 320)
    const pixel = await page.locator('#editor').evaluate(canvas => [...canvas.getContext('2d').getImageData(10, 10, 1, 1).data])
    ;[144, 112, 48].forEach((value, index) => assert.ok(Math.abs(pixel[index] - value) < 8))
    await page.locator('#faces-reviewed').check(); await page.locator('#save-frame').click()
    await expect(page.locator('#sample-state')).toContainText('1 of 24')
  } finally { await context.close() }
})
