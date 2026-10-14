import { defineConfig, devices } from '@playwright/test'
import base from './playwright.config.js'
// Actual built PWA controls with a local relay/Blossom companion. No remote
// deletion or independent live/hardware acceptance is inferred.
export default defineConfig({...base, testMatch: ['self-destruct.spec.ts', 'context.spec.ts'],
  grep: /Leave and tidy up deletes the files|file cleanup .* pauses tidy-up|two people share encrypted context|the authority makes a room with no end self-destruct now/,
  projects: [
    {name: 'chromium', use: {...devices['Desktop Chrome']}},
    {name: 'firefox', use: {...devices['Desktop Firefox']}},
    {name: 'webkit', use: {...devices['Desktop Safari']}},
  ],
  // The second entry is the unused desktop build. Keep the PWA and companion.
  webServer: Array.isArray(base.webServer) ? base.webServer.filter((_, i) => i !== 1) : base.webServer,
})
