import { describe, expect, it } from 'vitest'
import { GENERIC_FAILURE_COPY, NETWORK_FAILURE_COPY, NODE_BUSY_COPY, NODE_CALLS_FULL_COPY, NODE_CALLS_FULL_GRACE_MS, NODE_FULL_COPY, NODE_SILENT_COPY, PersonError, describeFailure, isNetworkFailure, isRetryableNodeFailure, nodeCreateRetryDelay, nodeRetryCopy, refuseNodeCallStart, showNodeCallsFull } from './error-copy.js'
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

  it('says a node is full, and does not retry, when it holds its room limit', () => {
    const full = new KithmootNodeError(429, 'unavailable', 'too-many-rooms')
    expect(describeFailure(full)).toBe(NODE_FULL_COPY)
    expect(isRetryableNodeFailure(full)).toBe(false)
    expect(isRetryableNodeFailure(new KithmootNodeError(429, 'unavailable', 'request-limit'))).toBe(true)
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

describe('node calls full', () => {
  const base = { othersOnCall: 1, reached: 0, neverReached: 1, waitedMs: 0 }
  it('uses plain words that name calls, not rooms', () => {
    expect(NODE_CALLS_FULL_COPY).toBe("This node has no more room for calls. Space frees up when someone leaves a call.")
    expect(NODE_CALLS_FULL_COPY).not.toBe(NODE_FULL_COPY)
  })
  it('stays quiet once the call reaches everybody on it, or with nobody to reach', () => {
    expect(showNodeCallsFull({ ...base, reached: 1, nodeFull: true, refusal: 486, waitedMs: 60000 })).toBe(false)
    expect(showNodeCallsFull({ ...base, othersOnCall: 2, reached: 3, nodeFull: true, refusal: 486 })).toBe(false)
    expect(showNodeCallsFull({ ...base, othersOnCall: 0, nodeFull: true, refusal: 486, waitedMs: 60000 })).toBe(false)
  })
  it('says full when one partner is reached and another refused', () => {
    expect(showNodeCallsFull({ ...base, othersOnCall: 2, reached: 1, refusal: 486 })).toBe(true)
    expect(showNodeCallsFull({ ...base, othersOnCall: 2, reached: 1, nodeFull: true, waitedMs: 60000 })).toBe(true)
  })
  it('does not blame a full node for a partner who was reached and dropped', () => {
    expect(showNodeCallsFull({ ...base, othersOnCall: 2, reached: 1, neverReached: 0, nodeFull: true, waitedMs: 60000 })).toBe(false)
    expect(showNodeCallsFull({ ...base, neverReached: 0, nodeFull: true, waitedMs: 60000 })).toBe(false)
  })
  it('says full at once when the relay refuses for capacity and the node agrees or is silent', () => {
    expect(showNodeCallsFull({ ...base, refusal: 486, nodeFull: true })).toBe(true)
    expect(showNodeCallsFull({ ...base, refusal: 508 })).toBe(true)
    // An older node without the field: on a small node the per-login share is the limit.
    expect(showNodeCallsFull({ ...base, refusal: 486 })).toBe(true)
  })
  it('does not blame the node when it says there is room: the 486 was this login\'s own share', () => {
    expect(showNodeCallsFull({ ...base, refusal: 486, nodeFull: false, waitedMs: 60000 })).toBe(false)
  })
  it('never reads an access refusal as full', () => {
    for (const refusal of [401, 403, 701]) expect(showNodeCallsFull({ ...base, refusal, waitedMs: 0 })).toBe(false)
    expect(showNodeCallsFull({ ...base, refusal: 403, nodeFull: false, waitedMs: 60000 })).toBe(false)
  })
  it('tells the person already on the call, whose partner was refused, after the grace', () => {
    expect(showNodeCallsFull({ ...base, nodeFull: true, waitedMs: NODE_CALLS_FULL_GRACE_MS - 1 })).toBe(false)
    expect(showNodeCallsFull({ ...base, nodeFull: true, waitedMs: NODE_CALLS_FULL_GRACE_MS })).toBe(true)
    expect(showNodeCallsFull({ ...base, waitedMs: 60000 })).toBe(false)
  })
  it('refuses to start only on the node\'s word and with no live connection', () => {
    expect(refuseNodeCallStart({ nodeFull: true, connected: false })).toBe(true)
    expect(refuseNodeCallStart({ nodeFull: true, connected: true })).toBe(false)
    expect(refuseNodeCallStart({ nodeFull: false, connected: false })).toBe(false)
    expect(refuseNodeCallStart({ connected: false })).toBe(false)
  })
})
