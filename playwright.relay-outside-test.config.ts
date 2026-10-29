import { randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { defineConfig } from '@playwright/test'
import publisher from './playwright.publisher.config.js'

// The relay outside test (docs/protocol.md, "Relay outside test"): a member
// who runs a built-in call relay (the real `spry-node supervised`) asks
// another member to test it, and hears the result. Same local fixture as
// playwright.spry-standard-offer.config.ts, on ports of its own so the two
// can run side by side, and without that config's
// disable_non_proxied_udp: the tester's second peer must send plain UDP to
// the relay's listener and relayed address. Everything stays on loopback,
// so the result is always "from the host's own network"; real outside
// reachability needs separate networks.
//
// Build spry-node with scripts/build-spry-node-fixture.sh and name it in
// E2E_SPRY_NODE_BINARY.
const port = Number(process.env.E2E_PORT ?? 5598)
const relayPort = Number(process.env.E2E_RELAY_PORT ?? port + 100)
const controlPort = Number(process.env.E2E_SPRY_CONTROL_PORT ?? 7798)
const fixturePort = Number(process.env.E2E_SPRY_FIXTURE_PORT ?? 7799)
if (!isAbsolute(process.env.E2E_SPRY_NODE_BINARY ?? '')) {
  throw new Error('Set E2E_SPRY_NODE_BINARY to the absolute path of a spry-node with supervised mode (see scripts/build-spry-node-fixture.sh)')
}
process.env.E2E_PORT = String(port)
process.env.E2E_RELAY_PORT = String(relayPort)
process.env.E2E_SPRY_CONTROL_PORT = String(controlPort)
process.env.E2E_SPRY_FIXTURE_PORT = String(fixturePort)
process.env.E2E_SPRY_PAIRING_SECRET ??= randomBytes(32).toString('hex')

export default defineConfig({
  ...publisher,
  testMatch: ['relay-outside-test.spec.ts'], timeout: 240_000,
  outputDir: 'test-results/relay-outside-test',
  use: { ...publisher.use, baseURL: `https://localhost:${port}/j/` },
  projects: publisher.projects!.map(project => ({ ...project, use: {
    ...project.use, launchOptions: { args: [
      ...(project.use?.launchOptions?.args ?? []),
      // Local fixture certificate only; never part of a production build.
      '--ignore-certificate-errors',
      // Loopback host candidates in the clear, so the relay may let the tester's second peer in.
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--host-resolver-rules=MAP control.example 127.0.0.1',
    ] },
  } })),
  webServer: [
    { command: `VITE_TURN_CREDENTIAL_ENDPOINT= VITE_MEETING_CODES_BASE= VITE_E2E_SPRY_LOOPBACK_TURN=true VITE_E2E_RELAY_OUTSIDE_TEST=true npm run build && E2E_RELAY_PORT=${relayPort} node_modules/.bin/vite preview --config app/vite.config.ts --port ${port} --strictPort`,
      url: `https://localhost:${port}/j/`, ignoreHTTPSErrors: true, timeout: 180_000 },
    { command: `RELAY_PORT=${relayPort} node test/ws-relay.mjs`, url: `http://127.0.0.1:${relayPort}/`, timeout: 30_000 },
    { command: `node test/spry-supervised-fixture.mjs`, url: `http://127.0.0.1:${fixturePort}/`, timeout: 60_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 } },
  ],
})
