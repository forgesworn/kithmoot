import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test',
  testMatch: ['native-lock-release-order.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  repeatEach: 1,
  maxFailures: 1,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  reporter: 'list',
  projects: ['chromium', 'firefox', 'webkit'].map(browserName => ({ name: browserName,
    use: { browserName: browserName as 'chromium' | 'firefox' | 'webkit', headless: true } })),
})
