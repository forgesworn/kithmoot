import { afterEach, expect, it, vi } from 'vitest'
import { withMlsDeviceAdmissionGate } from './mls-device-admission-gate.js'

afterEach(() => vi.unstubAllGlobals())
it('rejects ambiguous, sparse and coercible device bindings before acquiring any lock or running effects', async () => {
  const request = vi.fn(), work = vi.fn(async () => 'effect')
  vi.stubGlobal('navigator', { locks: { request } })
  for (const devices of [[], ['ab'.repeat(32) + '\n'], ['AB'.repeat(32)], [new String('ab'.repeat(32))], new Array(1), { toString: () => 'ab'.repeat(32) }, new Array(65).fill('ab'.repeat(32))]) {
    await expect(withMlsDeviceAdmissionGate(devices as any, 'shared', work)).rejects.toThrow('Invalid MLS device admission gate binding')
  }
  await expect(withMlsDeviceAdmissionGate(['ab'.repeat(32)], 'invalid' as any, work)).rejects.toThrow('Invalid MLS device admission gate binding')
  expect(request).not.toHaveBeenCalled(); expect(work).not.toHaveBeenCalled()
})
it('does not run work through a fallback when Web Locks are unavailable', async () => {
  const work = vi.fn(async () => 'effect')
  vi.stubGlobal('navigator', {})
  await expect(withMlsDeviceAdmissionGate(['ab'.repeat(32)], 'shared', work)).rejects.toThrow()
  expect(work).not.toHaveBeenCalled()
})
