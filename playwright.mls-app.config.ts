import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'test', testMatch: 'mls-persona-app.spec.ts', timeout: 60_000, workers: 1,
  use: { ...devices['Desktop Chrome'], ignoreHTTPSErrors: true, serviceWorkers: 'block' },
  projects: [
    { name: 'development-preview', use: { baseURL: 'https://localhost:4915/j/' } },
    { name: 'production', use: { baseURL: 'https://localhost:4916/j/' } },
  ],
  webServer: [
    { command: 'RELAY_PORT=7891 node test/ws-relay.mjs', url: 'http://127.0.0.1:7891', reuseExistingServer: false },
    { command: 'VITE_BROWSER_MLS_PREVIEW=true E2E_RELAY_PORT=7891 npx vite --config app/vite.config.ts --port 4915 --strictPort', url: 'https://localhost:4915/j/', ignoreHTTPSErrors: true, reuseExistingServer: false, timeout: 120_000 },
    { command: 'VITE_BROWSER_MLS_PREVIEW=true npm run build && E2E_RELAY_PORT=7891 npx vite preview --config app/vite.config.ts --port 4916 --strictPort', url: 'https://localhost:4916/j/', ignoreHTTPSErrors: true, reuseExistingServer: false, timeout: 120_000 },
  ],
})
