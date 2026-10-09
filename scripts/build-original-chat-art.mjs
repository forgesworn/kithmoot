// Package Sunburst's original sprite sheets as local stickers and real looping GIFs.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from '@playwright/test'
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
const out = resolve(root, 'app/public/chat-art'); mkdirSync(out, { recursive: true })
const run = args => { const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' }); if (result.status) throw new Error('Artwork packaging failed') }
const metadata = []
const captionDir = mkdtempSync(resolve(tmpdir(), 'kithmoot-art-captions-'))
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
try {
for (const [index, [slug, title, keywords, caption]] of entries.entries()) {
  const sheet = resolve(root, `app/src/assets/kithmoot-original/reactions-sheet-${index < 12 ? '01-cutout' : '02'}.png`)
  const cell = index % 12, png = resolve(out, `${slug}.png`), gif = resolve(out, `${slug}.gif`)
  run(['-i', sheet, '-vf', `crop=512:512:${cell % 4 * 512}:${Math.floor(cell / 4) * 512},scale=384:384`, '-frames:v', '1', png])
  // A gentle repeated turn/bounce animates the original pose; the caption makes
  // the shared file a self-contained reaction meme rather than a linked image.
  const captionPng = resolve(captionDir, slug + '.png')
  const encoded = await page.evaluate(({ caption }) => {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 108
    const ctx = canvas.getContext('2d'); ctx.font = `bold ${caption.length > 14 ? 30 : 42}px Arial`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'; ctx.lineWidth = 6; ctx.strokeStyle = '#172c32'; ctx.fillStyle = 'white'; ctx.strokeText(caption, 256, 55); ctx.fillText(caption, 256, 55)
    return canvas.toDataURL('image/png').split(',')[1]
  }, { caption })
  writeFileSync(captionPng, Buffer.from(encoded, 'base64'))
  const filter = `[0:v]scale=384:384,rotate=0.035*sin(2*PI*t*2):c=none[sticker];color=c=black@0:s=512x512:r=12:d=1.5,format=rgba[canvas];[canvas][sticker]overlay=x=64:y='24+8*sin(2*PI*t*2)':shortest=1[frame];[frame][1:v]overlay=x=0:y=404,scale=256:256,split[a][b];[a]palettegen=max_colors=96:reserve_transparent=1[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:alpha_threshold=128`
  run(['-loop', '1', '-framerate', '12', '-i', png, '-i', captionPng, '-filter_complex', filter, '-t', '1.5', '-loop', '0', gif])
  const detail = file => { const bytes = readFileSync(file); return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }
  metadata.push({ slug, title, keywords, caption, png: detail(png), gif: detail(gif) })
}
} finally { await browser.close(); rmSync(captionDir, { recursive: true, force: true }) }
writeFileSync(resolve(out, 'catalogue.json'), JSON.stringify(metadata, null, 2) + '\n')
writeFileSync(resolve(root, 'app/src/original-art-data.ts'), '/** Generated from our bundled artwork; no remote catalogue. */\nexport const ORIGINAL_ART = ' + JSON.stringify(metadata, null, 2) + ' as const\n')
writeFileSync(resolve(root, 'src/original-art.ts'), `/** Original KithMoot artwork: local picker access needs no membership or network lookup. */\nexport const ORIGINAL_EMOJIS = ${JSON.stringify(entries.map(([slug, , words]) => [`:km_${slug}:`, words]), null, 2)} as const\nexport function isOriginalEmoji(value: unknown): boolean { return ORIGINAL_EMOJIS.some(([code]) => code === value) }\n`)
console.log(`Packaged ${metadata.length} original stickers and ${metadata.length} animated reaction GIFs.`)
