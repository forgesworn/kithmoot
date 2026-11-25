import { defineConfig, devices } from '@playwright/test'

/**
 * Config for test/live-site-board.spec.ts alone: a deployed site, checked by
 * hand after a deploy.
 *
 * The acceptance suite builds the app and runs it against a local relay, so
 * it never sees what a deploy changes: the served files, the site's headers
 * and the public relays a room made there uses. This visits the site itself.
 *
 * Set SITE_E2E_BASE_URL to the join page of the deployment, for example
 * https://your-host/j/. There is no default, so it cannot check the wrong
 * site by forgetting to set one. It starts no server, makes one throwaway room
 * on the app's own public relays and leaves it, and is out of `npm test` and
 * `npm run test:e2e` on purpose. Run it with `npm run test:live-site`.
 */
const baseURL = process.env.SITE_E2E_BASE_URL
if (!baseURL || !/^https:\/\/[^/]+\/j\/$/.test(baseURL)) {
  throw new Error('SITE_E2E_BASE_URL must be the join page of a deployment, such as https://your-host/j/.')
}
// The test helpers pin rooms to the offline test relay unless told otherwise;
// a deployed site has none, so its rooms use the app's own relays.
if (process.env.E2E_RELAYS && process.env.E2E_RELAYS !== 'live') {
  throw new Error('test:live-site uses the app\'s own relays; unset E2E_RELAYS.')
}
process.env.E2E_RELAYS = 'live'

export default defineConfig({
  testDir: './test',
  testMatch: ['live-site-board.spec.ts'],
  timeout: 420_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  outputDir: 'test-results/live-site',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
