import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

if (!process.env.M2_BASELINE_DIR || !process.env.M2_BASELINE_URL) throw new Error('Set M2_BASELINE_DIR to a built previous release and M2_BASELINE_URL to its preview URL')
export default defineConfig({
  ...base,
  testMatch: 'm2-interop.spec.ts',
  projects: base.projects?.filter(p => p.name === 'chromium'),
})
