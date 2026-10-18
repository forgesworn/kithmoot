/** Real WASM worker + browser camera/annotation/training round-trip.
 * Camera tests use Chromium's synthetic sensor, never a physical camera. */
import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { chromium, expect } from '@playwright/test'
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { createLabServer } from './serve.mjs'

const vision = fileURLToPath(new URL('../', import.meta.url))
let browser, server, origin, temporary
const options = {
  modelDirectory: process.env.VISION_LAB_MODEL ? resolve(process.env.VISION_LAB_MODEL) : undefined,
  dataDirectory: process.env.VISION_LAB_DATA ? resolve(process.env.VISION_LAB_DATA) : undefined,
  wasmPath: process.env.VISION_LAB_WASM ? resolve(process.env.VISION_LAB_WASM) : undefined,
}
for (const key of Object.keys(options)) if (!options[key]) delete options[key]
const errors = [], unexpectedRequests = []
async function page(contextOptions = {}) {
  const context = await browser.newContext(contextOptions)
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if ((!request.url().startsWith(origin + '/') && !request.url().startsWith('blob:')) || request.method() !== 'GET') {
      unexpectedRequests.push({ url: request.url(), method: request.method() })
    }
  })
  await page.goto(origin)
  await expect(page.locator('#model-state')).toContainText('MiB workspace')
  return page
}
function python(args) {
  const result = spawnSync(process.env.VISION_PYTHON ?? 'python3', args, { cwd: vision, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  return result.stdout
}
async function screenshot(page, name) {
  if (!process.env.VISION_LAB_ARTIFACTS) return
  await mkdir(process.env.VISION_LAB_ARTIFACTS, { recursive: true })
  await page.screenshot({ path: join(process.env.VISION_LAB_ARTIFACTS, name + '.png'), fullPage: true })
}
before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'kithmoot-vision-lab-test-'))
  server = await createLabServer(options)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = 'http://127.0.0.1:' + server.address().port
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
})
after(async () => {
  await browser?.close()
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  if (temporary) await rm(temporary, { recursive: true, force: true })
})

