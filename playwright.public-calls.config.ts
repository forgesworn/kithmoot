import { defineConfig, devices } from '@playwright/test'

// Deliberate live operator check, excluded from offline CI. Credentials stay
// in private files read by the worker, never build configuration or traces.
if (!process.env.E2E_PUBLIC_CALL_PROFILES) throw new Error('Supply a private E2E_PUBLIC_CALL_PROFILES directory')
const port = Number(process.env.E2E_PORT ?? 5608)
const relay = Number(process.env.E2E_RELAY_PORT ?? port + 100)
process.env.E2E_RELAY_PORT = String(relay)
export default defineConfig({
  testDir: './test', testMatch: ['public-calls.spec.ts'], workers: 1, retries: 0,
  timeout: 240_000, reporter: 'list', outputDir: 'test-results/public-calls',
  // Loopback HTTP is a secure context. No HTTPS/certificate exception is
  // required anywhere, including the independently trusted TURN/TLS path.
  use: { baseURL: `http://127.0.0.1:${port}/j/`, ignoreHTTPSErrors: false,
    trace: 'off', screenshot: 'off', video: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { args: [
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--allow-loopback-in-peer-connection',
    '--disable-audio-output', '--autoplay-policy=no-user-gesture-required',
  ] } } }],
  webServer: [
    { command: `VITE_TURN_CREDENTIAL_ENDPOINT= VITE_MEETING_CODES_BASE= npm run build && python3 test/public-call-app.py --port ${port}`,
      url: `http://127.0.0.1:${port}/j/`, timeout: 180_000 },
    { command: `RELAY_PORT=${relay} node test/ws-relay.mjs`, url: `http://127.0.0.1:${relay}/`, timeout: 30_000 },
  ],
})
