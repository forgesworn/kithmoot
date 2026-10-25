import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
const vector = JSON.parse(readFileSync('test/fixtures/keeper-inbox-permission.json', 'utf8'))
let bundle: string
const origin = 'https://private-keeper-controls.kithmoot.test'
test.beforeAll(async () => { bundle = (await build({ entryPoints: ['test/mls-private-keeper-controls.browser-entry.ts'], bundle: true, write: false, format: 'iife', globalName: 'C', define: { 'import.meta.env.BASE_URL': '"/"' } })).outputFiles[0].text })
async function fixture(context: BrowserContext) {
  await context.route(origin + '/**', route => route.fulfill({ contentType: 'text/html', body: '<body><script>window.permissionVector=' + JSON.stringify(vector) + ';Date.now=()=>window.permissionVector.now*1000;</script><script>' + bundle + '</script>' }))
  const page = await context.newPage(); await page.goto(origin); await page.evaluate('C.open()'); return page
}
async function sender(page: Page) {
  await page.locator('[data-routes]').click(); await expect(page.locator('[data-route] option')).toHaveCount(2)
  await page.locator('[data-outbox]').click(); await expect(page.locator('[data-send-request] option')).toHaveCount(1)
  await page.locator('[data-send-permission]').fill(JSON.stringify(vector.active)); await page.locator('[data-inspect-permission]').click()
  await expect(page.locator('[data-permission-review]')).toContainText(vector.device)
}
async function prepare(page: Page) {
  await page.evaluate('C.keeperAccount()'); await page.locator('[data-routes]').click()
  await page.locator('[data-permission-device]').fill(vector.device); await page.locator('[data-prepare-permission]').click()
  await expect(page.locator('#actionDescription')).toContainText('active and terminal')
  await expect(page.locator('#actionDescription')).toContainText('Issuer ' + vector.keeper)
  await expect(page.locator('#actionDescription')).toContainText('route saved')
  await expect(page.locator('#actionDescription')).toContainText('node ' + vector.node)
  await expect(page.locator('#actionDescription')).toContainText('destination ' + vector.server)
  await page.locator('#actionConfirm').click(); await expect(page.locator('[data-permission-choice] option')).toHaveCount(1)
}
test('actual sender controls inspect the independent vector and invoke fresh purpose consent for send and explicit revision retry', async ({ context }) => {
  const page = await fixture(context); expect(await page.evaluate('C.calls')).toEqual([])
  await sender(page)
  await expect(page.locator('[data-send-review]')).toContainText('device being removed ' + '44'.repeat(32))
  await page.locator('[data-send-private]').click()
  await expect(page.locator('#actionDescription')).toContainText('transmitting device ' + vector.device)
  expect((await page.evaluate('C.calls') as any[]).some(c => c[0] === 'private-send')).toBe(false)
  await page.locator('#actionConfirm').click(); await expect(page.locator('[data-send-review]')).toContainText('revision 1; sent')
  await page.locator('[data-retry-private]').click(); await expect(page.locator('#actionConfirm')).toContainText('revision 1')
  await page.locator('#actionConfirm').click(); await expect(page.locator('[data-send-review]')).toContainText('revision 2; sent')
  const calls = await page.evaluate('C.calls') as any[]
  expect(calls.filter(c => c[0] === 'private-send')).toHaveLength(2); expect(calls.filter(c => c[0] === 'public-send')).toHaveLength(0)
  expect(calls.filter(c => c[0] === 'private-reserve').map(c => c[4])).toEqual([null,1])
})
for (const change of ['account','route','dialog','input']) test(`actual ${change} change prevents late consent from invoking private send`, async ({ context }) => {
  const page = await fixture(context); await sender(page); await page.locator('[data-send-private]').click(); await expect(page.locator('#actionDialog')).toBeVisible()
  if (change === 'account') await page.evaluate('C.changeAccount()')
  if (change === 'dialog') await page.evaluate('C.panel.close()')
  if (change === 'route') await page.evaluate("const e=document.querySelector('[data-route]'); e.value='other'; e.dispatchEvent(new Event('change'))")
  if (change === 'input') await page.evaluate("const e=document.querySelector('[data-send-permission]'); e.value='{}'; e.dispatchEvent(new Event('input'))")
  await page.locator('#actionConfirm').click(); await expect(page.locator('#actionDialog')).toHaveCount(0)
  expect((await page.evaluate('C.calls') as any[]).filter(c => c[0] === 'private-send' || c[0] === 'public-send')).toEqual([])
})
test('public sending remains a separate explicit choice with retained earlier-public status', async ({ context }) => {
  const page = await fixture(context); await sender(page); await page.locator('[data-directory]').fill('wss://explicit.invalid/')
  await page.locator('[data-send-public]').click(); await expect(page.locator('#actionDescription')).toContainText('separate action reads a public DM directory')
  await page.locator('#actionConfirm').click(); await expect(page.locator('[data-send-review]')).toContainText('earlier public attempt exists')
  const calls = await page.evaluate('C.calls') as any[]; expect(calls.filter(c => c[0] === 'public-send')).toHaveLength(1); expect(calls.filter(c => c[0] === 'private-reserve')).toHaveLength(0)
})
test('keeper controls prepare, retain unknown exact retries, export only installed ordinary JSON, then terminally revoke', async ({ context }) => {
  const page = await fixture(context); await prepare(page)
  await expect(page.locator('[data-export-permission]')).toBeDisabled()
  await page.evaluate('C.unknownPublish()'); await page.locator('[data-install-permission]').click(); await page.locator('#actionConfirm').click()
  await expect(page.locator('[data-saved-permission-review]')).toContainText('installing: unknown'); await expect(page.locator('[data-export-permission]')).toBeDisabled()
  await page.locator('[data-install-permission]').click(); await expect(page.locator('#actionDescription')).toContainText('revision 1')
  await page.locator('#actionConfirm').click(); await expect(page.locator('[data-export-permission]')).toBeEnabled()
  await page.locator('[data-export-permission]').click(); await expect.poll(async () => page.locator('[data-permission-export]').inputValue()).not.toBe('')
  expect(JSON.parse(await page.locator('[data-permission-export]').inputValue())).toEqual(vector.active)
  await page.locator('[data-revoke-permission]').click(); await page.locator('#actionConfirm').click(); await expect(page.locator('[data-saved-permission-review]')).toContainText('revoked')
  await expect(page.locator('[data-export-permission]')).toBeDisabled(); await expect(page.locator('[data-permission-export]')).toHaveValue('')
  const calls = await page.evaluate('C.calls') as any[], writes = calls.filter(c => c[0] === 'publish-permission')
  expect(writes.map(c => c[3])).toEqual([false,false,true]); expect(writes[0][4]).toBe(writes[1][4]); expect(JSON.parse(writes[2][4])).toEqual(vector.revoked)
})

test('keeper preparation confirmation becomes stale on account change before either statement is signed', async ({ context }) => {
  const page = await fixture(context); await page.evaluate('C.keeperAccount()'); await page.locator('[data-routes]').click()
  await page.locator('[data-permission-device]').fill(vector.device); await page.locator('[data-prepare-permission]').click()
  await expect(page.locator('#actionDescription')).toContainText('Issuer ' + vector.keeper)
  await expect(page.locator('#actionDescription')).toContainText('route saved')
  await page.evaluate('C.changeAccount()'); await page.locator('#actionConfirm').click()
  expect((await page.evaluate('C.calls') as any[]).filter(c => c[0] === 'prepare')).toEqual([])
})
