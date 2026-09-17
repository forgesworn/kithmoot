import { defineConfig, devices } from '@playwright/test'

/**
 * The WebRTC behaviour probe, and nothing else.
 *
 * Deliberately its own config rather than another entry in the acceptance
 * suite's `testMatch`: `test/rtc-probe.spec.ts` needs no app build, no relay
 * and no server, and the acceptance suite is slow enough without a spec that
 * answers a question nobody has to ask twice. It measures what this machine's
 * browsers do with mids, receiver track ids, `a=msid` and `muted`, prints a
 * markdown table per engine, and asserts nothing.
 *
 *   npx playwright test --config playwright.probe.config.ts
 *   npx playwright test --config playwright.probe.config.ts --project=firefox
 */
export default defineConfig({
  testDir: './test',
  testMatch: ['rtc-probe.spec.ts'],
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
        },
      },
    },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
})
