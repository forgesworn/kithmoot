// Explicitly copy the same original artwork into the separate native checkout.
import { readFile, writeFile, copyFile, mkdir, access } from 'node:fs/promises'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
if (process.argv[2] !== '--android' || !process.argv[3]?.startsWith('/')) throw new Error('Usage: node scripts/sync-original-chat-art.mjs --android /absolute/native-checkout')
const native = resolve(process.argv[3]); await access(resolve(native, 'app/build.gradle.kts'))
const source = resolve(root, 'app/public/chat-art'), data = JSON.parse(await readFile(resolve(source, 'catalogue.json'), 'utf8'))
const assets = resolve(native, 'app/src/main/assets/chat-art'), drawables = resolve(native, 'app/src/main/res/drawable-nodpi')
await mkdir(assets, { recursive: true }); await mkdir(drawables, { recursive: true })
for (const item of data) {
  if (!/^[a-z]+$/.test(item.slug)) throw new Error('Unsafe artwork slug')
  for (const kind of ['png', 'gif']) await copyFile(resolve(source, `${item.slug}.${kind}`), resolve(assets, `${item.slug}.${kind}`))
  await copyFile(resolve(source, `${item.slug}.png`), resolve(drawables, `km_${item.slug}.png`))
}
await copyFile(resolve(source, 'catalogue.json'), resolve(assets, 'catalogue.json'))
const kotlinString = value => JSON.stringify(value).replaceAll('$', '\\$')
const rows = data.map(item => `    OriginalArt(${[item.slug, item.title, item.keywords + ' ' + item.caption.toLowerCase()].map(kotlinString).join(', ')}, ${item.png.bytes}L, ${item.gif.bytes}L),`).join('\n')
await writeFile(resolve(native, 'app/src/main/kotlin/dev/forgesworn/kithmoot/session/OriginalArt.kt'), `package dev.forgesworn.kithmoot.session\n\n/** Generated from the original artwork bundled with KithMoot. */\ndata class OriginalArt(val slug: String, val title: String, val keywords: String, val pngBytes: Long, val gifBytes: Long)\nval ORIGINAL_ART = listOf(\n${rows}\n)\nval ORIGINAL_EMOJIS = ORIGINAL_ART.map { ":km_\${it.slug}:" to it.keywords }\nfun isOriginalEmoji(value: String): Boolean = ORIGINAL_EMOJIS.any { it.first == value }\n`)
await writeFile(resolve(native, 'app/src/main/kotlin/dev/forgesworn/kithmoot/ui/room/OriginalArtwork.kt'), `package dev.forgesworn.kithmoot.ui.room\n\nimport dev.forgesworn.kithmoot.R\n\nfun originalArtworkDrawable(slug: String): Int = when (slug) {\n${data.map(item => `    ${kotlinString(item.slug)} -> R.drawable.km_${item.slug}`).join('\n')}\n    else -> error("Unknown original artwork")\n}\n`)
console.log(`Copied ${data.length} original stickers and GIFs to the selected Android checkout.`)
