import { defineConfig, devices } from '@playwright/test'
export default defineConfig({ testDir: 'test', testMatch: 'ordinary-member-startup.spec.ts', workers: 1, retries: 0, timeout: 30000,
  projects: [
    { name: 'chromium-member-startup', use: devices['Desktop Chrome'] },
    { name: 'firefox-member-startup', use: devices['Desktop Firefox'] },
    { name: 'webkit-member-startup', use: devices['Desktop Safari'] },
  ] })
