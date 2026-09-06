#!/usr/bin/env node
import { main } from '../dist/src/node/context-cli.js'
main().catch(err => {
  process.stderr.write(`kithmoot-context: ${err instanceof Error ? err.message : 'operation failed'}\n`)
  process.exitCode = 1
})
