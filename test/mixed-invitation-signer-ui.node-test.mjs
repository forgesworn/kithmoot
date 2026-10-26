import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openPrivateSignerPicker } from './mixed-invitation-signer-ui.mjs'
function ui({ mode = 'private-invitations', home = true, account = false, header = false, open = false, settingsPage = 'main' } = {}) {
  const clicks = []
  return { clicks, locator(id) { return {
    async textContent() { return id === '#accountNetworkStatus' ? 'Rendered policy disclosure' : mode === 'nostr' ? 'Account network: Nostr' : 'Account network: private invitations' },
    async isVisible() { return id === '#homeSignIn' ? home : id === '#headerSignIn' ? header : id === '#signIn' ? account : id === '#signet-login-dialog' ? open : false },
    async click() { clicks.push(id); if (id === '#settingsRowaccount') account = true; else if (id === '#settingsBack') settingsPage = 'main'; else if (['#homeSignIn', '#headerSignIn', '#signIn'].includes(id)) open = true; else if (id !== '#openAppSettings') throw Error('Unexpected UI selector') },
    async getAttribute(name) { assert.equal(id, '#settingsPane'); assert.equal(name, 'data-page'); return settingsPage },
    async waitFor(value) { assert.deepEqual(value, { state: 'visible' }); if (id === '#signIn') assert.equal(account, true); else { assert.equal(id, '#signet-login-dialog'); assert.equal(open, true) } },
  } } }
}
test('explicit private connection uses the visible product home button', async () => {
  const page = ui()
  assert.deepEqual(await openPrivateSignerPicker(page), { opened: true, existingPicker: false })
  assert.deepEqual(page.clicks, ['#homeSignIn'])
})
test('account button is fallback and existing picker does not trigger a second click', async () => {
  const page = ui({ home: false, account: true })
  await openPrivateSignerPicker(page); await openPrivateSignerPicker(page)
  assert.deepEqual(page.clicks, ['#signIn'])
})
test('wrong mode or absent real UI controls refuse before any click', async () => {
  for (const config of [{ mode: 'nostr' }]) {
    const page = ui(config)
    await assert.rejects(openPrivateSignerPicker(page))
    assert.deepEqual(page.clicks, [])
  }
})

test('returning home uses exact header action; Settings Account is the fixed hidden-button fallback', async () => {
  const header = ui({ home: false, header: true })
  await openPrivateSignerPicker(header)
  assert.deepEqual(header.clicks, ['#headerSignIn'])
  const settings = ui({ home: false, settingsPage: 'connections' })
  await openPrivateSignerPicker(settings)
  assert.deepEqual(settings.clicks, ['#openAppSettings', '#settingsBack', '#settingsRowaccount', '#signIn'])
})
