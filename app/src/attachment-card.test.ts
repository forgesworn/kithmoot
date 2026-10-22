import { describe, expect, it } from 'vitest'
import { openingErrorText } from './attachment-card.js'

describe('openingErrorText', () => {
  it.each(['404', '410'])('says the file is no longer there when the server answered %s', status => {
    expect(openingErrorText(new Error(`blossom.example answered ${status}`), 'blossom.example')).toBe('This file is no longer on blossom.example.')
  })
  it('says the server could not be reached on a network failure', () => {
    expect(openingErrorText(new TypeError('Failed to fetch'), 'blossom.example')).toBe('Couldn’t reach blossom.example. Try again.')
  })
})
