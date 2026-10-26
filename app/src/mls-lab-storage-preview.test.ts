import { afterEach, expect, test, vi } from 'vitest'
import { labStoragePreviewEnabled } from './mls-lab-storage-preview.js'
afterEach(() => vi.unstubAllEnvs())
test.each([
  [true, true, true, false, true],
  [true, true, false, true, true],
  [false, true, true, false, false],
  [false, true, false, true, false],
  [true, false, false, true, false],
  [true, true, false, false, false],
  [true, true, true, true, false],
])('storage lab gate binds DEV=%s outer=%s legacy=%s admin=%s', (dev, outer, legacy, admin, expected) => {
  vi.stubEnv('DEV', dev)
  vi.stubEnv('VITE_BROWSER_MLS_PREVIEW', String(outer))
  vi.stubEnv('VITE_BROWSER_MLS_INVITATION_PREVIEW', String(legacy))
  vi.stubEnv('VITE_BROWSER_MLS_ADMIN_INVITATION_PREVIEW', String(admin))
  expect(labStoragePreviewEnabled()).toBe(expected)
})
