import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

const servers = Array.isArray(base.webServer) ? base.webServer : base.webServer ? [base.webServer] : []

// Opt-in node capacity measurement. Ordinary `npm test` and CI never match this file.
export default defineConfig({
  ...base,
  testMatch: 'node-room-capacity.spec.ts',
  use: { ...base.use, actionTimeout: 30_000, navigationTimeout: 30_000 },
  projects: [{ name: 'chromium', use: base.projects!.find(project => project.name === 'chromium')!.use }],
  webServer: servers.filter(server =>
    !server.url?.startsWith(`https://localhost:${Number(process.env.E2E_PORT ?? 4173) + 1}/`)),
})
