// Native link handoff in an isolated profile; no user account, camera or call.
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stopIsolatedApp } from './isolated-app.mjs'
const desktop = fileURLToPath(new URL('../', import.meta.url))
const profile = await mkdtemp(join(tmpdir(), 'kithmoot-spry-desktop-'))
const hash = '#spry=' + Buffer.from(JSON.stringify({ v: 1, endpoint: 'https://relay.example:3744', code: 'a'.repeat(43), expiresAt: Math.floor(Date.now() / 1000) + 180 })).toString('base64url')
let app
try {
  app = await electron.launch({ executablePath: process.env.DESKTOP_EXECUTABLE ?? resolve(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [...(process.env.DESKTOP_EXECUTABLE ? [] : [desktop]), `--user-data-dir=${profile}`, 'kithmoot://join' + hash],
    env: { ...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: profile }, timeout: 30000 })
  const page = await app.firstWindow()
  // The native HTTPS protocol forwards remote requests through main-process
  // net.fetch, so a renderer route cannot stand in for this generated relay.
  await app.evaluate(({ net }) => {
    const original = net.fetch
    globalThis.__spryClaims = 0
    net.fetch = async (request, ...options) => {
      const url = typeof request === 'string' ? request : request.url
      if (url !== 'https://relay.example:3744/v1/pairings/claim') return original(request, ...options)
      globalThis.__spryClaims++
      return new Response(JSON.stringify({ version: 1, id: 'b'.repeat(43), endpoint: 'https://relay.example:3744' }), {
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      })
    }
  })
  const dialog = page.getByRole('alertdialog', { name: 'Pair Spry with KithMoot?' })
  await expect(dialog).toBeVisible({ timeout: 30000 })
  expect(await app.evaluate(() => globalThis.__spryClaims)).toBe(0)
  await expect(page.getByRole('button', { name: 'Open KithMoot app', exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Pair Spry', exact: true }).click()
  await expect.poll(() => app.evaluate(() => globalThis.__spryClaims), { timeout: 15000 }).toBe(1)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('kithmoot.spry-pairing.v1'))).toBeTruthy()
  expect(new URL(page.url()).hash).toBe('')
  await app.evaluate(({ app }, link) => { app.emit('open-url', { preventDefault() {} }, link) }, 'kithmoot://join' + hash)
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await app.evaluate(() => globalThis.__spryClaims)).toBe(1)
  console.log('Native Spry cold/warm link handoff and explicit pairing passed in an isolated profile.')
} finally {
  await stopIsolatedApp(app, profile)
  await rm(profile, { recursive: true, force: true })
}
