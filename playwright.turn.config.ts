import { defineConfig, devices } from '@playwright/test'

/**
 * Config for test/turn-relay.spec.ts alone - the relay-forced TURN check.
 *
 * Separate from playwright.config.ts for the same reason vitest.live.config.ts
 * is separate from vitest.config.ts: this one needs live infrastructure that
 * a local build cannot stand in for. The spec forces iceTransportPolicy to
 * 'relay', so it can only connect through a real TURN server reached with a
 * real minted credential, and it fetches that credential from /turn - a path
 * `vite preview` does not serve and could not usefully fake. Pointing it at a
 * local preview would not fail informatively, it would fail always.
 *
 * So there is no webServer here and the baseURL defaults to the live
 * deployment. Override TURN_E2E_BASE_URL to test a different one.
 *
 * Out of `npm test` (unit, offline) and out of `npm run test:e2e` (which
 * builds and previews locally) on purpose. Run it with `npm run test:turn`,
 * after a deploy, or whenever something about TURN changes.
 */
export default defineConfig({
  testDir: './test',
  testMatch: ['turn-relay.spec.ts'],
  // A TURN allocation, a relay-only ICE gather and a real relay round trip
  // for the roster, one after another. Generous on purpose: the answer to a
  // slow network is patience, not a weaker assertion.
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.TURN_E2E_BASE_URL ?? 'https://kithmoot.forgesworn.dev/j/',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            // Synthetic camera and microphone, granted with no prompt -
            // there is no human present to click "Allow". The synthetic
            // stream is real encoded media, which is what makes the
            // "bytes actually arrived" assertion meaningful.
            '--use-fake-device-for-media-stream',
            // A fake audio sink with a real-time clock. Without it every
            // AudioContext is clocked by the machine's output device, and a
            // device that is asleep or stalled - seen on a Mac mini - leaves
            // the microphone pipeline producing no samples and WebRTC sending
            // no audio, which reads exactly like an application bug.
            '--disable-audio-output',
            '--use-fake-ui-for-media-stream',
          ],
        },
      },
    },
  ],
})
