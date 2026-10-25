import { defineConfig, devices } from '@playwright/test'
export default defineConfig({ testDir: 'test', testMatch: 'mls-bark-rendezvous.spec.ts', timeout: 60_000, workers: 1,
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }] })
