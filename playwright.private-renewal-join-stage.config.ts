import { defineConfig, devices } from '@playwright/test'

if (process.env.VENNEL_PRIVATE_JOIN_STAGE_OBSERVER !== '1') throw Error('Join-stage observer must be enabled')

export default defineConfig({
  testDir: 'test', testMatch: 'ordinary-private-existing-root.spec.ts',
  grep: /(?:^| )trusted renewal Prepare reads fresh membership without durable or provider effects, keep=false, pointer$/,
  timeout: 30_000, expect: { timeout: 5_000 }, fullyParallel: false,
  workers: 1, retries: 0, repeatEach: 1, maxFailures: 1, forbidOnly: true,
  outputDir: 'test-results/private-renewal-join-stage',
  reporter: [['list'], ['json', { outputFile: 'test-results/private-renewal-join-stage-report.json' }]],
  use: { trace: 'on' },
  projects: [{ name: 'firefox-sdk020', use: devices['Desktop Firefox'] }],
})
