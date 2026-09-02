#!/usr/bin/env node
// The agent CLI. Everything is in the built library: `npm run build:lib`
// first, exactly as for the forwarder.
import { main } from '../dist/src/node/cli.js'

main().catch((err) => {
  process.stderr.write(`kithmoot-agent: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
