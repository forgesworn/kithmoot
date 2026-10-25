// Native link handoff in an isolated profile; no user account, camera or call.
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const desktop = fileURLToPath(new URL('../', import.meta.url))
const profile = await mkdtemp(join(tmpdir(), 'kithmoot-spry-desktop-'))
const hash = '#spry=' + Buffer.from(JSON.stringify({ v: 1, endpoint: 'https://relay.example:3744', code: 'a'.repeat(43), expiresAt: Math.floor(Date.now() / 1000) + 180 })).toString('base64url')
let app
try {
  app = await electron.launch({ executablePath: process.env.DESKTOP_EXECUTABLE ?? resolve(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [...(process.env.DESKTOP_EXECUTABLE ? [] : [desktop]), `--user-data-dir=${profile}`, 'kithmoot://join' + hash],
    env: { ...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: profile }, timeout: 30000 })
  const page = await app.firstWindow()
  let claims = 0
  await page.route('https://relay.example:3744/**', async route => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'authorization,content-type' }
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    claims++
    await route.fulfill({ headers, json: { version: 1, id: 'b'.repeat(43), endpoint: 'https://relay.example:3744' } })
  })
  const dialog = page.getByRole('alertdialog', { name: 'Pair Spry with KithMoot?' })
  await expect(dialog).toBeVisible({ timeout: 30000 })
  expect(claims).toBe(0)
  await expect(page.getByRole('button', { name: 'Open KithMoot app', exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Pair Spry', exact: true }).click()
  await expect.poll(() => claims).toBe(1)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('kithmoot.spry-pairing.v1'))).toBeTruthy()
  expect(new URL(page.url()).hash).toBe('')
  await app.evaluate(({ app }, link) => { app.emit('open-url', { preventDefault() {} }, link) }, 'kithmoot://join' + hash)
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(claims).toBe(1)
  console.log('Native Spry cold/warm link handoff and explicit pairing passed in an isolated profile.')
} finally { await app?.close(); await rm(profile, { recursive: true, force: true }) }
