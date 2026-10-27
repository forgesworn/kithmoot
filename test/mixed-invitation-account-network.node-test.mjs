import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { accountNetworkDto, accountNetworkState, chooseAccountNetwork } from './mixed-invitation-account-network.mjs'

const label = mode => mode === 'nostr' ? 'Account network: Nostr' : 'Account network: private invitations'
function ui({ mode = 'private-invitations', home = true, settings = false, panel = false } = {}) {
  const calls = [], current = { mode, dialog: false, panel }
  return { calls, current, locator(id) { return {
    async textContent() { return id === '#accountNetworkStatus' ? 'Rendered status for ' + current.mode : label(current.mode) },
    async isVisible() { return id === '#homeAccountNetwork' ? home : id === '#accountNetworkOpen' ? settings : id === '#accountNetworkDialog' ? current.dialog : id === '#mlsRoomDevelopment' ? current.panel : false },
    async waitFor(value) { calls.push(['wait', id, value.state]); assert.equal(current.dialog, true) },
    async click() {
      calls.push(['click', id])
      if (id === '#homeAccountNetwork' || id === '#accountNetworkOpen') current.dialog = true
      else if (id === '#enableNostrNetwork' || id === '#choosePrivateInvitations') { assert.equal(current.dialog, true); current.mode = id === '#enableNostrNetwork' ? 'nostr' : 'private-invitations' }
      else if (id === '#accountNetworkClose') current.dialog = false
      else if (id === '#mlsRoomDevelopment [data-close]') current.panel = false
      else throw Error('Unexpected UI control')
    },
  } } }
}
test('rendered state contains only validated mode, visibility and a status digest', async () => {
  const page = ui(), state = await accountNetworkState(page)
  assert.deepEqual(state, { mode: 'private-invitations', dialogVisible: false, statusLength: 39,
    statusSha256: createHash('sha256').update('Rendered status for private-invitations').digest('hex') })
  assert.deepEqual(page.calls, [])
  for (const labels of [[], ['Account network: Nostr'], ['Account network: Nostr', 'Account network: private invitations'], ['unknown', 'unknown']]) assert.throws(() => accountNetworkDto(labels, 'status', false))
  assert.throws(() => accountNetworkDto([label('nostr'), label('nostr')], '', false))
})
test('one opt-in and return use visible opener and exact controls; modal is closed', async () => {
  const page = ui({ panel: true })
  assert.equal((await chooseAccountNetwork(page, 'nostr')).mode, 'nostr')
  assert.equal((await chooseAccountNetwork(page, 'private-invitations')).chosenThroughUi, true)
  assert.equal(page.current.dialog, false)
  assert.deepEqual(page.calls.filter(call => call[0] === 'click').map(call => call[1]), [
    '#mlsRoomDevelopment [data-close]', '#homeAccountNetwork', '#enableNostrNetwork', '#accountNetworkClose',
    '#homeAccountNetwork', '#choosePrivateInvitations', '#accountNetworkClose'])
})
test('settings opener is used only if visible; no opener refuses without a mode click', async () => {
  const settings = ui({ home: false, settings: true })
  await chooseAccountNetwork(settings, 'nostr')
  assert.equal(settings.calls[0][1], '#accountNetworkOpen')
  const hidden = ui({ home: false })
  await assert.rejects(chooseAccountNetwork(hidden, 'nostr'), /Visible/)
  assert.deepEqual(hidden.calls, [])
})
test('unknown or coerced modes refuse before any UI activity', async () => {
  for (const mode of [undefined, null, '', 'private', 'Nostr', ['nostr'], {}, 'nostr ']) {
    const page = ui()
    await assert.rejects(chooseAccountNetwork(page, mode), /Exact supported/)
    assert.deepEqual(page.calls, [])
  }
})
