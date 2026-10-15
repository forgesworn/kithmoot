import { defineConfig, devices } from '@playwright/test'
export default defineConfig({ testDir: 'test', testMatch: 'ordinary-startup-guard.spec.ts', timeout: 30_000, workers: 1, retries: 0,
  projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }, { name: 'firefox', use: devices['Desktop Firefox'] }, { name: 'webkit', use: devices['Desktop Safari'] }] })
