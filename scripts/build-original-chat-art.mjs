// Package original character stickers; retain reviewed Blender animation and legacy files.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const entries = [
  ['laugh', 'Laugh', 'laugh laughter lol funny tears', 'LOL'],
  ['facepalm', 'Facepalm', 'facepalm not again frustrated head wall', 'NOT AGAIN'],
  ['mindblown', 'Mind blown', 'mind blown shocked wow surprise', 'MIND. BLOWN.'],
  ['cool', 'Cool', 'cool sunglasses smug deal with it', 'DEAL WITH IT'],
  ['shrug', 'Shrug', 'shrug whatever dunno unsure', 'DUNNO'],
  ['celebrate', 'Celebrate', 'celebrate party yes victory confetti', 'YES!'],
  ['angry', 'Angry', 'angry furious rage fuming', 'FUMING'],
  ['love', 'Love', 'love heart hug thanks affection', 'BIG LOVE'],
  ['cry', 'Cry', 'cry sad tears sob upset', 'SEND HELP'],
  ['sideeye', 'Side eye', 'side eye unimpressed sceptical doubt', 'REALLY?'],
  ['popcorn', 'Popcorn', 'popcorn drama watching waiting', 'HERE FOR THE DRAMA'],
  ['micdrop', 'Mic drop', 'mic drop winner done nailed it', 'MIC DROP'],
  ['thumbsup', 'Thumbs up', 'thumbs up approve yes good thanks', 'NICE ONE'],
  ['thumbsdown', 'Thumbs down', 'thumbs down no dislike nope', 'NOPE'],
  ['slowclap', 'Slow clap', 'slow clap sarcastic applause brilliant', 'BRILLIANT'],
  ['eyeroll', 'Eye roll', 'eye roll bored annoyed unbelievable', 'OH PLEASE'],
  ['waiting', 'Waiting', 'waiting impatient time clock hurry', 'STILL WAITING'],
  ['exhausted', 'Exhausted', 'exhausted dead tired done sleepy', 'I AM DONE'],
  ['wtf', 'What', 'wtf what confused baffled huh', 'WTF'],
  ['melting', 'Melting', 'melting embarrassed cringe awkward', 'THIS IS FINE'],
  ['plotting', 'Plotting', 'plotting evil cheeky grin mischievous', 'HEH HEH'],
  ['moon', 'To the moon', 'moon rocket fly launch to the moon', 'TO THE MOON'],
  ['coffee', 'Coffee', 'coffee tired morning wake caffeine', 'COFFEE FIRST'],
  ['handshake', 'Handshake', 'handshake agree deal friends respect', 'DEAL'],
]
const donkeyEntries = [
  ['donkey-laugh', 'Donkey laugh', 'donkey thecryptodonkey laugh laughter lol snort funny', 'HA HA'],
  ['donkey-facepalm', 'Donkey facepalm', 'donkey thecryptodonkey facepalm embarrassed cringe side eye', 'OH DEAR'],
  ['donkey-bitcoin', 'Donkey Bitcoin', 'donkey thecryptodonkey bitcoin coin toss catch victory celebrate', 'NICE CATCH'],
]
const out = resolve(root, 'app/public/chat-art'); mkdirSync(out, { recursive: true })
const run = args => { const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' }); if (result.status) throw new Error('Artwork packaging failed') }
const COFFEE_SHA256 = '1ec70ce57a315e6dd13e8d451543eb529786a792f218121c9bfd67db718a61f1'
const COFFEE_PREVIEW_SHA256 = '3a8c5667927a3c47e9267285cb5a3d584c61918cef8df5328a7989987e1fe473'
const MAX_GIF_BYTES = 8 * 1024 * 1024
const args = process.argv.slice(2)
let coffeeExport = resolve(root, 'artwork/animation/coffee'), explicitExport = false, checkOnly = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--check') checkOnly = true
  else if (args[i] === '--coffee-export' && args[i + 1]) { coffeeExport = resolve(args[++i]); explicitExport = true }
  else throw new Error('Usage: node scripts/build-original-chat-art.mjs [--coffee-export /absolute/export-folder] [--check]')
}
const detail = file => { const bytes = readFileSync(file); return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }
const donkeyApproval = JSON.parse(readFileSync(resolve(root, 'artwork/animation/donkey/reviewed-assets.json'), 'utf8'))
for (const [slug] of donkeyEntries) for (const kind of ['png', 'gif']) {
  const file = resolve(out, `${slug}.${kind}`), approved = donkeyApproval[`${slug}.${kind}`]
  const actual = detail(file), bytes = readFileSync(file)
  if (!approved || actual.bytes !== approved.bytes || actual.sha256 !== approved.sha256) throw new Error(`Donkey artwork needs its reviewed export: ${slug}.${kind}`)
  if (kind === 'gif' && (!/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')) || bytes.length > MAX_GIF_BYTES || bytes.readUInt16LE(6) !== 512 || bytes.readUInt16LE(8) !== 512)) throw new Error(`Donkey GIF must be 512px and within eight mebibytes: ${slug}`)
  if (kind === 'png' && (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(16) !== 512 || bytes.readUInt32BE(20) !== 512)) throw new Error(`Donkey preview must be a 512px PNG: ${slug}`)
}
const exportedGif = resolve(coffeeExport, 'coffee.gif'), exportedPreview = resolve(coffeeExport, 'coffee-preview.png')
if (explicitExport && (!existsSync(exportedGif) || !existsSync(exportedPreview))) throw new Error('The Blender export needs coffee.gif and coffee-preview.png.')
const approvedGif = existsSync(exportedGif) ? exportedGif : resolve(out, 'coffee.gif')
const approvedPreview = existsSync(exportedPreview) ? exportedPreview : resolve(out, 'coffee-animation.png')
// Fail before changing assets: an old rotating/bouncing GIF must never replace this animation.
const gifBytes = readFileSync(approvedGif)
if (!/^GIF8[79]a$/.test(gifBytes.subarray(0, 6).toString('ascii')) || gifBytes.length > MAX_GIF_BYTES || gifBytes.length < 10 || gifBytes.readUInt16LE(6) !== 512 || gifBytes.readUInt16LE(8) !== 512 || detail(approvedGif).sha256 !== COFFEE_SHA256) throw new Error('Coffee must be the reviewed 512px Blender GIF, within the eight-mebibyte limit. Review a new export before updating its pinned hash.')
const previewBytes = readFileSync(approvedPreview)
if (previewBytes.length < 24 || !previewBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || previewBytes.readUInt32BE(16) !== 512 || previewBytes.readUInt32BE(20) !== 512 || detail(approvedPreview).sha256 !== COFFEE_PREVIEW_SHA256) throw new Error('Coffee needs its reviewed 512px Blender static preview.')
// Legacy files remain available for old messages, but are never regenerated or offered by the picker.
for (const [slug] of entries) if (slug !== 'coffee' && !existsSync(resolve(out, `${slug}.gif`))) throw new Error(`Missing preserved legacy GIF: ${slug}.gif`)
if (checkOnly) {
  const current = JSON.parse(readFileSync(resolve(out, 'catalogue.json'), 'utf8'))
  for (const [slug] of [...entries, ...donkeyEntries]) {
    const row = current.find(item => item.slug === slug)
    for (const kind of ['png', 'gif']) {
      const actual = detail(resolve(out, `${slug}.${kind}`))
      if (!row || row[kind]?.bytes !== actual.bytes || row[kind]?.sha256 !== actual.sha256) throw new Error(`Packaged ${slug}.${kind} does not match its metadata.`)
    }
    if (row.animated !== (slug === 'coffee' || slug.startsWith('donkey-')) || row.animationPreview !== (slug === 'coffee' ? 'coffee-animation.png' : `${slug}.png`)) throw new Error(`Animation availability or preview is incorrect: ${slug}`)
  }
  if (detail(resolve(out, 'coffee.gif')).sha256 !== COFFEE_SHA256 || detail(resolve(out, 'coffee-animation.png')).sha256 !== COFFEE_PREVIEW_SHA256) throw new Error('The packaged coffee animation and preview need to match the reviewed exports.')
  console.log('Verified 27 character stickers, 23 preserved legacy GIFs and four reviewed Blender animations.')
  process.exit(0)
}
if (approvedGif !== resolve(out, 'coffee.gif')) copyFileSync(approvedGif, resolve(out, 'coffee.gif'))
if (approvedPreview !== resolve(out, 'coffee-animation.png')) copyFileSync(approvedPreview, resolve(out, 'coffee-animation.png'))
const metadata = []
for (const [index, [slug, title, keywords, caption]] of entries.entries()) {
  const sheet = resolve(root, `app/src/assets/kithmoot-original/reactions-sheet-${index < 12 ? '01-cutout' : '02'}.png`)
  const cell = index % 12, png = resolve(out, `${slug}.png`), gif = resolve(out, `${slug}.gif`)
  run(['-i', sheet, '-vf', `crop=512:512:${cell % 4 * 512}:${Math.floor(cell / 4) * 512},scale=384:384`, '-frames:v', '1', png])
  metadata.push({ slug, title, keywords, caption, animated: slug === 'coffee', animationPreview: slug === 'coffee' ? 'coffee-animation.png' : `${slug}.png`, png: detail(png), gif: detail(gif) })
}
for (const [slug, title, keywords, caption] of donkeyEntries) metadata.push({ slug, title, keywords, caption, animated: true, animationPreview: `${slug}.png`, png: detail(resolve(out, `${slug}.png`)), gif: detail(resolve(out, `${slug}.gif`)) })
writeFileSync(resolve(out, 'catalogue.json'), JSON.stringify(metadata, null, 2) + '\n')
writeFileSync(resolve(root, 'app/src/original-art-data.ts'), '/** Generated from our bundled artwork; no remote catalogue. */\nexport const ORIGINAL_ART = ' + JSON.stringify(metadata, null, 2) + ' as const\n')
writeFileSync(resolve(root, 'src/original-art.ts'), `/** Original KithMoot artwork: local picker access needs no membership or network lookup. */\nexport const ORIGINAL_EMOJIS = ${JSON.stringify(entries.map(([slug, , words]) => [`:km_${slug}:`, words]), null, 2)} as const\nexport function isOriginalEmoji(value: unknown): boolean { return ORIGINAL_EMOJIS.some(([code]) => code === value) }\n`)
console.log(`Packaged ${metadata.length} original character stickers and four reviewed Blender GIFs; preserved 23 legacy GIFs for existing messages.`)
