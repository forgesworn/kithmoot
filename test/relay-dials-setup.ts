import { beforeEach } from 'vitest'
import { relayDials } from '../src/relay-dial-gate.js'

// Every pool in a process shares one dial backoff, so a relay one test left
// failing would hold up the next test's pools on the same URL.
beforeEach(() => { relayDials.clear() })
