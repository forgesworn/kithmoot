import { defineConfig } from 'vitest/config'

// The default vitest.config.ts excludes test/live.test.ts so `npm test`
// never touches the network. Vitest's config-level `exclude` wins over a
// CLI file filter, so opting back in needs its own config rather than a
// `vitest run test/live.test.ts` invocation against the default one.
export default defineConfig({
  test: {
    include: ['test/live.test.ts'],
    environment: 'node',
  },
})
