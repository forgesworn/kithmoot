import { defineConfig } from '@playwright/test'

/** Synthetic own-stack browser qualification; starts no public relay or app server. */
export default defineConfig({
  testDir: './test', testMatch: 'invitation-profile-journey.spec.ts', timeout: 120_000,
  workers: 1, reporter: 'line', outputDir: './test-results/mls-invitation',
  use: { browserName: 'chromium', headless: true },
})
