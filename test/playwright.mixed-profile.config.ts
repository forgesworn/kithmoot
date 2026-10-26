import { defineConfig } from '@playwright/test'
export default defineConfig({testDir:'.',testMatch:'profile-lookups.spec.ts',grep:/saved public profile opt-out/,workers:1,timeout:30000,use:{baseURL:'http://localhost:28445/j/',channel:'chromium',serviceWorkers:'block'},reporter:'list',outputDir:'../.lab/profile-test-output'})
