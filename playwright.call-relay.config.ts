import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

/** A real private coturn, entered through Settings. No public infrastructure. */
export default defineConfig({
  ...base,
  testMatch: ['custom-call-relay.spec.ts'],
  outputDir: 'test-results/private-call-relay',
  workers: 1,
  projects: [
    ...base.projects!.filter(project => project.name === 'chromium'),
    { ...base.projects!.find(project => project.name === 'webkit')!, testMatch: ['custom-call-relay.spec.ts'], grep: /configured URI alternatives/ },
  ],
  webServer: [
    ...(Array.isArray(base.webServer) ? base.webServer.filter(server => !server.command.includes('VITE_DESKTOP=true')) : []),
    { command: 'python3 test/call-relay-fixture.py', url: `http://127.0.0.1:${process.env.E2E_TURN_FIXTURE_PORT ?? 7788}/`, reuseExistingServer: false, timeout: 60_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 } },
  ],
})
