import { defineConfig } from '@playwright/test'
import publisher from './playwright.publisher.config.js'

const port = Number(process.env.E2E_PORT ?? 5594)
const relayPort = Number(process.env.E2E_RELAY_PORT ?? 5694)
const issuerPort = Number(process.env.E2E_AUTOMATIC_TURN_PORT ?? 7794)
process.env.E2E_RELAY_PORT = String(relayPort)
export default defineConfig({
  ...publisher,
  testMatch: ['automatic-calls.spec.ts'], timeout: 180_000,
  outputDir: 'test-results/automatic-calls',
  use: { ...publisher.use, baseURL: `https://localhost:${port}/j/` },
  projects: publisher.projects!.map(project => ({ ...project, use: {
    ...project.use, launchOptions: { args: [
      ...(project.use?.launchOptions?.args ?? []),
      // Local fixture certificate only; never part of a production build.
      '--ignore-certificate-errors', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ] },
  } })),
  webServer: [
    { command: `VITE_TURN_CREDENTIAL_ENDPOINT=https://localhost:${issuerPort}/turn VITE_MEETING_CODES_BASE= npm run build && E2E_RELAY_PORT=${relayPort} node_modules/.bin/vite preview --config app/vite.config.ts --port ${port} --strictPort`,
      url: `https://localhost:${port}/j/`, ignoreHTTPSErrors: true, timeout: 120_000 },
    { command: `RELAY_PORT=${relayPort} node test/ws-relay.mjs`, url: `http://127.0.0.1:${relayPort}/`, timeout: 30_000 },
    { command: `E2E_PORT=${port} E2E_AUTOMATIC_TURN_PORT=${issuerPort} python3 test/automatic-call-fixture.py`,
      url: `https://localhost:${issuerPort}/`, ignoreHTTPSErrors: true, timeout: 60_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 } },
  ],
})
