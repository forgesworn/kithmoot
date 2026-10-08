import {defineConfig,devices} from '@playwright/test'
export default defineConfig({testDir:'test',testMatch:['mls-coordinator.spec.ts','mls-persona-store.spec.ts'],timeout:60_000,workers:1,
  projects:[{name:'chromium',use:{...devices['Desktop Chrome']}},{name:'firefox',use:{...devices['Desktop Firefox']}},{name:'webkit',use:{...devices['Desktop Safari']}}]})
