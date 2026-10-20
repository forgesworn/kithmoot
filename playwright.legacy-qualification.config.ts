import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

// Diagnostic producer only: serve the previously built production bytes.
// Keep the candidate's actual projects, assertions, per-case timeouts and flags.
// No compressed quiet slots or app diagnostic hooks are enabled by this config.
const engine = process.env.LEGACY_QUAL_ENGINE ?? 'inventory'
if (!['inventory', 'firefox', 'webkit', 'chromium', 'chromium-desktop'].includes(engine)) throw new Error('Unexpected engine')
const projects = base.projects ?? []
if (projects.map(p => p.name).join(',') !== 'firefox,webkit,chromium,chromium-desktop') {
  throw new Error('Re-review the legacy qualification after project scope changes')
}
export default defineConfig({
  ...base,
  testMatch: ['legacy-messages.spec.ts'],
  grep: undefined,
  grepInvert: undefined,
  projects: projects.map(project => ({ ...project, testMatch: ['legacy-messages.spec.ts'], testIgnore: [] })),
  workers: 1,
  retries: 0,
  repeatEach: 1,
  // A bounded engine run may leave cases unexecuted; that is never acceptance.
  globalTimeout: 15 * 60_000,
  use: { ...base.use, trace: 'on' },
  outputDir: `release/legacy-qualification/browser/${process.env.LEGACY_QUAL_ENGINE ?? 'inventory'}/artifacts`,
  reporter: [
    ['list'],
    ['json', { outputFile: `release/legacy-qualification/browser/${process.env.LEGACY_QUAL_ENGINE ?? 'inventory'}/report.json` }],
  ],
  webServer: [
    ...(engine === 'chromium-desktop' ? [] : [{
      command: 'node_modules/.bin/vite preview --config app/vite.config.ts --port 4173 --strictPort',
      url: 'https://localhost:4173/j/', ignoreHTTPSErrors: true,
      reuseExistingServer: false, timeout: 120_000, stdout: 'pipe', stderr: 'pipe',
    }]),
    ...(engine === 'chromium-desktop' ? [{
      command: 'VITE_DESKTOP=true node_modules/.bin/vite preview --config app/vite.config.ts --port 4174 --strictPort',
      url: 'https://localhost:4174/j/', ignoreHTTPSErrors: true,
      reuseExistingServer: false, timeout: 180_000, stdout: 'pipe', stderr: 'pipe',
    }] : []),
    {
      command: 'RELAY_PORT=7777 node test/ws-relay.mjs',
      url: 'http://127.0.0.1:7777/', reuseExistingServer: false, timeout: 30_000,
      stdout: 'pipe', stderr: 'pipe',
    },
  ],
})
