import { defineConfig } from '@playwright/test'
import publisher from './playwright.publisher.config.js'

export default defineConfig({
  ...publisher,
  testMatch: ['spry-failover.spec.ts'],
  timeout: 150_000,
  outputDir: 'test-results/spry-failover',
  projects: publisher.projects!.map(project => ({ ...project, use: {
    ...project.use, launchOptions: { args: [
      ...(project.use?.launchOptions?.args ?? []),
      // Trust only in the disposable browser. Production builds keep normal TLS verification.
      '--ignore-certificate-errors',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ] },
  } })),
  webServer: [
    ...(Array.isArray(publisher.webServer) ? publisher.webServer : []),
    { command: 'node test/spry-failover-fixture.mjs',
      url: 'http://127.0.0.1:' + (process.env.E2E_SPRY_FAILOVER_PORT ?? 7797),
      timeout: 25_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 } },
  ],
})
