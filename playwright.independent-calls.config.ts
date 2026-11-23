import { defineConfig } from '@playwright/test'
import publisher from './playwright.publisher.config.js'

/** Separate test: needs Docker and real coturn sockets, no public provider. */
export default defineConfig({
  ...publisher,
  testMatch: ['independent-calls.spec.ts'],
  timeout: 180_000,
  outputDir: 'test-results/independent-calls',
  // Keep a failed run's trace: these failures are timing faults in live
  // calls, and the log alone does not say which connection stalled.
  use: { ...publisher.use, trace: 'retain-on-failure' },
  projects: publisher.projects!.map(project => ({ ...project, use: {
    ...project.use, launchOptions: { args: [
      ...(project.use?.launchOptions?.args ?? []),
      // Temporary loopback-only test certificate. Never ship this exception.
      '--ignore-certificate-errors',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ] },
  } })),
  webServer: [
    ...(Array.isArray(publisher.webServer) ? publisher.webServer : []),
    { command: 'python3 test/independent-call-fixture.py',
      url: `http://127.0.0.1:${process.env.E2E_INDEPENDENT_TURN_PORT ?? 7793}/`,
      timeout: 60_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 } },
  ],
})
