import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { NO_DICTIONARY_DOWNLOAD, keepSpellingLocal, usesSystemSpellchecker } from '../spellcheck.mjs'

function fakeSession() {
  const calls = []
  return {
    calls,
    setSpellCheckerDictionaryDownloadURL: url => calls.push(['url', url]),
    setSpellCheckerLanguages: languages => calls.push(['languages', languages]),
    setSpellCheckerEnabled: enabled => calls.push(['enabled', enabled]),
  }
}

test('Windows and Linux sessions get no spelling and no dictionary download', () => {
  for (const platform of ['win32', 'linux']) {
    const ses = fakeSession()
    assert.equal(keepSpellingLocal(ses, platform), true)
    // The address goes first, so a download already queued cannot reach Google.
    assert.deepEqual(ses.calls, [['url', NO_DICTIONARY_DOWNLOAD], ['languages', []], ['enabled', false]])
    assert.equal(usesSystemSpellchecker(platform), false)
  }
})

test('the download address stays on this machine', () => {
  const url = new URL(NO_DICTIONARY_DOWNLOAD)
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.port, '9')
})

test('macOS keeps its own spellchecker untouched', () => {
  const ses = fakeSession()
  assert.equal(keepSpellingLocal(ses, 'darwin'), false)
  assert.deepEqual(ses.calls, [])
  assert.equal(usesSystemSpellchecker('darwin'), true)
})

test('main.mjs applies it to both sessions before any window, and spells only on macOS', async () => {
  const main = await readFile(new URL('../main.mjs', import.meta.url), 'utf8')
  const ready = main.indexOf('app.whenReady().then(async () => {')
  const applied = main.indexOf('keepSpellingLocal(', ready)
  assert.ok(ready > 0 && applied > ready, 'keepSpellingLocal runs in the ready handler')
  assert.ok(applied < main.indexOf('ipcMain.handle(', ready), 'and before anything else there')
  const line = main.slice(main.lastIndexOf('\n', applied), main.indexOf('\n', applied))
  assert.match(line, /session\.defaultSession/)
  assert.match(line, /session\.fromPartition\(DESKTOP_PARTITION\)/)
  assert.doesNotMatch(main, /spellcheck: true/)
  assert.match(main, /spellcheck: usesSystemSpellchecker\(\)/)
})
