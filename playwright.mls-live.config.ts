import { defineConfig, devices } from '@playwright/test'

// Opt-in disposable-daemon lab. Never points at a keeper's existing data.
export default defineConfig({
  testDir: 'test', testMatch: 'mls-witness-live.spec.ts', timeout: 240_000,
  workers: 1, retries: 0, use: { trace: 'off', screenshot: 'off', video: 'off' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
})
