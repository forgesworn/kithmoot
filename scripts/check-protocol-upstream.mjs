#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const pins = JSON.parse(await readFile(new URL('../docs/protocol/upstream.json', import.meta.url), 'utf8'))
const pinned = process.argv.includes('--pinned')
let failed = false
for (const pin of pins) {
  try {
    const response = await fetch(pinned ? pin.sourceUrl : pin.trackingUrl, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const body = new TextDecoder().decode(bytes)
    const selected = !pinned && pin.kinds ? pin.kinds.map(kind => {
      const match = body.match(new RegExp(`^  ${kind}:\\n[\\s\\S]*?(?=^  [0-9]+:|$(?![\\s\\S]))`, 'm'))
      if (!match) throw new Error(`Missing registry entry ${kind}`)
      return match[0].trimEnd()
    }).join('\n') : bytes
    const actual = createHash('sha256').update(selected).digest('hex')
    const expected = !pinned && pin.trackedSha256 ? pin.trackedSha256 : pin.sha256
    if (actual !== expected) throw new Error(`changed since ${pin.revision}; review compatibility before updating the pin`)
    console.log(`${pin.name}: unchanged`)
  } catch (error) {
    failed = true
    console.error(`${pin.name}: ${error.message}`)
  }
}
if (failed) process.exitCode = 1
