import { defineConfig, devices } from '@playwright/test'
// Bound native browser-process lifetime to each spec slice. Long sequential WebKit
// context creation also stalls on a minimal routed page without app fixtures.
// This isolates the harness; it does not diagnose or fix the browser engine.
const specs = ['ordinary-access-composition.spec.ts', 'ordinary-physical.spec.ts', 'ordinary-entry-layout.spec.ts', 'ordinary-ui.spec.ts', 'ordinary-routing.spec.ts', 'ordinary-media.spec.ts', 'ordinary-private-family.spec.ts', 'ordinary-journal.spec.ts', 'ordinary-capacity.spec.ts', 'ordinary-state.spec.ts', 'ordinary-tab.spec.ts', 'ordinary-device.spec.ts', 'ordinary-device-migration.spec.ts', 'ordinary-participant.spec.ts', 'ordinary-pending.spec.ts', 'ordinary-signet.spec.ts', 'ordinary-identity.spec.ts', 'ordinary-epoch.spec.ts', 'ordinary-room-access.spec.ts', 'ordinary-bookmark.spec.ts', 'ordinary-quiet.spec.ts', 'ordinary-cadence.spec.ts', 'ordinary-contact.spec.ts', 'ordinary-metadata.spec.ts', 'ordinary-channel-check.spec.ts', 'ordinary-granted-contact.spec.ts']
const engines = [
  { name: 'chromium', profile: devices['Desktop Chrome'] },
  { name: 'firefox', profile: devices['Desktop Firefox'] },
  { name: 'webkit', profile: devices['Desktop Safari'] },
]
specs.push('ordinary-snapshot.spec.ts')
specs.push('ordinary-routing-custody.spec.ts')
specs.push('ordinary-pair.spec.ts')
specs.push('ordinary-persistent-admission.spec.ts')
specs.push('ordinary-member-device-custody.spec.ts')
specs.push('ordinary-bootstrap.spec.ts')
specs.push('ordinary-invitation-query.spec.ts')
specs.push('ordinary-board-context.spec.ts')
specs.push('ordinary-board-consumer.spec.ts')
specs.push('ordinary-creator.spec.ts')
specs.push('ordinary-creator-delivery.spec.ts')
specs.push('ordinary-foreground-signer.spec.ts')
specs.push('ordinary-initial-login.spec.ts')
specs.push('ordinary-extension-restore.spec.ts')
specs.push('ordinary-room-board-storage.spec.ts')
specs.push('ordinary-room-board-catalogue.spec.ts')
const stems = specs.map(spec => spec.replace(/\.spec\.ts$/, ''))
if (new Set(stems).size !== specs.length) throw new Error('Duplicate ordinary spec')
const consumerCases=/narrowed trusted consumer|narrowed consumer|consumer fields/
const projects = engines.flatMap(engine => [
  ...specs.map((spec, index) => ({
    name: `${engine.name}-${stems[index]}`, testMatch: spec, use: { ...engine.profile },
    ...(spec==='ordinary-foreground-signer.spec.ts'?{grepInvert:consumerCases}:{}),
  })),
  // Keep the existing 77-case signer baseline and its new native-consumer
  // slice in distinct browser lifetimes. No retry or skipped case is added.
  {name:`${engine.name}-ordinary-foreground-consumer`,testMatch:'ordinary-foreground-signer.spec.ts',grep:consumerCases,use:{...engine.profile}},
])
if (new Set(projects.map(project => project.name)).size !== projects.length) throw new Error('Duplicate ordinary project')
export default defineConfig({
  testDir: 'test', timeout: 30_000, workers: 1, retries: 0, projects,
})
