import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'server/**/*.test.mjs'],
    exclude: ['test/live.test.ts', '**/node_modules/**'],
    environment: 'node',
  },
})
