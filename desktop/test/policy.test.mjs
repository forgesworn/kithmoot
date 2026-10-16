import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOME, ORIGIN, CSP, appContentPolicy, invitationTarget, isAppUrl, isExternalUrl, localAsset, allowedPermissions, windowOpenAction } from '../policy.mjs'
test('only the bundled top-level page may navigate inside the app', () => {
  assert.equal(isAppUrl(HOME + '#invite'), true)
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', ORIGIN + '/evil', 'https://kithmoot.forgesworn.dev.evil/j/', 'https://user@kithmoot.forgesworn.dev/j/']) assert.equal(isAppUrl(url), false)
})
test('asset requests cannot escape bundle or install service workers', () => {
  assert.equal(localAsset(HOME, '/app/web'), '/app/web/index.html')
  assert.equal(localAsset(HOME + 'assets/main.js', '/app/web'), '/app/web/assets/main.js')
  for (const url of [HOME + '..%2fsecret', HOME + 'assets/%2e%2e%2f%2e%2e%2fsecret', HOME + '%00', HOME + '%5csecret', HOME + '%ZZ', HOME + 'sw.js']) assert.equal(localAsset(url, '/app/web'), null)
  assert.equal(localAsset(ORIGIN + '/turn', '/app/web'), undefined)
})
test('external schemes and ambient sensitive permissions are denied', () => {
  for (const url of ['javascript:alert(1)', 'file:///tmp/a', 'smb://server', 'https://user:pass@example.org']) assert.equal(isExternalUrl(url), false)
  assert.equal(isExternalUrl('https://example.org'), true)
  for (const permission of ['clipboard-read', 'geolocation', 'usb', 'serial', 'openExternal']) assert.equal(allowedPermissions.has(permission), false)
})

test('only a window the app writes into itself may open here', () => {
  for (const blank of ['', 'about:blank']) assert.equal(windowOpenAction(blank), 'own-window')
  for (const url of [HOME, ORIGIN + '/evil', 'https://example.org', 'javascript:alert(1)', 'file:///etc/passwd', 'about:blank#x']) assert.equal(windowOpenAction(url), 'external')
})

test('only the bundled Girnel surface can be framed by the workspace', () => {
  assert.ok(CSP.includes("frame-src https://kithmoot.forgesworn.dev/j/girnel/"))
  assert.ok(appContentPolicy(HOME).includes("frame-ancestors 'none'"))
  assert.ok(appContentPolicy(HOME + 'girnel/embedded/index.html').includes("frame-ancestors 'self'"))
  assert.equal(appContentPolicy('https://elsewhere.test/j/girnel/'), CSP)
})
test('an invitation opens the bundled page with its query and fragment unchanged', () => {
  assert.equal(invitationTarget('kithmoot://join#eyJ2Ijoz'), HOME + '#eyJ2Ijoz')
  assert.equal(invitationTarget('kithmoot://join?x=1#eyJ2Ijoz'), HOME + '?x=1#eyJ2Ijoz')
  assert.equal(invitationTarget('https://kithmoot.forgesworn.dev/j/#eyJ2Ijoz'), HOME + '#eyJ2Ijoz')
  assert.equal(invitationTarget('https://kithmoot.app/j#eyJ2Ijoz'), HOME + '#eyJ2Ijoz')
  for (const target of [invitationTarget('kithmoot://join#a'), invitationTarget('https://kithmoot.app/j/#a')]) assert.equal(isAppUrl(target), true)
})
test('meeting code links open the join page with the code, and nothing looser', () => {
  assert.equal(invitationTarget('https://kithmoot.app/c/ABCDEFGH'), HOME + '?c=ABCDEFGH')
  assert.equal(invitationTarget('https://kithmoot.app/c/ABC-DEF-GH'), HOME + '?c=ABCDEFGH')
  assert.equal(invitationTarget('https://kithmoot.app/c/abcdefgh'), HOME + '?c=ABCDEFGH')
  assert.equal(invitationTarget('kithmoot://c/ABCDEFGH'), HOME + '?c=ABCDEFGH')
  assert.equal(invitationTarget('kithmoot://c/abc-def-gh'), HOME + '?c=ABCDEFGH')
  assert.equal(isAppUrl(invitationTarget('kithmoot://c/ABCDEFGH')), true)
  for (const value of ['https://kithmoot.forgesworn.dev/c/ABCDEFGH', 'https://www.kithmoot.app/c/ABCDEFGH', 'http://kithmoot.app/c/ABCDEFGH',
    'https://kithmoot.app/c/ABCDEFGH#x', 'https://kithmoot.app/c/ABCDEFGH?x=1', 'https://kithmoot.app/c/ABCDEFGH/', 'https://kithmoot.app/c/ABCDEFG',
    'https://kithmoot.app/c/ABCDEFGHJ', 'https://kithmoot.app/c/ABCDEFGI', 'https://kithmoot.app/c/ABCDEFGL', 'https://kithmoot.app/c/ABCDEFGO',
    'https://kithmoot.app/c/ABCDEFGU', 'https://kithmoot.app/c/AB-CDEF-GH', 'https://kithmoot.app/c/ABC%20DEF', 'https://kithmoot.app/c/',
    'https://kithmoot.app/c/ABCDEFGH/x', 'https://kithmoot.app/x/ABCDEFGH', 'https://user@kithmoot.app/c/ABCDEFGH', 'kithmoot://c/ABCDEFGH#x',
    'kithmoot://c/ABCDEFGH?x=1', 'kithmoot://c/', 'kithmoot://c', 'kithmoot://join/ABCDEFGH', 'kithmoot://user@c/ABCDEFGH', 'kithmoot://c/ABCDEFG',
    'kithmoot://c/ABCDEFGH%0A']) {
    assert.equal(invitationTarget(value), undefined, value)
  }
})
test('anything that is not an invitation link is ignored', () => {
  for (const value of ['', '--no-sandbox', '/home/me/file#x', 'kithmoot://join', 'kithmoot://join#', 'kithmoot://signet#x',
    'kithmoot://join/other#x', 'kithmoot://user@join#x', 'https://kithmoot.forgesworn.dev/evil#x', 'https://kithmoot.forgesworn.dev.evil/j/#x',
    'http://kithmoot.forgesworn.dev/j/#x', 'https://user@kithmoot.app/j/#x', 'javascript:alert(1)#x', 'file:///j/#x']) {
    assert.equal(invitationTarget(value), undefined, value)
  }
})
