// Bundle a reviewed local ForgeMoji snapshot; no artwork is fetched at runtime.
import { readFile, writeFile, copyFile, mkdir, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve, basename } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const source = args[0] === '--source' && args[1]?.startsWith('/') ? resolve(args[1]) : undefined
const native = args[2] === '--android' && args[3]?.startsWith('/') ? resolve(args[3]) : undefined
if (!source || args.length !== (native ? 4 : 2)) throw new Error('Usage: node scripts/sync-forgemoji.mjs --source /absolute/forgemoji [--android /absolute/native-checkout]')
if (native) await access(resolve(native, 'app/build.gradle.kts'))
const manifest = JSON.parse(await readFile(resolve(source, 'manifest.json'), 'utf8'))
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
if (execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim()) throw new Error('Commit the reviewed ForgeMoji snapshot before bundling it')
const definitions = manifest.definitions.map(item => ({ ...item, keywords: Array.isArray(item.keywords) ? item.keywords.join(' ') : item.keywords }))
const drawings = manifest.artwork
if (!Array.isArray(definitions) || !Array.isArray(drawings)) throw new Error('Missing ForgeMoji definitions or drawings')
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
const definitionsByEmoji = new Map(definitions.map(item => [item.emoji, item]))
if (definitionsByEmoji.size !== definitions.length) throw new Error('Duplicate emoji definitions')
for (const item of definitions) {
  const custom = item.kind === 'custom' && item.category === 'forgesworn' && /^:fs_[a-z0-9_]+:$/.test(item.emoji)
  if (!custom && Array.from(segmenter.segment(item.emoji)).length !== 1) throw new Error('Invalid ForgeMoji meaning')
}
const seen = new Set()
const verified = []
for (const item of drawings) {
  if (!/^png\/[a-z0-9-]+\.png$/.test(item.file) || !definitionsByEmoji.has(item.baseEmoji) || seen.has(item.emoji) || (Array.from(segmenter.segment(item.emoji)).length !== 1 && !(definitionsByEmoji.get(item.baseEmoji)?.kind === 'custom' && item.emoji === item.baseEmoji))) throw new Error('Invalid ForgeMoji drawing')
  const bytes = await readFile(resolve(source, item.file))
  if (bytes.length !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error(`Invalid artwork bytes: ${item.file}`)
  seen.add(item.emoji); verified.push({ item, bytes })
}
for (const item of definitions) if (!seen.has(item.emoji)) throw new Error(`Missing default artwork: ${item.emoji}`)
const out = resolve(root, 'app/public/emoji'); await mkdir(out, { recursive: true })
for (const { item, bytes } of verified) await writeFile(resolve(out, basename(item.file)), bytes)
const provenance = { repository: 'https://github.com/forgesworn/forgemoji', revision, version: manifest.version, creator: manifest.creator, model: manifest.model, license: manifest.license }
await writeFile(resolve(out, 'manifest.json'), JSON.stringify({ source: provenance, definitions, artwork: drawings }, null, 2) + '\n')
await copyFile(resolve(source, 'LICENSE'), resolve(out, 'LICENSE'))
await writeFile(resolve(root, 'src/familiar-art-data.ts'), `/** Generated from the pinned ForgeMoji artwork snapshot. */\nexport const FORGEMOJI_SOURCE = ${JSON.stringify(provenance)} as const\nexport const FAMILIAR_ART = ${JSON.stringify(definitions, null, 2)} as const\nexport const FAMILIAR_DRAWINGS = ${JSON.stringify(drawings.map(item => ({ emoji: item.emoji, file: basename(item.file) })), null, 2)} as const\n`)
if (native) {
  const drawables = resolve(native, 'app/src/main/res/drawable-nodpi'); await mkdir(drawables, { recursive: true })
  const id = item => 'fm_' + basename(item.file, '.png').replaceAll('-', '_')
  for (const { item, bytes } of verified) await writeFile(resolve(drawables, `${id(item)}.png`), bytes)
  const quote = value => JSON.stringify(value).replaceAll('$', '\\$')
  await writeFile(resolve(native, 'app/src/main/kotlin/dev/forgesworn/kithmoot/session/FamiliarArt.kt'), `package dev.forgesworn.kithmoot.session\n\n/** ForgeMoji ${manifest.version}, by TheCryptoDonkey; pinned source ${revision}. */\ndata class FamiliarArt(val emoji: String, val slug: String, val keywords: String, val toneable: Boolean, val title: String = slug.replace('-', ' '), val category: String = "faces")\nval FAMILIAR_ART = listOf(\n${definitions.map(item => `    FamiliarArt(${quote(item.emoji)}, ${quote(item.slug)}, ${quote(item.keywords)}, ${item.toneable}, ${quote(item.title)}, ${quote(item.category)}),`).join('\n')}\n)\nval HUMAN_SKIN_TONES = listOf("", "🏻", "🏼", "🏽", "🏾", "🏿")\nfun withSkinTone(emoji: String, tone: Int): String {\n    require(tone in HUMAN_SKIN_TONES.indices)\n    return if (tone == 0 || FAMILIAR_ART.none { it.emoji == emoji && it.toneable }) emoji else emoji.replace("\\uFE0F", "") + HUMAN_SKIN_TONES[tone]\n}\n`)
  const maps = drawings.map(item => `    ${quote(item.emoji.replaceAll('\uFE0F', ''))} to R.drawable.${id(item)},`).join('\n')
  await writeFile(resolve(native, 'app/src/main/kotlin/dev/forgesworn/kithmoot/ui/room/FamiliarArtwork.kt'), `package dev.forgesworn.kithmoot.ui.room\n\nimport dev.forgesworn.kithmoot.R\n\nprivate val familiarDrawings = mapOf(\n${maps}\n)\nfun familiarArtworkDrawable(emoji: String): Int? = familiarDrawings[emoji.replace("\\uFE0F", "")]\n`)
  const licences = resolve(native, 'app/src/main/assets/emoji'); await mkdir(licences, { recursive: true })
  await copyFile(resolve(out, 'manifest.json'), resolve(licences, 'manifest.json')); await copyFile(resolve(source, 'LICENSE'), resolve(licences, 'LICENSE'))
}
console.log(`Bundled ${definitions.length} ForgeMoji meanings and ${drawings.length} drawings from ${revision}${native ? ' for web and native Android' : ''}.`)
