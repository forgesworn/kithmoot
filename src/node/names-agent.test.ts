/**
 * An agent answers to its name, and only to its name.
 *
 * Kill condition: matching the name as a bare substring. Tally then wakes on
 * "totally", Wren on "wrench" and Quill on "quilling", and because the agent
 * does answer, and answers plausibly, nobody reads it as a bug. They read it
 * as an agent that butts in, and they mute it. The failure is invisible in
 * exactly the way that matters: nothing errors, nothing is logged, the room
 * just gets worse.
 */
import { describe, expect, it } from 'vitest'

import { namesAgent } from './brains.js'

describe('namesAgent', () => {
  it('answers to an @ mention, which is what the app types', () => {
    expect(namesAgent('@tally are you there', 'Tally')).toBe(true)
    expect(namesAgent('ask @quill about it', 'Quill')).toBe(true)
    expect(namesAgent('@tally', 'Tally')).toBe(true)
  })

  it('still answers to a bare name, because people typed names first', () => {
    expect(namesAgent('tally, where did we get to', 'Tally')).toBe(true)
    expect(namesAgent('that was quill i think', 'Quill')).toBe(true)
    expect(namesAgent('tally', 'Tally')).toBe(true)
  })

  it('does not wake on a word its name merely sits inside', () => {
    expect(namesAgent('that is totally fine', 'Tally')).toBe(false)
    expect(namesAgent('pass me the wrench', 'Wren')).toBe(false)
    expect(namesAgent('she took up quilling', 'Quill')).toBe(false)
    expect(namesAgent('we are tallying the votes', 'Tally')).toBe(false)
  })

  it('handles a name with a space in it', () => {
    expect(namesAgent('@the moot is the room', 'The moot')).toBe(true)
    expect(namesAgent('the mooted plan', 'The moot')).toBe(false)
  })

  it('does not treat a name as a regular expression', () => {
    expect(namesAgent('anything at all', 'a.*')).toBe(false)
    expect(namesAgent('talking about a.* here', 'a.*')).toBe(true)
  })

  it('is not fooled by an empty or blank name', () => {
    expect(namesAgent('anything', '')).toBe(false)
    expect(namesAgent('anything', '   ')).toBe(false)
  })
})
