import { afterEach, expect, test, vi } from 'vitest'
import { boxLabTraceObserver, readBoxLabTrace, startBoxLabTrace } from './mls-box-lab-trace.js'
afterEach(() => vi.unstubAllEnvs())
test('trace requires the explicit development lab', () => {
  vi.stubEnv('DEV', false); vi.stubEnv('VITE_MIXED_INVITATION_LAB', 'true')
  expect(boxLabTraceObserver()).toBeUndefined()
  expect(() => startBoxLabTrace()).toThrow()
})
test('trace output drops extra fields, stays bounded and does not return its mutable buffer', () => {
  vi.stubEnv('DEV', true); vi.stubEnv('VITE_MIXED_INVITATION_LAB', 'true')
  startBoxLabTrace(); const record = boxLabTraceObserver()!
  for (let i = 0; i < 257; i++) record({ request: 1, phase: 'sign-start', elapsedMs: i, authorization: 'private-should-not-retain', body: 'private' } as any)
  const read = readBoxLabTrace()
  expect(read.events).toHaveLength(256); expect(read.overflow).toBe(true)
  expect(JSON.stringify(read)).not.toContain('private')
  read.events[0].elapsedMs = -1
  expect(readBoxLabTrace().events[0].elapsedMs).toBe(0)
})

test('unknown phases, result strings and non-finite timing values cannot enter a trace', () => {
  vi.stubEnv('DEV', true); vi.stubEnv('VITE_MIXED_INVITATION_LAB', 'true')
  startBoxLabTrace(); const record = boxLabTraceObserver()!
  for (const changed of [{phase:'private-value'},{result:'private-value'},{elapsedMs:Infinity},{request:-1}]) record({request:1,phase:'sign-start',elapsedMs:0,...changed} as any)
  expect(readBoxLabTrace()).toEqual({ events:[],overflow:false })
})


test('transport resolution retains only validated status and drops response details', () => {
  vi.stubEnv('DEV', true); vi.stubEnv('VITE_MIXED_INVITATION_LAB', 'true')
  startBoxLabTrace(); const record = boxLabTraceObserver()!
  for (const status of [200, 403, 599, 'malformed']) record({ request: 1, phase: 'transport-end', elapsedMs: 30000, status,
    headers: 'private-headers', body: 'private-body', authorization: 'private-auth', path: 'private-path', routeId: 'private-route' } as any)
  expect(readBoxLabTrace().events.map(e => e.status)).toEqual([200, 403, 599, 'malformed'])
  expect(JSON.stringify(readBoxLabTrace())).not.toContain('private')
  for (const status of [199, 600, 200.5, NaN, Infinity, '403', 'private']) record({ request: 1, phase: 'transport-end', elapsedMs: 0, status } as any)
  record({ request: 1, phase: 'sign-start', elapsedMs: 0, status: 200 } as any)
  expect(readBoxLabTrace().events).toHaveLength(4)
})
