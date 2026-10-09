import {defineConfig,devices} from '@playwright/test'
export default defineConfig({testDir:'test',testMatch:['mls-session-host.spec.ts','mls-coordinated-vault.spec.ts','mls-coordinator.spec.ts','mls-persona-store.spec.ts','mls-persona-coordinator.spec.ts','mls-persona-enrolment.spec.ts','mls-persona-panel.spec.ts'],timeout:60_000,workers:1,
  projects:[{name:'chromium',use:{...devices['Desktop Chrome']}},{name:'firefox',use:{...devices['Desktop Firefox']}},{name:'webkit',use:{...devices['Desktop Safari']}}]})
