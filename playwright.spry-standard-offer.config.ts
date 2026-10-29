import { randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { defineConfig } from '@playwright/test'
import publisher from './playwright.publisher.config.js'

// A member's built-in call relay (the real `spry-node supervised`) and a
// guest who redeems its foreign standard `spry:` offer, applying the Hide my
// IP address rule. Everything is local: the node's control channel runs over
// the offline test relay behind a throwaway `wss://control.example` name (see
// test/spry-supervised-fixture.mjs), and the node binds and advertises
// 127.0.0.1, which only this build (VITE_E2E_SPRY_LOOPBACK_TURN) admits.
//
// Build spry-node from a spry-turn commit with supervised mode (S2, #23) with
// scripts/build-spry-node-fixture.sh and name it in E2E_SPRY_NODE_BINARY.
const port = Number(process.env.E2E_PORT ?? 5596)
const relayPort = Number(process.env.E2E_RELAY_PORT ?? port + 100)
const controlPort = Number(process.env.E2E_SPRY_CONTROL_PORT ?? 7796)
const fixturePort = Number(process.env.E2E_SPRY_FIXTURE_PORT ?? 7797)
if (!isAbsolute(process.env.E2E_SPRY_NODE_BINARY ?? '')) {
  throw new Error('Set E2E_SPRY_NODE_BINARY to the absolute path of a spry-node with supervised mode (see scripts/build-spry-node-fixture.sh)')
}
process.env.E2E_PORT = String(port)
process.env.E2E_RELAY_PORT = String(relayPort)
process.env.E2E_SPRY_CONTROL_PORT = String(controlPort)
process.env.E2E_SPRY_FIXTURE_PORT = String(fixturePort)
// The host app's own pairing with its node: generated per run, shared by the
// fixture (as the node's trusted pairing key) and the spec (the host's browser).
process.env.E2E_SPRY_PAIRING_SECRET ??= randomBytes(32).toString('hex')

export default defineConfig({
  ...publisher,
  testMatch: ['spry-standard-offer.spec.ts'], timeout: 240_000,
  outputDir: 'test-results/spry-standard-offer',
  use: { ...publisher.use, baseURL: `https://localhost:${port}/j/` },
  projects: publisher.projects!.map(project => ({ ...project, use: {
    ...project.use, launchOptions: { args: [
      ...(project.use?.launchOptions?.args ?? []),
      // Local fixture certificate only; never part of a production build.
      '--ignore-certificate-errors', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      // The control relay must be a dotted name; resolve that one name to loopback.
      '--host-resolver-rules=MAP control.example 127.0.0.1',
    ] },
  } })),
  webServer: [
    // No deployment credential endpoint: the member's node is the only relay source.
    { command: `VITE_TURN_CREDENTIAL_ENDPOINT= VITE_MEETING_CODES_BASE= VITE_E2E_SPRY_LOOPBACK_TURN=true npm run build && E2E_RELAY_PORT=${relayPort} node_modules/.bin/vite preview --config app/vite.config.ts --port ${port} --strictPort`,
      url: `https://localhost:${port}/j/`, ignoreHTTPSErrors: true, timeout: 180_000 },
    { command: `RELAY_PORT=${relayPort} node test/ws-relay.mjs`, url: `http://127.0.0.1:${relayPort}/`, timeout: 30_000 },
    { command: `node test/spry-supervised-fixture.mjs`, url: `http://127.0.0.1:${fixturePort}/`, timeout: 60_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 } },
  ],
})
