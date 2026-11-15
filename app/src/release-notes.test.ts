import { it, expect } from 'vitest'
import { parseReleaseNotes } from './release-notes.js'
it('accepts bounded plain text notes and rejects malformed or oversized documents', () => {
  const valid = {id:'a',date:'today',title:'Changes',changes:['New feature'],desktopVersion:'0.1.159'}
  expect(parseReleaseNotes(valid)).toEqual(valid)
  for (const value of [null,{}, {...valid,changes:[]},{...valid,changes:['x'.repeat(1001)]},{...valid,desktopVersion:123}]) expect(parseReleaseNotes(value)).toBeUndefined()
})