test('HTTP boundary serves only local static assets, with no capture/upload endpoint', async () => {
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(origin, { headers: { Host: 'unrelated.example' } }, response => { response.resume(); resolve(response.statusCode) })
    request.on('error', reject); request.end()
  })
  assert.equal(foreignHostStatus, 403)
  assert.equal((await fetch(origin, { method: 'POST', body: 'private frame' })).status, 405)
  assert.equal((await fetch(origin + '/%2e%2e/package.json')).status, 404)
  const response = await fetch(origin)
  assert.ok(response.headers.get('content-security-policy').includes("connect-src 'self'"))
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('browser runs real owned WASM and background composition on its matched input', { timeout: 60_000 }, async () => {
  const p = await page({ viewport: { width: 1280, height: 900 } })
  try {
    await p.locator('#sample').click()
    await expect(p.locator('#metrics')).toContainText('160×96 inference')
    const pixels = selector => p.locator(selector).evaluate(canvas => [...canvas.getContext('2d').getImageData(1, 1, 1, 1).data])
    const original = await pixels('#output')
    await p.locator('#effect').selectOption('replace')
    assert.notDeepEqual(await pixels('#output'), original)
    assert.equal((await pixels('#matte'))[3], 255)
    await screenshot(p, 'desktop-background-preview')
    await p.locator('#effect').selectOption('boxes')
    await p.locator('#stop').click()
    await p.locator('#camera').click()
    await expect(p.locator('#status')).toContainText('Camera is on locally')
    await expect.poll(async () => p.locator('#metrics').textContent()).toMatch(/[2-9]\d* frames/)
    await p.locator('#reference').click()
    await expect(p.locator('#reference-state')).toContainText('Room reference in memory')
    // Switch while a camera result may still be in flight. The new, solid
    // picture must survive any late camera/matte result unchanged.
    await p.locator('#task').selectOption('matte')
    const png = await p.evaluate(() => { const c = document.createElement('canvas'); c.width = 320; c.height = 192
      const ctx = c.getContext('2d'); ctx.fillStyle = 'rgb(200,20,40)'; ctx.fillRect(0, 0, 320, 192); return c.toDataURL().split(',')[1] })
    await p.locator('#input-file').setInputFiles({ name: 'new-source.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
    await expect(p.locator('#status')).toContainText('Local file opened')
    await expect.poll(() => pixels('#output')).toEqual([200, 20, 40, 255])
    assert.equal(await p.locator('#source-video').evaluate(v => v.srcObject), null)
    await expect(p.locator('#reference-state')).toContainText('No room reference')
    await p.locator('#stop').click()
    await p.waitForTimeout(150)
    assert.deepEqual(await pixels('#output'), [0, 0, 0, 0])
  } finally { await p.context().close() }
})

test('mobile-size lab exports reviewed samples, trains privately, evaluates and reloads real weights', { timeout: 120_000 }, async () => {
  const p = await page({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  try {
    const examples = await (await fetch(origin + '/examples.json')).json()
    for (const split of ['train', 'validation', 'test']) {
      await p.locator('#split').selectOption(split)
      await p.locator('#sample').click()
      await expect(p.locator('#capture')).toBeEnabled()
      await p.locator('#capture').click()
      await p.locator('#save-sample').click()
      await expect(p.locator('#status')).toContainText('Review every face')
      await p.locator('#sample-labels').click()
      await expect(p.locator('#status')).toContainText('Drawing labels loaded')
      for (const id of ['faces-reviewed', 'foreground-reviewed', 'permission-reviewed']) await p.locator('#' + id).check()
      await p.locator('#save-sample').click()
      await expect(p.locator('#status')).toContainText('Reviewed sample added')
      await p.locator('#stop').click()
    }
    await expect(p.locator('#samples-state')).toContainText('3 of 32')
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await screenshot(p, 'mobile-reviewed-samples')
    const downloaded = p.waitForEvent('download')
    await p.locator('#export').click()
    const path = join(temporary, 'captures.json')
    await (await downloaded).saveAs(path)
    const bundle = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(bundle.samples.length, 3)
    assert.equal(new Set(bundle.samples.map(s => s.sequence)).size, 3)
    for (const sample of bundle.samples) assert.deepEqual(sample.faces, examples.find(item => item.split === sample.split).faces)
    assert.ok(bundle.samples.some(s => s.faces.length >= 2))
    assert.equal(bundle.publicReleasePermission, false)
    const data = join(temporary, 'personal'), model = join(temporary, 'trained')
    python(['-m', 'kithmoot_vision.capture', path, '--output', data])
    python(['-m', 'kithmoot_vision.train', join(data, 'manifest.jsonl'), model, '--personal', '--steps', '2', '--batch-size', '1'])
    const report = JSON.parse(python(['-m', 'kithmoot_vision.evaluate', join(model, 'experimental.pt'), join(data, 'manifest.jsonl')]))
    assert.equal(report.scope, 'personal'); assert.equal(report.qualified, false)
    assert.equal(report.with_optional_reference.frames, 1)
    python(['-m', 'kithmoot_vision.export', join(model, 'experimental.pt'), join(model, 'experimental.kvm')])
    const card = JSON.parse(await readFile(join(model, 'experimental.json'), 'utf8'))
    assert.equal(card.public_release_allowed, false); assert.equal(card.licence, 'PRIVATE-PERSONAL')
    await p.locator('#model-file').setInputFiles(join(model, 'experimental.kvm'))
    await p.locator('#model-card').setInputFiles(join(model, 'experimental.json'))
    await p.locator('#load-model').click()
    await expect(p.locator('#model-state')).toContainText('Private personal experiment')
    await p.locator('#reset').click()
    await expect(p.locator('#model-state')).toContainText('Procedural drawing model')
    await expect(p.locator('#samples-state')).toContainText('0 of 32')
    await expect(p.locator('#reference-state')).toContainText('No room reference')
    assert.deepEqual(unexpectedRequests, [])
    assert.deepEqual(errors, [])
  } finally { await p.context().close() }
})
