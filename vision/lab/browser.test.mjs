/** Real WASM worker + browser camera/annotation/training round-trip.
 * Camera tests use Chromium's synthetic sensor, never a physical camera. */
import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { chromium, webkit, expect } from '@playwright/test'
import { mkdtemp, readFile, rm, mkdir, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { request as httpRequest, createServer } from 'node:http'
import { createLabServer, labHeaders } from './serve.mjs'
import { buildLab } from './build.mjs'

const vision = fileURLToPath(new URL('../', import.meta.url))
let browser, server, origin, temporary, hostedServer, hostedOrigin, hostedManifest
const options = {
  modelDirectory: process.env.VISION_LAB_MODEL ? resolve(process.env.VISION_LAB_MODEL) : undefined,
  dataDirectory: process.env.VISION_LAB_DATA ? resolve(process.env.VISION_LAB_DATA) : undefined,
  wasmPath: process.env.VISION_LAB_WASM ? resolve(process.env.VISION_LAB_WASM) : undefined,
}
for (const key of Object.keys(options)) if (!options[key]) delete options[key]
const errors = [], unexpectedRequests = []
async function page(contextOptions = {}, base = origin, engine = browser) {
  const context = await engine.newContext(contextOptions)
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if ((!request.url().startsWith(base.endsWith('/') ? base : base + '/') && !request.url().startsWith('blob:')) || request.method() !== 'GET') {
      unexpectedRequests.push({ url: request.url(), method: request.method() })
    }
  })
  await page.goto(base)
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
  temporary = await mkdtemp(join(process.env.VISION_LAB_TEMP_ROOT ?? tmpdir(), 'kithmoot-vision-lab-test-'))
  server = await createLabServer(options)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = 'http://127.0.0.1:' + server.address().port
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-audio-output'] })
  const directory = join(temporary, 'hosted')
  hostedManifest = await buildLab(directory, options)
  hostedServer = createServer(async (request, response) => {
    for (const [name, value] of Object.entries(labHeaders)) response.setHeader(name, value)
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return }
    const prefix = '/camera-lab/', path = new URL(request.url, 'http://localhost').pathname
    if (!path.startsWith(prefix)) { response.writeHead(404); response.end(); return }
    const relative = path.slice(prefix.length) || 'index.html'
    if (!Object.hasOwn(hostedManifest.files, relative) && relative !== 'lab-manifest.json') { response.writeHead(404); response.end(); return }
    const types = { html: 'text/html', mjs: 'text/javascript', css: 'text/css', json: 'application/json', wasm: 'application/wasm', png: 'image/png', svg: 'image/svg+xml' }
    try {
      const bytes = await readFile(join(directory, relative))
      response.setHeader('Content-Type', types[relative.split('.').at(-1)] ?? 'text/plain')
      response.end(request.method === 'HEAD' ? undefined : bytes)
    } catch { response.writeHead(404); response.end() }
  })
  await new Promise(resolve => hostedServer.listen(0, '127.0.0.1', resolve))
  hostedOrigin = 'http://127.0.0.1:' + hostedServer.address().port + '/camera-lab/'
})
after(async () => {
  await browser?.close()
  for (const instance of [server, hostedServer]) if (instance) { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)) }
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

