import test from 'node:test'
import assert from 'node:assert/strict'
import { sourceForDisplay, sourceForPortal } from '../share-area-source.mjs'

test('matches the source carrying the native display id', () => {
  const source = { display_id: '42' }
  assert.equal(sourceForDisplay([{ display_id: '7' }, source], { id: 42 }, [{ id: 7 }, { id: 42 }]), source)
})

test('accepts an id-less Linux source only on a single-display desktop', () => {
  const source = { display_id: '' }
  assert.equal(sourceForDisplay([source], { id: 42 }, [{ id: 42 }]), source)
  assert.equal(sourceForDisplay([source], { id: 42 }, [{ id: 7 }, { id: 42 }]), undefined)
})

test('never guesses among multiple capture sources', () => {
  assert.equal(sourceForDisplay([{ display_id: '' }, { display_id: '' }], { id: 42 }, [{ id: 42 }]), undefined)
})

test('takes the one source the Wayland portal returned, id-less or not', () => {
  const source = { display_id: '' }
  assert.equal(sourceForPortal([source]), source)
  assert.equal(sourceForPortal([{ display_id: '3' }])?.display_id, '3')
})

test('refuses when the portal returned nothing or several sources', () => {
  assert.equal(sourceForPortal([]), undefined)
  assert.equal(sourceForPortal([{ display_id: '' }, { display_id: '' }]), undefined)
})
