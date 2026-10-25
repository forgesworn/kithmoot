import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const cataloguePath = resolve(root, 'src/emoji-catalog.ts')
const outputPath = resolve(root, 'src/reaction-emoji-data.ts')
const source = readFileSync(cataloguePath, 'utf8')
const match = source.match(/export const REACTION_VALIDATION_GLYPHS[^=]+= (\[[\s\S]*\])\nconst valid/)
if (!match) throw new Error('Reaction validation layout changed; update the glyph generator')
const glyphs = JSON.parse(match[1])
if (new Set(glyphs).size !== glyphs.length || glyphs.some(emoji => /\s/.test(emoji))) throw new Error('Reaction glyphs must be unique and contain no whitespace')
const output = '/** Generated from emoji-catalog.ts by scripts/build-reaction-emoji.mjs. */\n' +
  `export const REACTION_GLYPHS = ${JSON.stringify(glyphs.join(' '))}\n`
if (process.argv.includes('--check')) {
  if (readFileSync(outputPath, 'utf8') !== output) throw new Error('Reaction glyphs are stale; run node scripts/build-reaction-emoji.mjs')
  console.log(`Verified ${glyphs.length} reaction glyphs.`)
} else {
  writeFileSync(outputPath, output)
  console.log(`Wrote ${glyphs.length} reaction glyphs.`)
}
