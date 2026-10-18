import {defineConfig,devices} from '@playwright/test'
// One diagnostic, with exactly the original test and poll budgets. No retries.
export default defineConfig({
  testDir:'test',testMatch:'ordinary-prepared-startup-diagnostic.spec.ts',
  timeout:30_000,expect:{timeout:5_000},workers:1,retries:0,repeatEach:1,maxFailures:1,
  reporter:'line',outputDir:'test-results/prepared-startup-exact-diagnostic',
  projects:[{name:'firefox-ordinary-prepared-startup-exact-diagnostic',use:{...devices['Desktop Firefox']},
    grep:/fresh prepared startup signs once only after started ACK, visitor=false, keep=false, priorLease=true$/}],
})
