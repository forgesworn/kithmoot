import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = await readFile(resolve(root, 'src/face-mask-art.ts'), 'utf8')
const paths = [...source.matchAll(/fill: '([^']+)', d: '([^']+)'/g)].map(([, fill, d]) => ({ fill, d }))
if (paths.length !== 9) throw new Error('Expected the nine original mask paths')
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 240" width="200" height="240" role="img" aria-label="Original KithMoot privacy mask">\n${paths.map(p => `  <path fill="${p.fill}" d="${p.d}"/>`).join('\n')}\n</svg>\n`
await mkdir(resolve(root, 'art/face-mask'), { recursive: true })
await writeFile(resolve(root, 'art/face-mask/kithmoot-mask.svg'), svg)
if (process.argv[2]) {
  const target = resolve(process.argv[2], 'app/src/main/res/drawable/km_privacy_mask.xml')
  await writeFile(target, `<?xml version="1.0" encoding="utf-8"?>\n<!-- Original KithMoot artwork, MIT. Generated from kithmoot/src/face-mask-art.ts. -->\n<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="200dp" android:height="240dp" android:viewportWidth="200" android:viewportHeight="240">\n${paths.map(p => `  <path android:fillColor="${p.fill}" android:pathData="${p.d}"/>`).join('\n')}\n</vector>\n`)
}
