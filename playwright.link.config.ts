import { defineConfig, devices } from '@playwright/test'
export default defineConfig({ testDir: 'test', testMatch: ['browser-link.spec.ts'], timeout: 60_000,
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
})
