import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'app/src/**/*.test.ts', 'test/**/*.test.ts', 'server/**/*.test.mjs', 'vectors/**/*.test.ts'],
    exclude: ['test/live.test.ts', '**/node_modules/**'],
    environment: 'node',
  },
})
