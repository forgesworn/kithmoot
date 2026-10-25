import { defineConfig, devices } from '@playwright/test'
export default defineConfig({ testDir: 'test', testMatch: ['admin-invitation-journey.spec.ts'], timeout: 120_000, workers: 1,
  outputDir: 'test-results/admin-invitation', projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }] })
