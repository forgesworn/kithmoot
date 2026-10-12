import { defineConfig, devices } from '@playwright/test'
// Bound native browser-process lifetime to one spec. Long sequential WebKit
// context creation also stalls on a minimal routed page without app fixtures.
// This isolates the harness; it does not diagnose or fix the browser engine.
const specs = ['ordinary-routing.spec.ts', 'ordinary-media.spec.ts', 'ordinary-private-family.spec.ts', 'ordinary-journal.spec.ts', 'ordinary-capacity.spec.ts', 'ordinary-state.spec.ts', 'ordinary-tab.spec.ts', 'ordinary-device.spec.ts', 'ordinary-device-migration.spec.ts', 'ordinary-participant.spec.ts', 'ordinary-pending.spec.ts', 'ordinary-signet.spec.ts', 'ordinary-identity.spec.ts', 'ordinary-epoch.spec.ts', 'ordinary-room-access.spec.ts', 'ordinary-bookmark.spec.ts', 'ordinary-quiet.spec.ts', 'ordinary-cadence.spec.ts', 'ordinary-contact.spec.ts', 'ordinary-metadata.spec.ts', 'ordinary-channel-check.spec.ts', 'ordinary-granted-contact.spec.ts']
const engines = [
  { name: 'chromium', profile: devices['Desktop Chrome'] },
  { name: 'firefox', profile: devices['Desktop Firefox'] },
  { name: 'webkit', profile: devices['Desktop Safari'] },
]
const stems = specs.map(spec => spec.replace(/\.spec\.ts$/, ''))
if (new Set(stems).size !== specs.length) throw new Error('Duplicate ordinary spec')
const projects = engines.flatMap(engine => specs.map((spec, index) => ({
  name: `${engine.name}-${stems[index]}`, testMatch: spec, use: { ...engine.profile },
})))
if (new Set(projects.map(project => project.name)).size !== projects.length) throw new Error('Duplicate ordinary project')
export default defineConfig({
  testDir: 'test', timeout: 30_000, workers: 1, retries: 0, projects,
})
