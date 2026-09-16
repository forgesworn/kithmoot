import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOME, ORIGIN, isAppUrl, isExternalUrl, localAsset, allowedPermissions } from '../policy.mjs'
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
