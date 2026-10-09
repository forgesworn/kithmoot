// Explicitly copy the reviewed artwork from this checkout into a separate native checkout.
import { readFile, writeFile, copyFile, mkdir, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
if (process.argv[2] !== '--android' || !process.argv[3]?.startsWith('/')) throw new Error('Usage: node scripts/sync-original-chat-art.mjs --android /absolute/native-checkout')
const native = resolve(process.argv[3]); await access(resolve(native, 'app/build.gradle.kts'))
const source = resolve(root, 'app/public/chat-art'), data = JSON.parse(await readFile(resolve(source, 'catalogue.json'), 'utf8'))
if (!Array.isArray(data) || !data.length) throw new Error('An artwork catalogue is required')
const copies = new Set(), slugs = new Set(), drawableIds = new Set()
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
// Validate the entire input before changing the selected Android checkout.
for (const item of data) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.slug) || slugs.has(item.slug)) throw new Error('Unsafe or duplicate artwork slug')
  slugs.add(item.slug)
  const drawable = item.slug.replaceAll('-', '_')
  if (drawableIds.has(drawable)) throw new Error('Artwork drawable identifiers collide')
  drawableIds.add(drawable)
  if (['title', 'keywords', 'caption'].some(field => typeof item[field] !== 'string') || typeof item.animated !== 'boolean') throw new Error(`Invalid artwork metadata: ${item.slug}`)
  if (typeof item.animationPreview !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}\.png$/.test(item.animationPreview)) throw new Error(`Unsafe animation preview: ${item.slug}`)
  for (const kind of ['png', 'gif']) {
    const metadata = item[kind], filename = `${item.slug}.${kind}`
    const bytes = await readFile(resolve(source, filename))
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (!Number.isSafeInteger(metadata?.bytes) || metadata.bytes < 1 || metadata.bytes !== bytes.length || metadata.sha256 !== hash) throw new Error(`Artwork bytes/hash mismatch: ${filename}`)
    if (kind === 'png' ? !bytes.subarray(0, 8).equals(pngSignature) : !/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) throw new Error(`Artwork format mismatch: ${filename}`)
    copies.add(filename)
  }
  const preview = await readFile(resolve(source, item.animationPreview))
  if (!preview.subarray(0, 8).equals(pngSignature)) throw new Error(`Invalid PNG preview: ${item.slug}`)
  copies.add(item.animationPreview)
}
const assets = resolve(native, 'app/src/main/assets/chat-art'), drawables = resolve(native, 'app/src/main/res/drawable-nodpi')
await mkdir(assets, { recursive: true }); await mkdir(drawables, { recursive: true })
// Keep legacy files: hiding an old animation from the picker does not delete it.
for (const filename of copies) await copyFile(resolve(source, filename), resolve(assets, filename))
for (const item of data) await copyFile(resolve(source, `${item.slug}.png`), resolve(drawables, `km_${item.slug.replaceAll('-', '_')}.png`))
await copyFile(resolve(source, 'catalogue.json'), resolve(assets, 'catalogue.json'))
const kotlinString = value => JSON.stringify(value).replaceAll('$', '\\$')
const rows = data.map(item => `    OriginalArt(${[item.slug, item.title, item.keywords + ' ' + item.caption.toLowerCase()].map(kotlinString).join(', ')}, ${item.png.bytes}L, ${item.gif.bytes}L, ${kotlinString(item.png.sha256)}, ${kotlinString(item.gif.sha256)}, ${item.animated}, ${kotlinString(item.animationPreview)}),`).join('\n')
await writeFile(resolve(native, 'app/src/main/kotlin/dev/forgesworn/kithmoot/session/OriginalArt.kt'), `package dev.forgesworn.kithmoot.session\n\n/** Generated from the reviewed artwork and exact hashes in assets/chat-art/catalogue.json. */\ndata class OriginalArt(val slug: String, val title: String, val keywords: String, val pngBytes: Long, val gifBytes: Long, val pngSha256: String, val gifSha256: String, val animated: Boolean, val animationPreview: String)\nval ORIGINAL_ART = listOf(\n${rows}\n)\nval ORIGINAL_EMOJIS = ORIGINAL_ART.filter { !it.slug.startsWith("donkey-") }.map { ":km_\${it.slug}:" to it.keywords }\nfun isOriginalEmoji(value: String): Boolean = ORIGINAL_EMOJIS.any { it.first == value }\n`)
await writeFile(resolve(native, 'app/src/main/kotlin/dev/forgesworn/kithmoot/ui/room/OriginalArtwork.kt'), `package dev.forgesworn.kithmoot.ui.room\n\nimport dev.forgesworn.kithmoot.R\n\nfun originalArtworkDrawable(slug: String): Int = when (slug) {\n${data.map(item => `    ${kotlinString(item.slug)} -> R.drawable.km_${item.slug.replaceAll('-', '_')}`).join('\n')}\n    else -> error("Unknown original artwork")\n}\n`)
console.log(`Copied ${data.length} original stickers, ${data.filter(item => item.animated).length} picker GIFs and all legacy GIFs to the selected Android checkout.`)
