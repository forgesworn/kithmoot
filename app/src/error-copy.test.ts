import { describe, expect, it } from 'vitest'
import { GENERIC_FAILURE_COPY, NETWORK_FAILURE_COPY, describeFailure, isNetworkFailure } from './error-copy.js'

describe('describeFailure', () => {
  it('collapses "every relay rejected" into the network line, with no relay address in it', () => {
    const err = new Error('every relay rejected the event (wss://nos.lol/: connection failure: websocket closed)')
    expect(isNetworkFailure(err)).toBe(true)
    const text = describeFailure(err)
    expect(text).toBe(NETWORK_FAILURE_COPY)
    expect(text).not.toContain('wss://')
  })

  it('collapses a relay timeout the same way', () => {
    expect(describeFailure(new Error('no relay could be reached in time (wss://relay.example/: timed out)'))).toBe(NETWORK_FAILURE_COPY)
  })

  it('falls back to a generic apology for anything else, rather than guessing', () => {
    expect(describeFailure(new Error('this device’s pass for this room has run out'))).toBe(GENERIC_FAILURE_COPY)
    expect(describeFailure('a bare string')).toBe(GENERIC_FAILURE_COPY)
  })
})
