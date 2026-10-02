import { defineConfig, devices } from '@playwright/test'

// The MLS device vault in a real browser (ticket P3-01): IndexedDB,
// non-extractable WebCrypto keys and Web Locks across two tabs. It needs no
// app build or relay: the spec bundles the vault and serves it on a routed
// https origin.
export default defineConfig({
  testDir: 'test',
  testMatch: ['mls-vault.spec.ts'],
  timeout: 60_000,
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
})
