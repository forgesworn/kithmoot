import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

const servers = Array.isArray(base.webServer) ? base.webServer : base.webServer ? [base.webServer] : []

export default defineConfig({
  ...base,
  testMatch: 'node-call-endurance.spec.ts',
  use: { ...base.use, actionTimeout: 30_000, navigationTimeout: 30_000 },
  projects: [{ name: 'chromium', use: base.projects!.find(project => project.name === 'chromium')!.use }],
  // This suite exercises the web client. Native desktop and Android use the
  // separate explicit cross-client fixture and must retain their own evidence.
  webServer: servers.filter(server =>
    !server.url?.startsWith(`https://localhost:${Number(process.env.E2E_PORT ?? 4173) + 1}/`)),
})
