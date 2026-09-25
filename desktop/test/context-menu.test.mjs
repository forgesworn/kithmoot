import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContextMenuTemplate } from '../context-menu.mjs'

const noActions = { replaceMisspelling: () => assert.fail('not expected'), copyLink: () => assert.fail('not expected'), openLink: () => assert.fail('not expected') }
const editFlags = { canCut: false, canCopy: false, canPaste: false, canSelectAll: false }

test('plain text with nothing selected offers nothing', () => {
  assert.deepEqual(buildContextMenuTemplate({ editFlags, isEditable: false }, noActions), [])
})

test('selected read-only text offers Copy and Select All only', () => {
  const template = buildContextMenuTemplate({
    editFlags: { ...editFlags, canCopy: true, canSelectAll: true }, isEditable: false,
  }, noActions)
  assert.deepEqual(template.map(i => i.role), ['copy', 'selectAll'])
})

test('an editable field with a selection offers cut, copy, paste, paste and match style, select all', () => {
  const template = buildContextMenuTemplate({
    editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true }, isEditable: true,
  }, noActions)
  assert.deepEqual(template.map(i => i.role), ['cut', 'copy', 'paste', 'pasteAndMatchStyle', 'selectAll'])
  const pasteAndMatch = template.find(i => i.role === 'pasteAndMatchStyle')
  assert.equal(pasteAndMatch.label, 'Paste and Match Style')
})

test('paste and match style is never offered outside an editable field, even if paste is technically possible', () => {
  const template = buildContextMenuTemplate({
    editFlags: { ...editFlags, canPaste: true }, isEditable: false,
  }, noActions)
  assert.deepEqual(template, [])
})

test('an http(s) link offers Copy Link and Open Link, after a separator when other items came first', () => {
  const template = buildContextMenuTemplate({
    editFlags: { ...editFlags, canCopy: true }, isEditable: false, linkURL: 'https://example.org/x',
  }, noActions)
  assert.deepEqual(template.map(i => i.role ?? i.type ?? i.label), ['copy', 'separator', 'Copy Link', 'Open Link'])
})

test('a link on its own, with nothing else selectable, offers only the link items with no leading separator', () => {
  const template = buildContextMenuTemplate({ editFlags, isEditable: false, linkURL: 'https://example.org/x' }, noActions)
  assert.deepEqual(template.map(i => i.label), ['Copy Link', 'Open Link'])
})

test('a non-http(s) link (mailto, javascript, file) is never offered as a link', () => {
  for (const url of ['mailto:a@example.org', 'javascript:alert(1)', 'file:///etc/passwd', '']) {
    assert.deepEqual(buildContextMenuTemplate({ editFlags, isEditable: false, linkURL: url }, noActions), [])
  }
})

test('clicking Copy Link and Open Link runs the given callback with the URL', () => {
  const seen = { copy: undefined, open: undefined }
  const template = buildContextMenuTemplate({ editFlags, isEditable: false, linkURL: 'https://example.org/x' }, {
    ...noActions, copyLink: url => { seen.copy = url }, openLink: url => { seen.open = url },
  })
  template.find(i => i.label === 'Copy Link').click()
  template.find(i => i.label === 'Open Link').click()
  assert.deepEqual(seen, { copy: 'https://example.org/x', open: 'https://example.org/x' })
})

test('spelling suggestions lead the menu, each running replaceMisspelling with its own word', () => {
  const seen = []
  const template = buildContextMenuTemplate({
    editFlags: { ...editFlags, canCopy: true }, isEditable: true, dictionarySuggestions: ['teh', 'the'],
  }, { ...noActions, replaceMisspelling: word => seen.push(word) })
  assert.deepEqual(template.map(i => i.label ?? i.type ?? i.role), ['teh', 'the', 'separator', 'copy'])
  template[0].click()
  template[1].click()
  assert.deepEqual(seen, ['teh', 'the'])
})

test('no dictionary suggestions means no spelling section and no leading separator', () => {
  const template = buildContextMenuTemplate({
    editFlags: { ...editFlags, canCopy: true }, isEditable: false, dictionarySuggestions: [],
  }, noActions)
  assert.deepEqual(template.map(i => i.role), ['copy'])
})
