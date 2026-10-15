import { defineConfig, devices } from '@playwright/test'
export default defineConfig({ testDir:'test',testMatch:['ordinary-clients.spec.ts'],timeout:30_000,workers:1,
  projects:[{name:'chromium',use:{...devices['Desktop Chrome']}},{name:'firefox',use:{...devices['Desktop Firefox']}},{name:'webkit',use:{...devices['Desktop Safari']}}] })
