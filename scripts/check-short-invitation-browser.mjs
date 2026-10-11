import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createDecipheriv } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from '@playwright/test'

const root = fileURLToPath(new URL('../', import.meta.url))
const vectors = JSON.parse(readFileSync(resolve(root, 'vectors/short-invitation-envelope.json'), 'utf8')).vectors
const server = await createServer({ configFile: false, root, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'isolated-codec-review', configureServer(s) {
  s.middlewares.use((req, res, next) => {
    if (req.url !== '/__codec-review') return next()
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Isolated synthetic codec review</title>')
  })
} }] })
let browser
try {
  await server.listen()
  const port = server.httpServer.address().port
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const external = []
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === `http://127.0.0.1:${port}`) return route.continue()
    external.push(url.origin); return route.abort()
  })
  await page.goto(`http://127.0.0.1:${port}/__codec-review`)
  const result = await page.evaluate(async vectors => {
    if (!isSecureContext || !crypto.subtle) throw new Error('Secure WebCrypto is required')
    const codec = await import('/app/src/short-invitation-envelope.ts')
    for (const vector of vectors) {
      if (await codec.openShortInvitation(vector.url, JSON.stringify(vector.envelope), vector.now) !== vector.fullInvitation) throw new Error('Independent vector did not match')
      let refused = false
      try { await codec.openShortInvitation(vector.url, JSON.stringify({ ...vector.envelope, expires: vector.envelope.expires + 1 }), vector.now) } catch { refused = true }
      if (!refused) throw new Error('Tampered expiry accepted')
    }
    const vector = vectors[0]
    return codec.sealShortInvitation(new URL(vector.url).pathname.slice(3), vector.fullInvitation, vector.envelope.expires, vector.now)
  }, vectors)
  const encrypted = Buffer.from(result.envelope.ciphertext, 'base64url')
  const url = new URL(result.url)
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(url.hash.slice(1), 'base64url'), Buffer.from(result.envelope.nonce, 'base64url'))
  decipher.setAAD(Buffer.from(`kithmoot-short-invite/v1:${url.pathname.slice(3)}:${result.envelope.expires}`))
  decipher.setAuthTag(encrypted.subarray(-16))
  const payload = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString())
  assert.equal(payload.url, vectors[0].fullInvitation)
  assert.deepEqual(external, [])
  const receipt = { passed: true, browser: browser.version(), syntheticOnly: true, independentVectors: vectors.length, browserCiphertextVerifiedByNode: true, externalRequests: external.length, admissionOrMembershipRequested: false, physicalAcceptance: false }
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(receipt))
} finally { await browser?.close(); await server.close() }
