import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './test', testMatch: '*.spec.ts', workers: 1, timeout: 120_000,
  expect: { timeout: 20_000 }, reporter: 'list',
  use: { headless: true, launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] } },
  webServer: { command: 'RELAY_PORT=17777 node ../test/ws-relay.mjs', url: 'http://127.0.0.1:17777', reuseExistingServer: false },
})
