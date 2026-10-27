import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PASSWORD_WORD_LIST } from '../meeting-code-words.mjs'
import { HOME, ORIGIN, CSP, ATTACHMENT_FRAME_CSP, appContentPolicy, invitationTarget, isAppUrl, isExternalUrl, localAsset, allowedPermissions, windowOpenAction } from '../policy.mjs'
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

test('only the bundled Girnel and attachment surfaces can be framed by the workspace', () => {
  assert.ok(CSP.includes("frame-src https://kithmoot.forgesworn.dev/j/girnel/ https://kithmoot.forgesworn.dev/j/attachment-frame.html;"))
  assert.ok(appContentPolicy(HOME).includes("frame-ancestors 'none'"))
  assert.ok(appContentPolicy(HOME + 'girnel/embedded/index.html').includes("frame-ancestors 'self'"))
  assert.equal(appContentPolicy('https://elsewhere.test/j/girnel/'), CSP)
  assert.equal(appContentPolicy(HOME + 'attachment-frame.html'), ATTACHMENT_FRAME_CSP)
  assert.ok(ATTACHMENT_FRAME_CSP.includes("default-src 'none'"))
  assert.ok(ATTACHMENT_FRAME_CSP.includes("connect-src 'none'"))
  assert.ok(ATTACHMENT_FRAME_CSP.includes("media-src kithmoot-attachment:"))
  assert.equal(appContentPolicy(HOME + 'attachment-frame.html/extra'), CSP)
  assert.equal(appContentPolicy('https://elsewhere.test/j/attachment-frame.html'), CSP)
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
test('a meeting code link may carry its password words in the fragment, and nothing else', () => {
  const words = 'ability-zoo-jasmine-forget'
  assert.equal(invitationTarget(`https://kithmoot.app/c/ABCDEFGH#${words}`), `${HOME}?c=ABCDEFGH#${words}`)
  assert.equal(invitationTarget(`https://kithmoot.app/c/abc-def-gh#${words}`), `${HOME}?c=ABCDEFGH#${words}`)
  assert.equal(invitationTarget(`kithmoot://c/ABCDEFGH#${words}`), `${HOME}?c=ABCDEFGH#${words}`)
  assert.equal(invitationTarget(`kithmoot://c/abc-def-gh#${words}`), `${HOME}?c=ABCDEFGH#${words}`)
  assert.equal(isAppUrl(invitationTarget(`kithmoot://c/ABCDEFGH#${words}`)), true)
  // The first and last words of the list, and the same word more than once.
  assert.equal(invitationTarget('https://kithmoot.app/c/ABCDEFGH#ability-ability-zoo-zoo'), `${HOME}?c=ABCDEFGH#ability-ability-zoo-zoo`)
  // An empty fragment is no fragment, as before.
  assert.equal(invitationTarget('https://kithmoot.app/c/ABCDEFGH#'), HOME + '?c=ABCDEFGH')
  for (const hash of ['x', 'ability-zoo-jasmine', 'ability-zoo-jasmine-forget-zoo', 'ability-zoo-jasmine-forgot', 'abilty-zoo-jasmine-forget',
    'ABILITY-ZOO-JASMINE-FORGET', 'Ability-zoo-jasmine-forget', 'ability%20zoo%20jasmine%20forget', 'ability zoo jasmine forget',
    'ability%2Dzoo%2Djasmine%2Dforget', 'ability+zoo+jasmine+forget', 'ability,zoo,jasmine,forget', 'ability_zoo_jasmine_forget',
    'ability--zoo-jasmine-forget', '-ability-zoo-jasmine-forget', 'ability-zoo-jasmine-forget-', 'ability-zoo-jasmine-forget.',
    'ability-zoo-jasmine-forget%0A', 'ability-zoo-jasmine-forget&c=ZZZZZZZZ', 'ability-zoo-jasmine-forget#x', '#ability-zoo-jasmine-forget',
    'abilityzoojasmineforget', 'ability-zoo-jasmine-forgét', 'eyJ2Ijoz', '..%2f..%2fetc', '<script>']) {
    for (const base of ['https://kithmoot.app/c/ABCDEFGH', 'kithmoot://c/ABCDEFGH']) assert.equal(invitationTarget(`${base}#${hash}`), undefined, hash)
  }
  // Valid words do not loosen anything else: query, host, path and credentials stay refused.
  for (const value of [`https://kithmoot.app/c/ABCDEFGH?x=1#${words}`, `kithmoot://c/ABCDEFGH?x=1#${words}`, `https://kithmoot.app/c/ABCDEFGH?c=ZZZZZZZZ#${words}`,
    `https://kithmoot.forgesworn.dev/c/ABCDEFGH#${words}`, `https://www.kithmoot.app/c/ABCDEFGH#${words}`, `http://kithmoot.app/c/ABCDEFGH#${words}`,
    `https://kithmoot.app/c/ABCDEFGH/#${words}`, `https://kithmoot.app/c/ABCDEFGH/x#${words}`, `https://kithmoot.app/x/ABCDEFGH#${words}`,
    `https://kithmoot.app/c/ABCDEFGI#${words}`, `https://kithmoot.app/c/ABCDEFG#${words}`, `https://user@kithmoot.app/c/ABCDEFGH#${words}`,
    `kithmoot://c/ABCDEFG#${words}`, `kithmoot://user@c/ABCDEFGH#${words}`, `kithmoot://join/ABCDEFGH#${words}`, `kithmoot://c/#${words}`,
    `https://kithmoot.app/c/#${words}`, `https://kithmoot.app/j/c/ABCDEFGH#${words}`]) {
    assert.equal(invitationTarget(value), undefined, value)
  }
  // The words never land anywhere but the fragment.
  const target = new URL(invitationTarget(`https://kithmoot.app/c/ABCDEFGH#${words}`))
  assert.equal(target.search, '?c=ABCDEFGH')
  assert.equal(target.hash, `#${words}`)
})
test('the word list the desktop checks against is the web app\'s frozen foregather en-v1 list', () => {
  const app = readFileSync(new URL('../../app/src/meeting-code-words-en-v1.txt', import.meta.url), 'utf8')
  assert.equal(PASSWORD_WORD_LIST, app)
  assert.equal(createHash('sha256').update(PASSWORD_WORD_LIST).digest('hex'), '0334930ebdfbc76e81ec914515d7567ca85738a6bf3069249d97df951d44661c')
  assert.equal(PASSWORD_WORD_LIST.split('\n').length, 2048)
})
test('anything that is not an invitation link is ignored', () => {
  for (const value of ['', '--no-sandbox', '/home/me/file#x', 'kithmoot://join', 'kithmoot://join#', 'kithmoot://signet#x',
    'kithmoot://join/other#x', 'kithmoot://user@join#x', 'https://kithmoot.forgesworn.dev/evil#x', 'https://kithmoot.forgesworn.dev.evil/j/#x',
    'http://kithmoot.forgesworn.dev/j/#x', 'https://user@kithmoot.app/j/#x', 'javascript:alert(1)#x', 'file:///j/#x']) {
    assert.equal(invitationTarget(value), undefined, value)
  }
})
