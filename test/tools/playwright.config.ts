import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import base from '../../playwright.config.js'

/** The acceptance suite's servers and browser, pointed at the one tool spec
 *  that regenerates the website's hero image. See hero-screenshot.spec.ts.
 *  Server commands run from the repository root, not from this directory. */
const root = fileURLToPath(new URL('../../', import.meta.url))
const servers = Array.isArray(base.webServer) ? base.webServer : base.webServer ? [base.webServer] : undefined

export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: ['hero-screenshot.spec.ts'],
  projects: base.projects?.filter((p) => p.name === 'chromium'),
  webServer: servers?.map((server) => ({ ...server, cwd: root })),
})
