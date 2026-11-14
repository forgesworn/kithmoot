import { describe, expect, it } from 'vitest'
import { GENERIC_FAILURE_COPY, NETWORK_FAILURE_COPY, NODE_BUSY_COPY, NODE_SILENT_COPY, PersonError, describeFailure, isNetworkFailure, isRetryableNodeFailure, nodeCreateRetryDelay, nodeRetryCopy } from './error-copy.js'
import { KithmootNodeError } from '../../src/kithmoot-node.js'

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

  it('says a node is busy when it turned the request away for load', () => {
    expect(describeFailure(new KithmootNodeError(429, 'unavailable'))).toBe(NODE_BUSY_COPY)
    expect(describeFailure(new KithmootNodeError(503, 'unavailable'))).toBe(NODE_BUSY_COPY)
  })

  it('says a node did not answer when no response came back', () => {
    expect(describeFailure(new KithmootNodeError(0, 'unavailable'))).toBe(NODE_SILENT_COPY)
  })

  it('reads a node refusal in its own words', () => {
    expect(describeFailure(new KithmootNodeError(403, 'refused'))).toBe('Your KithMoot node refused this request.')
  })

  it('shows a message written for the person as it stands', () => {
    expect(describeFailure(new PersonError('Pair your node under Settings → Calls → Your KithMoot node first.'))).toBe('Pair your node under Settings → Calls → Your KithMoot node first.')
  })

  it('retries only load and silence, never a refusal', () => {
    expect(isRetryableNodeFailure(new KithmootNodeError(429, 'unavailable'))).toBe(true)
    expect(isRetryableNodeFailure(new KithmootNodeError(0, 'unavailable'))).toBe(true)
    expect(isRetryableNodeFailure(new KithmootNodeError(403, 'refused'))).toBe(false)
    expect(isRetryableNodeFailure(new Error('every relay rejected the event'))).toBe(false)
  })

  it('waits past a busy node\'s minute before the last try', () => {
    const busy = new KithmootNodeError(429, 'unavailable')
    expect(nodeCreateRetryDelay(busy, 1) + nodeCreateRetryDelay(busy, 2)).toBeGreaterThanOrEqual(60000)
    expect(nodeCreateRetryDelay(new KithmootNodeError(0, 'unavailable'), 1)).toBeLessThan(10000)
  })

  it('says why it is waiting while it tries again', () => {
    expect(nodeRetryCopy(new KithmootNodeError(429, 'unavailable'))).toBe('Your node is busy. Trying again…')
    expect(nodeRetryCopy(new KithmootNodeError(0, 'unavailable'))).toBe('Your node did not answer. Trying again…')
  })
})
