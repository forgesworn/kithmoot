import { defineConfig, devices } from '@playwright/test'
export default defineConfig({testDir:'test',testMatch:'ordinary-prepared-extension.spec.ts',workers:1,retries:0,timeout:30000,
  projects:[{name:'chromium-prepared-extension',use:devices['Desktop Chrome']},{name:'firefox-prepared-extension',use:devices['Desktop Firefox']},{name:'webkit-prepared-extension',use:devices['Desktop Safari']}]})
