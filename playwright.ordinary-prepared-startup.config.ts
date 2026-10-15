import {defineConfig,devices} from '@playwright/test'
export default defineConfig({testDir:'test',testMatch:'ordinary-prepared-startup.spec.ts',workers:1,retries:0,timeout:30000,projects:[{name:'chromium-prepared-startup',use:devices['Desktop Chrome']},{name:'firefox-prepared-startup',use:devices['Desktop Firefox']},{name:'webkit-prepared-startup',use:devices['Desktop Safari']}]})
