import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openPrivateSignerPicker } from './mixed-invitation-signer-ui.mjs'
function ui({ mode = 'private-invitations', home = true, account = false, open = false } = {}) {
  const clicks = []
  return { clicks, locator(id) { return {
    async textContent() { return id === '#accountNetworkStatus' ? 'Rendered policy disclosure' : mode === 'nostr' ? 'Account network: Nostr' : 'Account network: private invitations' },
    async isVisible() { return id === '#homeSignIn' ? home : id === '#signIn' ? account : id === '#signet-login-dialog' ? open : false },
    async click() { clicks.push(id); open = true },
    async waitFor(value) { assert.equal(id, '#signet-login-dialog'); assert.deepEqual(value, { state: 'visible' }); assert.equal(open, true) },
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
  for (const config of [{ mode: 'nostr' }, { home: false }]) {
    const page = ui(config)
    await assert.rejects(openPrivateSignerPicker(page))
    assert.deepEqual(page.clicks, [])
  }
})
