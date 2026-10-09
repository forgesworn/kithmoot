import { defineConfig, devices } from '@playwright/test'
// Opt-in full app, disposable Bothy and a loopback WebPKI Link relay. Never a
// production witness. No recordings: pairing capabilities remain in memory.
export default defineConfig({
  testDir: 'test', testMatch: 'mls-account-live.spec.ts', timeout: 180_000, workers: 1, retries: 0,
  use: { ...devices['Desktop Chrome'], baseURL: 'https://localhost:4917/j/', ignoreHTTPSErrors: true,
    serviceWorkers: 'block', trace: 'off', screenshot: 'off', video: 'off' },
  webServer: [
    { command: 'RELAY_PORT=7892 node test/ws-relay.mjs', url: 'http://127.0.0.1:7892', reuseExistingServer: false },
    { command: 'VITE_BROWSER_MLS_PREVIEW=true E2E_RELAY_PORT=7892 npx vite --config app/vite.config.ts --port 4917 --strictPort', url: 'https://localhost:4917/j/', ignoreHTTPSErrors: true, reuseExistingServer: false },
  ],
})
