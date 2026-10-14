import { defineConfig } from '@playwright/test'
import app from './playwright.config.js'
/** Actual built composer/outbox against the offline relay in all three engines. */
export default defineConfig({
  ...app,
  testMatch: ['chat-reliability.spec.ts'],
  projects: app.projects?.filter(project => project.name !== 'chromium-desktop').map(project => ({ ...project, testMatch: ['chat-reliability.spec.ts'] })),
  webServer: Array.isArray(app.webServer) ? app.webServer.filter(server => !server.command.includes('VITE_DESKTOP=true')) : app.webServer,
})