test('microphone is opt-in, measures local audio and stops on input replacement or late permission', { timeout: 60_000 }, async () => {
  const p = await page({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, hostedOrigin)
  try {
    await p.evaluate(() => {
      window.mediaRequests = []; window.mediaStreams = []; window.audioContexts = []
      const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async constraints => {
        window.mediaRequests.push(structuredClone(constraints))
        const stream = await get(constraints); window.mediaStreams.push(stream)
        if (window.delayMedia) return new Promise(resolve => { window.releaseMedia = () => resolve(stream) })
        return stream
      }
      const Audio = window.AudioContext
      window.AudioContext = class extends Audio { constructor(...args) { super(...args); window.audioContexts.push(this) } }
    })
    await expect(p.locator('#microphone')).not.toBeChecked()
    await p.locator('#camera').click()
    await expect(p.locator('#status')).toContainText('Camera is on locally')
    assert.deepEqual(await p.evaluate(() => window.mediaRequests.map(item => item.audio)), [false])
    assert.equal(await p.evaluate(() => window.mediaStreams[0].getAudioTracks().length), 0)
    await p.locator('#stop').click()
    await p.locator('#microphone').check(); await p.locator('#camera').click()
    await expect(p.locator('#microphone-state')).toContainText('Microphone on')
    await expect.poll(() => p.locator('#microphone-level').evaluate(meter => meter.value), { timeout: 10_000 }).toBeGreaterThan(.01)
    assert.deepEqual(await p.evaluate(() => window.mediaRequests.map(item => item.audio)), [false, true])
    const png = await p.evaluate(() => { const c = document.createElement('canvas'); c.width = 320; c.height = 192; return c.toDataURL().split(',')[1] })
    await p.locator('#input-file').setInputFiles({ name: 'next.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
    await expect(p.locator('#status')).toContainText('Local file opened')
    await expect(p.locator('#microphone-state')).toContainText('Microphone off')
    await expect.poll(() => p.evaluate(() => window.audioContexts.every(context => context.state === 'closed'))).toBe(true)
    assert.equal(await p.evaluate(() => window.mediaStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))), true)
    await p.locator('#stop').click()
    await p.evaluate(() => { window.delayMedia = true })
    await p.locator('#camera').click()
    await expect.poll(() => p.evaluate(() => typeof window.releaseMedia === 'function')).toBe(true)
    await p.locator('#stop').click(); await p.evaluate(() => window.releaseMedia())
    await expect.poll(() => p.evaluate(() => window.mediaStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true)
    await expect.poll(() => p.evaluate(() => window.audioContexts.every(context => context.state === 'closed'))).toBe(true)
    assert.equal(await p.locator('#microphone-level').evaluate(meter => meter.value), 0)
    await p.locator('#reset').click(); await expect(p.locator('#microphone')).not.toBeChecked()
  } finally { await p.context().close() }
})

test('hosted export rejects personal models and refuses to replace an existing preview', async () => {
  const personal = join(temporary, 'private-model'); await mkdir(personal)
  const card = await (await fetch(origin + '/default.json')).json()
  await writeFile(join(personal, 'experimental.json'), JSON.stringify({ ...card, scope: 'personal', licence: 'PRIVATE-PERSONAL', public_release_allowed: false }))
  await writeFile(join(personal, 'experimental.kvm'), Buffer.from(await (await fetch(origin + '/default.kvm')).arrayBuffer()))
  const refused = join(temporary, 'refused')
  await assert.rejects(() => buildLab(refused, { ...options, modelDirectory: personal }), /personal models must stay in the browser/)
  await assert.rejects(() => access(refused), { code: 'ENOENT' })
  await assert.rejects(() => buildLab(join(temporary, 'hosted'), options), { code: 'EEXIST' })
  assert.equal(hostedManifest.model_scope, 'original-drawings-only')
  assert.equal(hostedManifest.audio_recorded, false)
  assert.equal(hostedManifest.qualified, false)
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

test('WebKit phone layout runs real WASM from the hosted subdirectory', { timeout: 60_000, skip: process.env.VISION_LAB_WEBKIT !== '1' }, async t => {
  // Keep engines sequential on development machines with little free RAM.
  await browser.close()
  const server = await webkit.launchServer({ host: '127.0.0.1' })
  t.signal.addEventListener('abort', () => { void server.kill().catch(() => {}) }, { once: true })
  try {
    const safari = await webkit.connect(server.wsEndpoint())
    const p = await page({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, hostedOrigin, safari)
    await expect(p.locator('#microphone')).not.toBeChecked()
    await p.locator('#sample').click()
    await expect(p.locator('#metrics')).toContainText('160×96 inference')
    await p.locator('#effect').selectOption('replace')
    assert.equal(await p.locator('#matte').evaluate(c => c.getContext('2d').getImageData(0, 0, 1, 1).data[3]), 255)
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await screenshot(p, 'iphone-webkit-lab')
    await p.locator('#reset').click()
    await expect(p.locator('#microphone-state')).toContainText('Microphone off')
    assert.deepEqual(unexpectedRequests, []); assert.deepEqual(errors, [])
  } finally { await server.kill() }
})
