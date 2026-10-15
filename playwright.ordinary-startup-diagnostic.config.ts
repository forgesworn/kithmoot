import { defineConfig, devices } from '@playwright/test'
// Diagnostic only. These repeated measurements do not satisfy the ordinary
// 30-second acceptance gate or change any existing configuration.
export default defineConfig({ testDir: 'test', timeout: 90_000, workers: 1, retries: 0, repeatEach: 2,
  grep: /priorLease=true/, reporter: 'line',
  projects: [
    { name: 'firefox-member-startup', testMatch: 'ordinary-member-startup.spec.ts', use: devices['Desktop Firefox'] },
    { name: 'firefox-prepared-extension', testMatch: 'ordinary-prepared-extension.spec.ts', use: devices['Desktop Firefox'] },
    { name: 'firefox-complete-extension', testMatch: 'ordinary-complete-extension.spec.ts', use: devices['Desktop Firefox'] },
  ] })
