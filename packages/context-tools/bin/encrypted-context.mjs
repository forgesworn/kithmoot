#!/usr/bin/env node
import { main } from '../dist/context-cli.js'
main().catch(err => {
  process.stderr.write(`encrypted-context: ${err instanceof Error ? err.message : 'operation failed'}\n`)
  process.exitCode = 1
})
