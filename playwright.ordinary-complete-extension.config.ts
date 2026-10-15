import { defineConfig, devices } from '@playwright/test'
export default defineConfig({ testDir: 'test', testMatch: 'ordinary-complete-extension.spec.ts', workers: 1, retries: 0, timeout: 30000,
  projects: [{ name: 'chromium-complete-extension', use: devices['Desktop Chrome'] },
    { name: 'firefox-complete-extension', use: devices['Desktop Firefox'] },
    { name: 'webkit-complete-extension', use: devices['Desktop Safari'] }] })
