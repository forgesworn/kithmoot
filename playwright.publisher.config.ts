import { defineConfig, devices } from '@playwright/test'

// A bounded local evidence gate. No issuer, code service or publisher host.
// Independent Internet reachability and deployed-host logging need separate proof.
const port = Number(process.env.E2E_PORT ?? 5593)
const relayPort = port + 100
export default defineConfig({
  testDir: './test', testMatch: ['browser-protected-share.spec.ts', 'publisher-independence.spec.ts'],
  workers: 1, retries: 0, timeout: 120_000, reporter: 'list',
  use: { baseURL: `https://localhost:${port}/j/`, ignoreHTTPSErrors: true, trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { args: [
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-audio-output',
    '--autoplay-policy=no-user-gesture-required',
  ] } } }],
  webServer: [
    { command: `VITE_TURN_CREDENTIAL_ENDPOINT= VITE_MEETING_CODES_BASE= npm run build && E2E_RELAY_PORT=${relayPort} node_modules/.bin/vite preview --config app/vite.config.ts --port ${port} --strictPort`,
      url: `https://localhost:${port}/j/`, ignoreHTTPSErrors: true, timeout: 120_000 },
    { command: `RELAY_PORT=${relayPort} node test/ws-relay.mjs`, url: `http://127.0.0.1:${relayPort}/`, timeout: 30_000 },
  ],
})
