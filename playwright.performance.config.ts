import { defineConfig } from '@playwright/test'

const port = Number(process.env.E2E_PORT ?? 4273)
const relayPort = Number(process.env.E2E_RELAY_PORT ?? port + 100)
if (!Number.isInteger(port) || !Number.isInteger(relayPort)) throw new Error('Ports must be integers')

export default defineConfig({
  testDir: './test', testMatch: 'performance-baseline.spec.ts', workers: 1,
  retries: 0, reporter: 'list', timeout: 3_600_000,
  use: {
    baseURL: `https://localhost:${port}/j/`, ignoreHTTPSErrors: true,
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-audio-output', '--autoplay-policy=no-user-gesture-required'] },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    { command: `npm run build && E2E_RELAY_PORT=${relayPort} npx vite preview --config app/vite.config.ts --port ${port} --strictPort`, url: `https://localhost:${port}/j/`, ignoreHTTPSErrors: true, timeout: 180_000, reuseExistingServer: false },
    { command: `RELAY_PORT=${relayPort} node test/ws-relay.mjs`, url: `http://127.0.0.1:${relayPort}/`, timeout: 30_000, reuseExistingServer: false },
  ],
})
