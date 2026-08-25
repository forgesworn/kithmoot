import { defineConfig, devices } from '@playwright/test'

// Config for the single acceptance E2E spec (test/e2e.spec.ts). Deliberately
// separate from vitest: it drives a real built app in a real browser against
// live public relays, which vitest.config.ts's node environment cannot do,
// and it must stay out of `npm test` for the same reason test/live.test.ts
// does - real network, real relay weather, not something every `npm test`
// run should pay for or be flaky because of.
export default defineConfig({
  testDir: './test',
  testMatch: 'e2e.spec.ts',
  // Public relays take a few seconds to round-trip a roster event, and the
  // join-last case waits on three of those in sequence: A's entry, B's, and
  // then A and B answering C's arrival. The stage-1 live test used similar
  // multi-second settle windows; this is deliberately generous, because the
  // answer to a slow relay is patience, not a weaker assertion.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    // Carries the `/j/` sub-path the app is published under (see the `base`
    // in app/vite.config.ts) - `vite preview` serves nothing at the root.
    baseURL: process.env.E2E_BASE_URL ?? 'https://localhost:4173/j/',
    // app/vite.config.ts's basicSsl() plugin runs under `vite preview` too,
    // so the app is only ever reachable here over a self-signed cert.
    // Irrelevant to getUserMedia's secure-context check either way -
    // localhost is a secure context regardless of certificate validity -
    // but the browser still needs telling not to block the navigation on it.
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            // Grants camera/mic with synthetic media and no permission
            // prompt - there is no human present to click "Allow".
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
          ],
        },
      },
    },
  ],
  // Builds the app and serves app/dist on localhost via `vite preview`,
  // which - like `npm run demo` - runs under app/vite.config.ts's basicSsl
  // plugin, so it's HTTPS with a self-signed cert (see ignoreHTTPSErrors
  // above). Skipped entirely when E2E_BASE_URL points somewhere already
  // running (e.g. a developer's own `npm run demo`).
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run build && npx vite preview --config app/vite.config.ts --port 4173 --strictPort',
        url: 'https://localhost:4173/j/',
        ignoreHTTPSErrors: true,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
})
