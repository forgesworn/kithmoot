import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: 'test', testMatch: ['ordinary-state.spec.ts', 'ordinary-tab.spec.ts', 'ordinary-device.spec.ts', 'ordinary-device-migration.spec.ts', 'ordinary-participant.spec.ts', 'ordinary-pending.spec.ts', 'ordinary-signet.spec.ts', 'ordinary-identity.spec.ts', 'ordinary-epoch.spec.ts', 'ordinary-room-access.spec.ts', 'ordinary-bookmark.spec.ts', 'ordinary-quiet.spec.ts', 'ordinary-cadence.spec.ts', 'ordinary-contact.spec.ts', 'ordinary-metadata.spec.ts', 'ordinary-channel-check.spec.ts'], timeout: 30_000,
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
})
