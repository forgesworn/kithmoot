import { isAbsolute } from 'node:path'
import { defineConfig } from '@playwright/test'
import publisher from './playwright.publisher.config.js'

// A member runs a standard-profile Spry node and pairs their KithMoot with it;
// a guest with no Spry of their own joins their room and calls through it.
// Everything is local: the real spry-node and spry-turn behind a throwaway
// certificate on loopback. Build them with scripts/build-spry-node-fixture.sh
// and name the absolute path of spry-node in E2E_SPRY_NODE_BINARY.
//
// spryCredentials accepts only turn:<host>:3478 for an https: offer, so the
// relay must own 127.0.0.1:3478 (TCP and UDP) for the length of the run. The
// app, signalling relay and facade ports can move; 3478 cannot.
const port = Number(process.env.E2E_PORT ?? 5595)
const relayPort = Number(process.env.E2E_RELAY_PORT ?? port + 100)
const facadePort = Number(process.env.E2E_SPRY_FACADE_PORT ?? 7795)
const host = process.env.E2E_SPRY_HOST ?? 'spry-node.example'
if (!isAbsolute(process.env.E2E_SPRY_NODE_BINARY ?? '')) {
  throw new Error('Set E2E_SPRY_NODE_BINARY to the absolute path of a built spry-node (see scripts/build-spry-node-fixture.sh)')
}
process.env.E2E_PORT = String(port)
process.env.E2E_RELAY_PORT = String(relayPort)
process.env.E2E_SPRY_FACADE_PORT = String(facadePort)
process.env.E2E_SPRY_HOST = host

export default defineConfig({
  ...publisher,
  testMatch: ['spry-room-relay.spec.ts'], timeout: 240_000,
  outputDir: 'test-results/spry-room-relay',
  use: { ...publisher.use, baseURL: `https://localhost:${port}/j/` },
  projects: publisher.projects!.map(project => ({ ...project, use: {
    ...project.use, launchOptions: { args: [
      ...(project.use?.launchOptions?.args ?? []),
      // Local fixture certificate only; never part of a production build.
      '--ignore-certificate-errors', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      // The Spry address must be a dotted public-looking name. Resolve that
      // one name to loopback, for the control calls and for WebRTC's TURN lookup.
      `--host-resolver-rules=MAP ${host} 127.0.0.1`,
    ] },
  } })),
  webServer: [
    // No deployment credential endpoint: the paired node is the only relay source.
    { command: `VITE_TURN_CREDENTIAL_ENDPOINT= VITE_MEETING_CODES_BASE= npm run build && E2E_RELAY_PORT=${relayPort} node_modules/.bin/vite preview --config app/vite.config.ts --port ${port} --strictPort`,
      url: `https://localhost:${port}/j/`, ignoreHTTPSErrors: true, timeout: 180_000 },
    { command: `RELAY_PORT=${relayPort} node test/ws-relay.mjs`, url: `http://127.0.0.1:${relayPort}/`, timeout: 30_000 },
    { command: `node test/spry-room-relay-fixture.mjs`,
      url: `https://localhost:${facadePort}/`, ignoreHTTPSErrors: true, timeout: 60_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 } },
  ],
})
