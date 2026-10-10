import { test, expect } from '@playwright/test'
import { build } from 'esbuild'

let bundle: string
test.beforeAll(async () => { bundle = (await build({ entryPoints: ['test/mls-membership-panel.browser-entry.ts'], bundle: true, write: false, format: 'iife', globalName: 'M' })).outputFiles[0].text })
test.beforeEach(async ({ page }) => {
  await page.setContent(`<script>${bundle}</script>`)
  await page.evaluate(() => (window as any).M.init())
})

test('reviews exact leaves and node-wide grants before recording a compromised removal', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Current MLS members' })).toBeVisible()
  await expect(page.getByText('Ada')).toBeVisible(); await expect(page.getByText('Tablet')).toBeVisible()
  await page.getByRole('button', { name: 'Remove device' }).click()
  await expect(page.getByText('1 MLS leaf will be removed from future epochs.')).toBeVisible()
  await expect(page.getByText(/will stay live because another saved room still uses it/)).toBeVisible()
  await expect(page.getByText(/Planning room.*Finance room/)).toBeVisible()
  await page.getByLabel(/Treat this device as compromised/).check()
  await expect(page.getByText(/will be revoked immediately/)).toBeVisible()
  await expect(page.getByText(/Saved affected rooms: Planning room.*Finance room/)).toBeVisible()
  await page.getByRole('button', { name: 'Record and start removal' }).click()
  await expect(page.getByText('Removed from future room epochs and its listed box grants are revoked.')).toBeVisible()
  await expect(page.getByText(/MLS Remove: applied at this browser and witnessed/)).toBeVisible()
  await expect(page.getByText(/revoked at the box/)).toBeVisible()
  expect(await page.evaluate(() => (window as any).M.history())).toEqual([`begin:device:true`, `advance:${'66'.repeat(32)}`])
})

test('offers person removal separately and states that credentials remain unchanged', async ({ page }) => {
  await page.getByRole('button', { name: 'Remove person' }).click()
  await expect(page.getByText('Remove Ada and all 1 of their current devices?')).toBeVisible()
  await expect(page.getByText('The person credential remains unchanged unless a separate tombstone is observed.')).toBeVisible()
  await expect(page.getByLabel(/Treat this device as compromised/)).toBeDisabled()
})

test('a cancelled plan cannot be confirmed after the next review fails', async ({ page }) => {
  await page.getByRole('button', { name: 'Remove device' }).click()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.evaluate(() => (window as any).M.rejectPlans())
  await page.getByRole('button', { name: 'Remove device' }).click()
  await expect(page.getByText('membership changed during review')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Record and start removal' })).toBeDisabled()
  expect(await page.evaluate(() => (window as any).M.history())).toEqual([])
})
